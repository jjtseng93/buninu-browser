import {parseCSSComponentValues} from './css-value-tokens.js';
import {absoluteCSSNumericValue} from './animation-numeric-values.js';

const keywords = new Map([
  ['table-layout', new Set(['auto', 'fixed'])],
  ['border-collapse', new Set(['separate', 'collapse'])],
]);
const wide = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);
const absolute = new Map([['px',1],['in',96],['cm',96/2.54],['mm',96/25.4],['q',96/101.6],['pt',4/3],['pc',16]]);
const relative = /^(?:r?(?:em|ex|cap|ch|ic|lh)|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))$/;
const implementedRelative = /^(?:rem|em|ch|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))$/;
const maximum = 3.4028234663852886e38;
const finite = n => Math.min(maximum, Math.max(-maximum, n));
const number = n => String(Object.is(n,-0) ? 0 : n);

// Resolve relative units before using the shared typed arithmetic evaluator.
// For syntax checks a dummy length preserves dimensions without requiring a
// font or viewport. Computation supplies the real layout unit resolver.
function numeric(token, resolve = () => 1) {
  let unresolved=false;
  const map = token => {
    if (token.kind === 'dimension' && relative.test(token.unit.toLowerCase())) {
      const scale=resolve(`1${token.unit.toLowerCase()}`);
      if(!Number.isFinite(scale))unresolved=true;
      return {...token, unit:'px', value:String(Number(token.value) * scale)};
    }
    return token.args ? {...token, args:token.args.map(map)} : token;
  };
  const mapped=map(token);
  return unresolved?null:absoluteCSSNumericValue(mapped);
}
const lengthType = result => result && Object.entries(result.type).filter(([,power]) => power).every(([name,power]) => name === 'length' && power === 1)
  && result.type.length === 1;

// Canonicalize affine calc sums without resolving relative font/viewport
// units. CSS Values orders compatible dimension terms by unit and combines
// absolute lengths as px. Other typed math stays intact until computation.
function linear(token) {
  if (token.kind === 'number') return new Map([['',Number(token.value)]]);
  if (token.kind === 'dimension') {
    const unit=token.unit.toLowerCase(),scale=absolute.get(unit);
    return scale ? new Map([['px',Number(token.value)*scale]])
      : relative.test(unit) ? new Map([[unit,Number(token.value)]]) : null;
  }
  if (!(token.kind === 'function' && token.name === 'calc' || token.kind === 'block' && token.bracket === '(')) return null;
  const tokens=token.args;let at=0;
  const scalar = value => value?.size === 1 && value.has('');
  const product = () => {
    let value=linear(tokens[at++] ?? {});
    while(value && ['*','/'].includes(tokens[at]?.kind)) {
      const divide=tokens[at++].kind === '/',right=linear(tokens[at++] ?? {});
      if(!right || divide && !scalar(right) || !scalar(value) && !scalar(right)) return null;
      if(scalar(right)) {const factor=divide?1/right.get(''):right.get('');value=new Map([...value].map(([unit,n])=>[unit,n*factor]));}
      else {const factor=value.get('');value=new Map([...right].map(([unit,n])=>[unit,n*factor]));}
    }
    return value;
  };
  let value=product();
  while(value && ['+','-'].includes(tokens[at]?.kind)) {
    const operator=tokens[at++],right=product();
    if(!operator.spaced || !right || scalar(value)!==scalar(right)) return null;
    const sign=operator.kind==='+'?1:-1;
    for(const [unit,n] of right)value.set(unit,(value.get(unit)??0)+sign*n);
  }
  return at===tokens.length?value:null;
}

function specifiedLength(token) {
  if(token.kind==='number')return Number(token.value)===0?'0px':null;
  if(!['dimension','function'].includes(token.kind))return null;
  const result=numeric(token);
  if(!lengthType(result))return null;
  if(token.kind==='dimension')return Number(token.value)<0?null:`${number(finite(Number(token.value)))}${token.unit.toLowerCase()}`;
  const terms=linear(token);
  if(terms && [...terms.values()].every(Number.isFinite)) {
    const entries=[...terms].filter(([,n])=>n!==0).sort(([a],[b])=>a<b?-1:a>b?1:0);
    if(!entries.length)return 'calc(0px)';
    return `calc(${entries.map(([unit,n],i)=>`${i?(n<0?' - ':' + '):''}${number(i?Math.abs(n):n)}${unit}`).join('')})`;
  }
  return token.source;
}

/** undefined: unrelated; null: invalid; string: specified/pending value. */
export function normalizeTableValue(name,input,allowPending=true) {
  name=name.toLowerCase();
  if(name!=='border-spacing'&&!keywords.has(name))return undefined;
  const text=String(input).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g,''),parsed=parseCSSComponentValues(text);
  if(!parsed)return null;
  if(parsed.pending)return allowPending?text:null;
  const {tokens}=parsed;
  if(tokens.length===1&&tokens[0].kind==='ident') {
    const value=tokens[0].value.toLowerCase();
    return wide.has(value)||keywords.get(name)?.has(value)?value:null;
  }
  if(name!=='border-spacing'||tokens.length<1||tokens.length>2)return null;
  const values=tokens.map(specifiedLength);
  return values.some(value=>value===null)?null:values[0]===values[1]?values[0]:values.join(' ');
}

// Preserve valid specified font-relative lengths in CSSOM, even for metrics
// the current layout engine cannot resolve yet. Feature queries must not
// advertise those missing layout units merely because CSSOM stores them.
export function supportsTableValue(name,input) {
  const normalized=normalizeTableValue(name,input);
  if(normalized===undefined)return undefined;
  if(normalized===null)return false;
  const parsed=parseCSSComponentValues(normalized);
  if(parsed.pending)return true;
  const missing=token=>token.kind==='dimension'&&relative.test(token.unit.toLowerCase())&&!implementedRelative.test(token.unit.toLowerCase())
    || token.args?.some(missing);
  return !parsed.tokens.some(missing);
}

export function computedTableSpacing(input,resolve) {
  const tokens=parseCSSComponentValues(input)?.tokens;
  if(!tokens||tokens.length<1||tokens.length>2)return null;
  const values=tokens.map(token=>{
    if(token.kind==='number'&&Number(token.value)===0)return 0;
    const result=numeric(token,resolve);
    if(!lengthType(result))return null;
    // Range restrictions apply after calculation; a negative math result is
    // a valid declaration resolving to zero, unlike a negative length token.
    return Number.isNaN(result.value)?0:Math.max(0,finite(result.value));
  });
  return values.includes(null)?null:Object.freeze([values[0],values[1]??values[0]]);
}
