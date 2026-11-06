import CSSPropertyManager from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import {normalizeTextWrapping, normalizeTextDecorationStyle, textWrappingProperty} from '../style/css-text-values.js';

const set = CSSPropertyManager.prototype.set;
CSSPropertyManager.prototype.set = function(name, value, important) {
  name = textWrappingProperty(name);
  let normalized = value === null ? undefined : normalizeTextWrapping(name, value);
  if (normalized === undefined && value !== null) normalized = normalizeTextDecorationStyle(name, value);
  if (normalized === null) return [];
  return set.call(this, name, normalized === undefined ? value : normalized, important);
};
for (const method of ['get', 'remove']) {
  const original = CSSPropertyManager.prototype[method];
  CSSPropertyManager.prototype[method] = function(name, ...args) {
    return original.call(this, textWrappingProperty(name), ...args);
  };
}
