import CSSPropertyManager from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import {declarationValueSyntax} from '../style/supports-condition.js';

const set = CSSPropertyManager.prototype.set;
CSSPropertyManager.prototype.set = function(name, value, important) {
  if (name === 'z-index' && value !== null) {
    const text = String(value).trim();
    const syntax = declarationValueSyntax(text);
    if (!syntax) return [];
    const keyword = /^(auto|initial|inherit|unset|revert|revert-layer)$/i.test(text);
    const integer = /^[+-]?\d+$/.test(text);
    // Leave substitution and math to their existing processing paths. This
    // adapter validates literal values, not the full CSS numeric type system.
    const deferred = syntax.variables || /^(?:calc|min|max|clamp|round|mod|rem|abs|sign)\(/i.test(text);
    if (!keyword && !integer && !deferred) return [];
    value = keyword ? text.toLowerCase() : text;
  }
  return set.call(this, name, value, important);
};
