import {normalizeTransformOrigin} from '../style/transform-origin.js';
import {normalizeAccentColor} from '../style/border-values.js';
import CSSPropertyList from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/CSSPropertyList.ts';
import CSSPropertyManager from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import {normalizeLayoutKeyword} from '../style/css-layout-keywords.js';

// These names are the CSS properties themselves, including their prefix.
for (const [css, idl] of [['-webkit-line-clamp', 'webkitLineClamp'], ['-webkit-box-orient', 'webkitBoxOrient']]) {
  CSSPropertyList.kebabCase[css] = idl;
  CSSPropertyList.camelCase[idl] = css;
}

const set = CSSPropertyManager.prototype.set;
CSSPropertyManager.prototype.set = function(name, value, important) {
  if (name === 'transform-origin' && value !== null) {
    value = normalizeTransformOrigin(value);
    if (value === null) return [];
  }
  if (name === 'accent-color' && value !== null) {
    value = normalizeAccentColor(value);
    if (value === null) return [];
  }
  const normalized = value === null ? undefined : normalizeLayoutKeyword(name, value);
  if (normalized === null) return [];
  return set.call(this, normalized === undefined ? name : name.toLowerCase(), normalized === undefined ? value : normalized, important);
};
