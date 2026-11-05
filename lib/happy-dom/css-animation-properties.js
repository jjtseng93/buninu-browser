import CSSPropertyManager from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import { normalizeAnimationEnum } from '../style/animation-enum-values.js';

const set = CSSPropertyManager.prototype.set;
CSSPropertyManager.prototype.set = function(name, value, important) {
  const normalized = normalizeAnimationEnum(name, value);
  if (normalized === null) return [];
  return set.call(this, name, normalized === undefined ? value : normalized, important);
};
