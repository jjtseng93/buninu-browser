import CSSPropertyManager from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import CSSPropertySetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertySetParser.ts';
import {normalizeSizingValue} from '../style/sizing-values.js';

for(const [method,name] of [['getWidth','width'],['getHeight','height']]) {
  CSSPropertySetParser[method]=function(value,important) {
    const normalized=normalizeSizingValue(name,value);
    return normalized===null?null:{[name]:{value:normalized,important}};
  };
}
const set=CSSPropertyManager.prototype.set;
CSSPropertyManager.prototype.set=function(name,value,important) {
  const normalized=value===null?undefined:normalizeSizingValue(name,value);
  if(normalized===null)return [];
  return set.call(this,normalized===undefined?name:name.toLowerCase(),normalized===undefined?value:normalized,important);
};
