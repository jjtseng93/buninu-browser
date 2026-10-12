// Preserve CDP's virtual key codes; infer them for the direct press API too.
const codes = { Backspace:8, Tab:9, Enter:13, Shift:16, Control:17, Alt:18,
  Escape:27, ' ':32, Space:32, PageUp:33, PageDown:34, End:35, Home:36,
  ArrowLeft:37, ArrowUp:38, ArrowRight:39, ArrowDown:40, Insert:45, Delete:46 };
export function keyboardInput(key, options = {}) {
  key = String(key);
  const code = String(options.code ?? '');
  const inferred = codes[key] ?? codes[code]
    ?? (/^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0);
  const keyCode = Number(options.windowsVirtualKeyCode ?? options.keyCode ?? inferred) || 0;
  return { key, code, keyCode, which:keyCode, charCode:0, composed:true };
}
