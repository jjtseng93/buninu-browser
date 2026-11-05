import CSSPropertySetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertySetParser.ts';
import CSSPropertyGetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertyGetParser.ts';
import {BACKGROUND_DEFAULTS,expandBackgroundValue,serializeBackground} from '../style/background-values.js';
for(const name of ['background','background-position',...Object.keys(BACKGROUND_DEFAULTS)]) {
  const method=`get${name.replace(/(^|-)([a-z])/g,(_,dash,c)=>c.toUpperCase())}`;
  CSSPropertySetParser[method]=function(value,important) {
    const parts=expandBackgroundValue(name,value);
    return parts===null?null:Object.fromEntries(parts.map(part=>[part.name,{value:part.value,important}]));
  };
}
CSSPropertyGetParser.getBackground=properties=>serializeBackground(properties);
CSSPropertyGetParser.getBackgroundPosition=properties=>serializeBackground(properties,'background-position');
