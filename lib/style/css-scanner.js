import {Buffer} from "node:buffer";

// Built with wat2wasm css-scanner.wat. Embed the small module so sandboxed
// renderers can instantiate it without opening a file.
const encodedModule = "AGFzbQEAAAABCAFgA39/fwF/AwIBAAUFAQEBgAEHEQIGbWVtb3J5AgAEc2NhbgAACv4CAfsCAgd/AXsCQANAIAAgAU8NASAAQQF0IQMgA/0ABAAgA/0ABBD9ZiEKIApBIv0P/SMgCkEn/Q/9I/1QIApB3AD9D/0jIApB+wD9D/0jIApB/QD9D/0j/VD9UP1Q/WQhBCACBEAgBCAKQSj9D/0jIApBKf0P/SMgCkE7/Q/9I/1Q/VD9ZHIhBAsCQANAIARFDQEgACAEaGohBSAEIARBAWtxIQQgBSABTw0DIAUgCUkNACAFQQF0LwEAIQYgBkHcAEYEQCAFQQJqIQkMAQsgCARAIAYgCEYEQEEAIQgLDAELIAZBIkYgBkEnRnIEQCAGIQgMAQsgAkUEQCAGQfsARgRAIAdBAWohBwUgB0EBayEHIAdFBEAgBQ8LCwUgBkEoRgRAIAdBAWohBwwCCyAGQSlGBEAgBwRAIAdBAWshBwsMAgsgBiACRiAHRXEEQCAFDwsgBkH7AE8EQCAFQX8gBiACRhsPCwsMAAsLIABBEGohAAwACwtBfyABIAIbCw==";
const PAGE_BYTES = 65536;
const MIN_SIMD_LENGTH = 64 * 1024;
const MAX_SIMD_BYTES = 128 * PAGE_BYTES; // Matches the Wasm memory maximum.
const PADDING_BYTES = 32; // Two unaligned v128 loads in the final iteration.

let kernel;
let inUse = false;

function prepareKernel(css) {
  if (kernel === undefined) {
    try {
      const module = new WebAssembly.Module(Buffer.from(encodedModule, "base64"));
      kernel = new WebAssembly.Instance(module).exports;
    } catch {
      kernel = null;
    }
  }
  if (!kernel) return false;
  const byteLength = css.length * 2;
  const extra = byteLength + PADDING_BYTES - kernel.memory.buffer.byteLength;
  try {
    if (extra > 0) kernel.memory.grow(Math.ceil(extra / PAGE_BYTES));
    return Buffer.from(kernel.memory.buffer).write(css, 0, byteLength, "utf16le") === byteLength;
  } catch {
    return false;
  }
}

const vector = {
  findTopLevel(source, character, start, end) {
    // The vector delimiter mask covers the two targets used by the parsers.
    if (character !== "{" && character !== ";") return findTopLevel(source, character, start, end);
    return kernel.scan(start, end, character.charCodeAt(0));
  },
  matchingBrace(_source, open, end) {
    return kernel.scan(open, end, 0);
  },
};
const scalar = {findTopLevel, matchingBrace};

/**
 * Keep the current sheet in Wasm memory across all synchronous visits. A
 * viewport getter or CSSOM operation may parse another sheet before the
 * outer parse finishes. It uses the scalar scanner and leaves the buffer intact.
 */
export function scanStyleSheet(css, visit) {
  if (inUse || css.length < MIN_SIMD_LENGTH || css.length * 2 + PADDING_BYTES > MAX_SIMD_BYTES)
    return visit(scalar, 0, css.length);
  inUse = true;
  try {
    return visit(prepareKernel(css) ? vector : scalar, 0, css.length);
  } finally {
    inUse = false;
  }
}

// Character codes for the scanners below, which run over whole style sheets.
const QUOTE = 0x22, APOSTROPHE = 0x27, BACKSLASH = 0x5c, OPEN_PAREN = 0x28, CLOSE_PAREN = 0x29, OPEN_BRACE = 0x7b, CLOSE_BRACE = 0x7d;

function findTopLevel(source, character, start, end) {
  const target = character.charCodeAt(0);
  let quote = 0;
  let depth = 0;
  for (let index = start; index < end; index++) {
    const current = source.charCodeAt(index);
    if (quote) {
      if (current === BACKSLASH) index++;
      else if (current === quote) quote = 0;
    } else if (current === BACKSLASH) index++;
    else if (current === QUOTE || current === APOSTROPHE) quote = current;
    else if (current === OPEN_PAREN) depth++;
    else if (current === CLOSE_PAREN) depth = Math.max(0, depth - 1);
    else if (current === target && depth === 0) return index;
    else if (current === OPEN_BRACE || current === CLOSE_BRACE) return target === current ? index : -1;
  }
  return -1;
}

function matchingBrace(source, open, end) {
  let depth = 0;
  let quote = 0;
  for (let index = open; index < end; index++) {
    const current = source.charCodeAt(index);
    if (quote) {
      if (current === BACKSLASH) index++;
      else if (current === quote) quote = 0;
    } else if (current === BACKSLASH) index++;
    else if (current === QUOTE || current === APOSTROPHE) quote = current;
    else if (current === OPEN_BRACE) depth++;
    else if (current === CLOSE_BRACE && --depth === 0) return index;
  }
  return end;
}
