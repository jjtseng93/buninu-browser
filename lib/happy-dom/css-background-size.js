import CSSPropertyManager from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import CSSPropertySetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertySetParser.ts';
import {normalizeBackgroundSize} from '../style/background-size-values.js';

// Shorthand expansion and direct longhand assignment share the same grammar.
CSSPropertySetParser.getBackgroundSize=function(value,important) {
  const normalized=normalizeBackgroundSize('background-size',value);
  return normalized===null?null:{'background-size':{value:normalized,important}};
};
const set=CSSPropertyManager.prototype.set;
CSSPropertyManager.prototype.set=function(name,value,important) {
  const normalized=value===null?undefined:normalizeBackgroundSize(name,value);
  if(normalized===null)return [];
  return set.call(this,normalized===undefined?name:name.toLowerCase(),normalized===undefined?value:normalized,important);
};
