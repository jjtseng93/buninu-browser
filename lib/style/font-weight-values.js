import {parseCSSComponentValues,trimCSSWhitespace} from './css-value-tokens.js';
import {absoluteCSSNumericValue} from './animation-numeric-values.js';

const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
const keywords=new Set(['normal','bold','bolder','lighter']);
const format=value=>String(Object.is(value,-0)?0:value);

function weightToken(token) {
  if(token.kind==='ident') {
    const value=token.value.toLowerCase();
    return keywords.has(value)||wide.has(value)?value:null;
  }
  if(!['number','function'].includes(token.kind))return null;
  // Relative lengths require a layout context, which this numeric path does
  // not yet provide. Do not turn an unresolved calculation into a weight.
  const result=absoluteCSSNumericValue(token);
  if(!result||Object.values(result.type).some(Boolean))return null;
  if(token.kind==='number')return result.value>=1&&result.value<=1000?format(result.value):null;
  const value=Number.isFinite(result.value)?format(result.value)
    :Number.isNaN(result.value)?'NaN':result.value<0?'-infinity':'infinity';
  return `calc(${value})`;
}

/** undefined: unrelated; null: invalid; string: canonical or pending. */
export function normalizeFontWeight(name,input,allowPending=true) {
  if(name.toLowerCase()!=='font-weight')return undefined;
  const text=trimCSSWhitespace(String(input)),parsed=parseCSSComponentValues(text);
  if(!parsed)return null;
  if(parsed.pending)return allowPending?text:null;
  return parsed.tokens.length===1?weightToken(parsed.tokens[0]):null;
}

/** The absolute part of a shorthand, or a relative keyword resolved later. */
export function fontWeightComponent(input) {
  const value=normalizeFontWeight('font-weight',input,false);
  return value!==null&&!wide.has(value)?value:null;
}

export function computedFontWeight(input,inherited=400) {
  const value=fontWeightComponent(input);
  if(value===null)return undefined;
  if(value==='normal')return 400;
  if(value==='bold')return 700;
  if(value==='bolder')return inherited<350?400:inherited<550?700:inherited<900?900:inherited;
  if(value==='lighter')return inherited<100?inherited:inherited<550?100:inherited<750?400:700;
  const token=parseCSSComponentValues(value).tokens[0],number=absoluteCSSNumericValue(token).value;
  // Calculations, unlike literal numbers, are clamped at computed-value time.
  return Math.max(1,Math.min(1000,Number.isNaN(number)?0:number));
}

/** @font-face has its own one-or-two absolute-weight descriptor grammar. */
export function fontWeightRange(input) {
  const parsed=parseCSSComponentValues(String(input));
  if(!parsed||parsed.pending||parsed.tokens.length<1||parsed.tokens.length>2)return null;
  const values=parsed.tokens.map(weightToken);
  if(values.some(value=>value===null||wide.has(value)||value==='bolder'||value==='lighter'))return null;
  const weights=values.map(value=>computedFontWeight(value));
  return [Math.min(...weights),Math.max(...weights)];
}
