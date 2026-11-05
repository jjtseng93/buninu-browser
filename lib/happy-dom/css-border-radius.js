import CSSPropertySetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertySetParser.ts';
import CSSPropertyGetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertyGetParser.ts';
import {borderRadiusParts,radiusCorners,serializeBorderRadius} from '../style/border-radius-values.js';

for(const name of ['border-radius',...radiusCorners]) {
  const method=`get${name.replace(/(^|-)([a-z])/g,(_,dash,c)=>c.toUpperCase())}`;
  CSSPropertySetParser[method]=function(value,important) {
    const parts=borderRadiusParts(name,value);
    return parts===null?null:Object.fromEntries(Object.entries(parts).map(([name,value])=>[name,{value,important}]));
  };
}
CSSPropertyGetParser.getBorderRadius=function(properties) {
  const parts=radiusCorners.map(name=>properties[name]);
  if(parts.some(part=>!part)||parts.some(part=>Boolean(part.important)!==Boolean(parts[0].important)))return null;
  const value=serializeBorderRadius(parts.map(part=>part.value));
  return value===null?null:{value,important:parts[0].important};
};
