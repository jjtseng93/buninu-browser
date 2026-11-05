import './css-font-weight.js';
import CSSPropertySetParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/parsers/CSSPropertySetParser.ts';
import {fontWeightComponent} from '../style/font-weight-values.js';
import {parseCSSComponentValues} from '../style/css-value-tokens.js';
import {parseFontFamily,fontShorthandTokens} from '../style/font-family-values.js';

CSSPropertySetParser.getFontFamily=function(value,important) {
  const parsed=parseFontFamily(value);
  return parsed?{'font-family':{value:parsed.value,important}}:null;
};
const getFont=CSSPropertySetParser.getFont;
CSSPropertySetParser.getFont=function(value,important) {
  const parsed=parseCSSComponentValues(value);
  if(!parsed)return null;
  if(parsed.pending)return {font:{value,important}};
  if(parsed.tokens.length===1&&parsed.tokens[0].kind==='ident')return getFont.call(this,value,important);
  const tokens=fontShorthandTokens(value),properties={
    ...this.getFontStyle('normal',important),...this.getFontVariant('normal',important),
    ...this.getFontWeight('normal',important),...this.getFontStretch('normal',important),...this.getLineHeight('normal',important),
  };
  let hasWeight=false;
  for(let index=0;index<tokens.length;index++) {
    const token=tokens[index],weight=fontWeightComponent(token);
    if(weight!==null&&weight!=='normal') {
      if(hasWeight)return null;
      Object.assign(properties,this.getFontWeight(weight,important));hasWeight=true;continue;
    }
    const size=this.getFontSize(token,important);
    if(size) {
      Object.assign(properties,size);
      if(tokens[index+1]==='/') {
        const height=this.getLineHeight(tokens[index+2]??'',important);
        if(!height)return null;
        Object.assign(properties,height);index+=2;
      }
      const family=parseFontFamily(tokens.slice(index+1).join(' '),false);
      if(!family?.families)return null;
      return {...properties,'font-family':{value:family.value,important}};
    }
    const prefix=this.getFontStyle(token,important)??this.getFontVariant(token,important)??this.getFontWeight(token,important)??this.getFontStretch(token,important);
    if(!prefix)return null;
    Object.assign(properties,prefix);
  }
  return null;
};
