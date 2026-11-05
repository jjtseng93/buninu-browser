import CSSPropertyManager from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import {normalizeOpacity} from '../style/opacity-values.js';

const set = CSSPropertyManager.prototype.set;
CSSPropertyManager.prototype.set = function(name, value, important) {
  const normalized = value === null ? undefined : normalizeOpacity(name, value);
  if (normalized === null) return [];
  return set.call(this, normalized === undefined ? name : 'opacity', normalized === undefined ? value : normalized, important);
};
