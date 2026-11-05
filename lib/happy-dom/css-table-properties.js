import CSSPropertyManager from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import CSSPropertySetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertySetParser.ts';
import {normalizeTableValue} from '../style/table-values.js';

// The vendor enum parser only recognizes a narrow spelling of var(). The
// shared tokenizer has already validated all pending substitutions, including
// escaped/Unicode custom property names and case-insensitive function names.
CSSPropertySetParser.getBorderCollapse=function(value,important) {
  const normalized=normalizeTableValue('border-collapse',value);
  return normalized===null?null:{'border-collapse':{value:normalized,important}};
};

const set=CSSPropertyManager.prototype.set;
CSSPropertyManager.prototype.set=function(name,value,important) {
  const normalized=value===null?undefined:normalizeTableValue(name,value);
  if(normalized===null)return [];
  return set.call(this,normalized===undefined?name:name.toLowerCase(),normalized===undefined?value:normalized,important);
};
