import {normalizeTableValue, computedTableSpacing} from './table-values.js';
import {absoluteCSSNumericValue} from './animation-numeric-values.js';
import {parseCSSComponentValues} from './css-value-tokens.js';

const functions = new Set(['brightness','contrast','opacity','invert','grayscale','saturate','sepia','hue-rotate','blur']);
const limited = new Set(['opacity','invert','grayscale','sepia']);
const wide = new Set(['none','initial','inherit','unset','revert','revert-layer']);
export function parseColorFilter(text, computed = false, allowPending = true, resolveLength) {
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
    if (token.name === 'blur') {
      let value = computed ? '0px' : '';
      if (arg) {
        const text = arg.source ?? (arg.value + (arg.unit ?? ''));
        value = normalizeTableValue('border-spacing', text, false);
        if (value == null || arg.kind === 'ident') return null;
        if (computed) {
          const length = computedTableSpacing(value, resolveLength)?.[0];
          if (!Number.isFinite(length)) return null;
          value = length + 'px';
        }
      }
      result.push('blur(' + value + ')');
      continue;
    }
    if (token.name === 'hue-rotate') {
      let value = computed ? '0deg' : '';
      if (arg) {
        const angle = absoluteCSSNumericValue(arg);
        const dimensions = Object.entries(angle?.type ?? {}).filter(([, exponent])=>exponent !== 0);
        const zero = arg.kind === 'number' && Number(arg.value) === 0;
        if (!zero && !(dimensions.length === 1 && dimensions[0][0] === 'angle' && dimensions[0][1] === 1)) return null;
        if (!Number.isFinite(angle?.value)) return null;
        value = computed || zero ? angle.value + 'deg' : arg.kind === 'function'
          ? 'calc(' + angle.value + 'deg)' : Number(arg.value) + arg.unit.toLowerCase();
      }
      result.push('hue-rotate(' + value + ')');
      continue;
    }
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
  else if (name === 'hue-rotate') {
    const radians = (v % 360) * Math.PI / 180;
    const c = Math.cos(radians), s = Math.sin(radians);
    const luminance = [.213,.715,.072];
    const sine = [-.213,-.715,.928,.143,.140,-.283,-.787,.715,.072];
    for (let row=0;row<3;row++) for (let col=0;col<3;col++)
      matrix[row*5+col] = luminance[col]*(1-c) + (row===col ? c : 0) + sine[row*3+col]*s;
  }
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
