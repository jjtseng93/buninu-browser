import {parseCSSComponentValues} from './css-value-tokens.js';

const functions = new Set(['brightness','contrast','opacity','invert','grayscale','saturate','sepia']);
const limited = new Set(['opacity','invert','grayscale','sepia']);
const wide = new Set(['none','initial','inherit','unset','revert','revert-layer']);
export function parseColorFilter(text, computed = false, allowPending = true) {
  const parsed = parseCSSComponentValues(text);
  if (!parsed || !parsed.tokens.length) return null;
  if (parsed.pending) return allowPending ? text : null;
  if (parsed.tokens.length === 1 && parsed.tokens[0].kind === 'ident') {
    const word = parsed.tokens[0].value.toLowerCase();
    return wide.has(word) ? word : null;
  }
  const result = [];
  for (const token of parsed.tokens) {
    if (token.kind !== 'function' || !functions.has(token.name) || token.args.length > 1) return null;
    const arg = token.args[0], percent = arg?.unit === '%';
    if (arg && !(arg.kind === 'number' || arg.kind === 'dimension' && percent)) return null;
    let amount = arg ? Number(arg.value) : 1;
    if (!Number.isFinite(amount) || amount < 0) return null;
    if (limited.has(token.name)) amount = Math.min(amount, percent ? 100 : 1);
    const value = computed ? amount / (percent ? 100 : 1) : arg ? amount + (percent ? '%' : '') : '';
    result.push(token.name + '(' + value + ')');
  }
  return result.join(' ');
}

// CanvasKit color matrix translations and color channels are normalized to 0..1.
export function filterMatrix(name, v) {
  const matrix = [1,0,0,0,0, 0,1,0,0,0, 0,0,1,0,0, 0,0,0,1,0];
  if (name === 'opacity') matrix[18] = v;
  else if (name === 'brightness' || name === 'contrast' || name === 'invert') {
    for (let row = 0; row < 3; row++) {
      matrix[row*6] = name === 'invert' ? 1-2*v : v;
      matrix[row*5+4] = name === 'contrast' ? (1-v)/2 : name === 'invert' ? v : 0;
    }
  } else {
    const weights = name === 'sepia' ? [.393,.769,.189,.349,.686,.168,.272,.534,.131]
      : name === 'saturate' ? [.213,.715,.072,.213,.715,.072,.213,.715,.072]
      : [.2126,.7152,.0722,.2126,.7152,.0722,.2126,.7152,.0722];
    const mix = name === 'saturate' ? 1-v : v;
    for (let row=0;row<3;row++) for (let col=0;col<3;col++)
      matrix[row*5+col] = (row===col ? 1-mix : 0) + mix*weights[row*3+col];
  }
  return matrix;
}
