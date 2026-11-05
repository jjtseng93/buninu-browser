import CSSPropertySetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertySetParser.ts';
import {normalizeFlexFactor} from '../style/flex-factor-values.js';

// The vendor's generic float parser rejects exponent notation, accepts "1."
// and rounds tiny ratios to zero. Replace only the two flex-factor parsers;
// flex shorthand expansion calls these same methods as the longhand setters.
for (const [method, property] of [['getFlexGrow', 'flex-grow'], ['getFlexShrink', 'flex-shrink']]) {
  CSSPropertySetParser[method] = function(value, important) {
    const normalized = normalizeFlexFactor(property, value);
    return normalized === null ? null : {[property]: {value: normalized, important}};
  };
}
