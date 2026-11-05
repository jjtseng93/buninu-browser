import {parseCSSComponentValues,trimCSSWhitespace} from './css-value-tokens.js';
import {lengthPercentage} from './sizing-values.js';
import {supportsLengthUnits} from './table-values.js';
import {compressMargin} from './margin-values.js';

const aliases=new Map([['grid-gap','gap'],['grid-row-gap','row-gap'],['grid-column-gap','column-gap']]);
const names=new Map([['gap',['row-gap','column-gap']],['row-gap',['row-gap']],['column-gap',['column-gap']]]);
const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
export const gapProperty=name=>aliases.get(name)??name;
export const gapLonghands=name=>names.get(gapProperty(name.toLowerCase()))??null;
const component=token=>token.kind==='ident'&&token.value.toLowerCase()==='normal'?'normal':lengthPercentage(token);

export function normalizeGap(name,input,allowPending=true) {
  const longhands=gapLonghands(name);if(!longhands)return undefined;
  const text=trimCSSWhitespace(String(input)),parsed=parseCSSComponentValues(text);
  if(!parsed)return null;
  if(parsed.pending)return allowPending?text:null;
  if(parsed.tokens.length===1&&parsed.tokens[0].kind==='ident'&&wide.has(parsed.tokens[0].value.toLowerCase()))return parsed.tokens[0].value.toLowerCase();
  if(!parsed.tokens.length||parsed.tokens.length>longhands.length)return null;
  const values=parsed.tokens.map(component);
  return values.includes(null)?null:compressMargin(values);
}

export function expandGap(name,input,allowPending=true) {
  name=gapProperty(name.toLowerCase());
  const value=normalizeGap(name,input,allowPending);
  if(value===undefined||value===null)return value;
  const longhands=gapLonghands(name),parsed=parseCSSComponentValues(value);
  if(parsed.pending)return longhands.map(name=>({name,value,pendingBorder:longhands.length>1?'gap':undefined}));
  const values=wide.has(value)?[value]:parsed.tokens.map(component);
  return longhands.map((name,index)=>({name,value:values[index]??values[0]}));
}

export function supportsGap(name,input) {
  const value=normalizeGap(name,input);
  if(value===undefined)return undefined;
  if(value===null)return false;
  const parsed=parseCSSComponentValues(value);
  return parsed.pending||supportsLengthUnits(parsed.tokens);
}
