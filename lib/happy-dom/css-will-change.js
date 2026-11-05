import CSSPropertyManager from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import {normalizeWillChange} from '../style/will-change.js';
const set=CSSPropertyManager.prototype.set;
CSSPropertyManager.prototype.set=function(name,value,important) {
  const normalized=value===null?undefined:normalizeWillChange(name,value);
  if(normalized===null)return [];
  return set.call(this,normalized===undefined?name:name.toLowerCase(),normalized===undefined?value:normalized,important);
};
