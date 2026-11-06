import {parseCSSComponentValues} from './css-value-tokens.js';
import {absoluteCSSNumericValue} from './animation-numeric-values.js';
import {serializeLinearLength} from './table-values.js';
import {cacheSpecifiedValue} from './css-specified-value-cache.js';

const properties=/^(?:(?:min|max)-)?(?:width|height|inline-size|block-size)$/;
const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
const intrinsic=new Set(['min-content','max-content','fit-content','stretch','contain']);
const relative=/^(?:r?(?:em|ex|cap|ch|ic|lh)|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))$/;
const maximum=3.4028234663852886e38;
const finite=n=>Math.min(maximum,Math.max(-maximum,n));
const number=n=>String(Object.is(n,-0)?0:n);
const isLength=result=>result?.type.length===1 && Object.entries(result.type).every(([name,power])=>!power||name==='length'&&power===1);

function typedLength(token,resolve=()=>1) {
  let unresolved=false;
  const convert=token=>{
    if(token.kind==='dimension'&&(token.unit==='%'||relative.test(token.unit.toLowerCase()))) {
      const scale=token.unit==='%'?1:resolve(`1${token.unit.toLowerCase()}`);
      if(!Number.isFinite(scale))unresolved=true;
      // The property's percentage hint is length: percentages and lengths
      // may add, but inverse dimensions and mixed number/length sums may not.
      return {...token,unit:'px',value:String(Number(token.value)*scale)};
    }
    return token.args?{...token,args:token.args.map(convert)}:token;
  };
  const converted=convert(token);
  return unresolved?null:absoluteCSSNumericValue(converted);
}

/** A nonnegative length-percentage component, preserving deferred math. */
export function lengthPercentage(token) {
  if(token.kind==='number')return Number(token.value)===0?'0px':null;
  if(!['dimension','function'].includes(token.kind)||!isLength(typedLength(token)))return null;
  if(token.kind==='dimension')return Number(token.value)<0?null:`${number(finite(Number(token.value)))}${token.unit.toLowerCase()}`;
  // Canonicalize affine sums without resolving their font/percentage basis.
  // Other typed math retains its deferred calculation until layout.
  return serializeLinearLength(token,true) ?? token.source;
}

/** undefined: unrelated; null: invalid; string: normalized/pending value. */
export function normalizeSizingValue(name,input,allowPending=true) {
  name=name.toLowerCase();
  if(!properties.test(name))return undefined;
  return cachedSizingValue(name,input,allowPending);
}
const cachedSizingValue=cacheSpecifiedValue(sizingValue);
function sizingValue(name,input,allowPending) {
  const text=String(input).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g,''),parsed=parseCSSComponentValues(text);
  if(!parsed)return null;
  if(parsed.pending)return allowPending?text:null;
  if(parsed.tokens.length!==1)return null;
  const token=parsed.tokens[0];
  if(token.kind==='ident') {
    const value=token.value.toLowerCase(),defaultValue=name.startsWith('max-')?'none':'auto';
    return wide.has(value)||intrinsic.has(value)||value===defaultValue?value:null;
  }
  if(token.kind==='function'&&token.name==='fit-content') {
    if(token.args.length!==1)return null;
    const argument=lengthPercentage(token.args[0]);
    return argument===null?null:`fit-content(${argument})`;
  }
  return lengthPercentage(token);
}

/** Resolve available lengths now, preserving percentages until layout. */
export function computedSizingValue(input,resolve) {
  let value=resolve(input);
  if(!Number.isFinite(value)&&!value?.unit) {
    const tokens=parseCSSComponentValues(input)?.tokens;
    const hasPercentage=token=>token.kind==='dimension'&&token.unit==='%'||token.args?.some(hasPercentage);
    if(tokens?.length!==1||hasPercentage(tokens[0]))return value;
    const result=typedLength(tokens[0],resolve);
    if(!isLength(result))return value;
    value=Number.isNaN(result.value)?0:finite(result.value);
  }
  // A negative literal was rejected during parsing. Math remains valid and
  // clamps only once its entire result is known (CSS Values range checking).
  if(Number.isFinite(value))return Math.max(0,value);
  if(value?.unit==='%')return Object.freeze({...value,value:Math.max(0,value.value)});
  if(value?.unit==='math')return Object.freeze({...value,nonNegative:true});
  return value;
}
