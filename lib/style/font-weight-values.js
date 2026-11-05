import {parseCSSComponentValues,trimCSSWhitespace} from './css-value-tokens.js';
import {typedCSSNumericValue,hasRelativeCSSUnits} from './animation-numeric-values.js';
import {serializeDeferredCSSMath} from './css-math-serialization.js';

const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
const keywords=new Set(['normal','bold','bolder','lighter']);
const format=value=>String(Object.is(value,-0)?0:value);

function weightToken(token, allowRelative = true) {
  if(token.kind==='ident') {
    const value=token.value.toLowerCase();
    return keywords.has(value)||wide.has(value)?value:null;
  }
  if(!['number','function'].includes(token.kind))return null;
  // Validate dimensions before requiring font/viewport/container geometry.
  // sign(length) and length/length have a number result even when the length
  // is not yet computable. Preserve those expressions until the cascade.
  const relative=hasRelativeCSSUnits(token);
  if(relative&&!allowRelative)return null;
  const result=typedCSSNumericValue(token);
  if(!result||Object.values(result.type).some(Boolean))return null;
  if(token.kind==='number')return result.value>=1&&result.value<=1000?format(result.value):null;
  if(relative)return serializeDeferredCSSMath(token);
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

export function computedFontWeight(input,inherited=400,resolveRelative) {
  const value=fontWeightComponent(input);
  if(value===null)return undefined;
  if(value==='normal')return 400;
  if(value==='bold')return 700;
  if(value==='bolder')return inherited<350?400:inherited<550?700:inherited<900?900:inherited;
  if(value==='lighter')return inherited<100?inherited:inherited<550?100:inherited<750?400:700;
  const token=parseCSSComponentValues(value).tokens[0];
  // Do not clamp unresolved geometry to weight 1 as if it were calc(NaN).
  if(hasRelativeCSSUnits(token)&&!resolveRelative)return undefined;
  const result=typedCSSNumericValue(token,resolveRelative);
  if(!result)return undefined;
  const number=result.value;
  // Calculations, unlike literal numbers, are clamped at computed-value time.
  return Math.max(1,Math.min(1000,Number.isNaN(number)?0:number));
}

/** @font-face has its own one-or-two absolute-weight descriptor grammar. */
export function fontWeightRange(input) {
  const parsed=parseCSSComponentValues(String(input));
  if(!parsed||parsed.pending||parsed.tokens.length<1||parsed.tokens.length>2)return null;
  const values=parsed.tokens.map(token=>weightToken(token,false));
  if(values.some(value=>value===null||wide.has(value)||value==='bolder'||value==='lighter'))return null;
  const weights=values.map(value=>computedFontWeight(value));
  return [Math.min(...weights),Math.max(...weights)];
}
