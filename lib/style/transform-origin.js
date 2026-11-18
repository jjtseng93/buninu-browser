import {backgroundPositionAxes} from './background-values.js';
import {parseCSSComponentValues} from './css-value-tokens.js';

const wide = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
const percent = Object.freeze({unit: '%', value: 50});
export const initialTransformOrigin = Object.freeze([percent, percent, 0]);

export function normalizeTransformOrigin(value, allowPending = true) {
  const parsed = parseCSSComponentValues(value);
  if (!parsed) return null;
  if (parsed.pending) return allowPending ? value : null;
  const tokens = parsed.tokens;
  if (tokens.length === 1 && tokens[0].kind === 'ident' && wide.has(tokens[0].value.toLowerCase()))
    return tokens[0].value.toLowerCase();
  if (!tokens.length || tokens.length > 3) return null;
  const axes = backgroundPositionAxes(tokens.slice(0, 2));
  if (!axes) return null;
  if (tokens.length === 3) {
    const z = tokens[2];
    const hasPercentage = t => t.unit === '%' || t.args?.some(hasPercentage);
    if (z.kind === 'ident' || hasPercentage(z)) return null;
    const depth = backgroundPositionAxes([z]);
    if (!depth) return null;
    axes.push(depth[0]);
  }
  return axes.join(' ');
}
