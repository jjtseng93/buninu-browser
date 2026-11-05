import CSSPropertyManager from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import {normalizeBoxShadow} from '../style/box-shadow-values.js';

const set = CSSPropertyManager.prototype.set;
CSSPropertyManager.prototype.set = function(name, value, important) {
  const normalized = value === null ? undefined : normalizeBoxShadow(name, value);
  if (normalized === null) return [];
  return set.call(this, normalized === undefined ? name : 'box-shadow',
    normalized === undefined ? value : normalized, important);
};
