import CSSPropertySetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertySetParser.ts';
import {normalizeFontWeight} from '../style/font-weight-values.js';

CSSPropertySetParser.getFontWeight=function(value,important) {
  const normalized=normalizeFontWeight('font-weight',value);
  return normalized===null?null:{'font-weight':{value:normalized,important}};
};
