import CSSPropertySetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertySetParser.ts';
import {normalizeBackgroundSize} from '../style/background-size-values.js';

// Shorthand expansion and direct longhand assignment share the same grammar.
CSSPropertySetParser.getBackgroundSize=function(value,important) {
  const normalized=normalizeBackgroundSize('background-size',value);
  return normalized===null?null:{'background-size':{value:normalized,important}};
};
// The shared background expansion in css-border-pending validates direct
// assignments too. Do not wrap manager.set again: its internal pending
// shorthand records are objects, not CSS strings to normalize a second time.
