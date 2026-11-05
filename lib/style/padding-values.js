import {parseCSSComponentValues} from './css-value-tokens.js';
import {lengthPercentage} from './sizing-values.js';
import {compressMargin} from './margin-values.js';
import {supportsLengthUnits} from './table-values.js';

const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
const physical=['top','right','bottom','left'].map(side=>`padding-${side}`);
const axes=new Map(['block','inline'].map(axis=>[`padding-${axis}`,['start','end'].map(edge=>`padding-${axis}-${edge}`)]));
const single=new Map([...physical,...axes.values()].flat().map(name=>[name,[name]]));
export function paddingLonghands(name) {
  name=name.toLowerCase();
  return name==='padding'?physical:axes.get(name)??single.get(name)??null;
}

/** A negative literal is invalid; negative math is valid and is clamped only
 * when the complete computed/used value (including its percent basis) exists. */
export function normalizePadding(name,input,allowPending=true) {
  const names=paddingLonghands(name);if(!names)return undefined;
  const text=String(input).trim(),parsed=parseCSSComponentValues(text);
  if(!parsed)return null;
  if(parsed.pending)return allowPending?text:null;
  if(parsed.tokens.length===1&&parsed.tokens[0].kind==='ident'&&wide.has(parsed.tokens[0].value.toLowerCase()))return parsed.tokens[0].value.toLowerCase();
  if(!parsed.tokens.length||parsed.tokens.length>names.length)return null;
  const values=parsed.tokens.map(lengthPercentage);
  return values.includes(null)?null:compressMargin(values);
}

export function expandPadding(name,input,allowPending=true) {
  name=name.toLowerCase();
  const value=normalizePadding(name,input,allowPending);
  if(value===undefined||value===null)return value;
  const names=paddingLonghands(name),parsed=parseCSSComponentValues(value);
  if(parsed.pending)return names.map(longhand=>({name:longhand,value,pendingBorder:names.length>1?name:undefined}));
  const parts=wide.has(value)?[value]:parsed.tokens.map(lengthPercentage);
  const expanded=names.length===4?[parts[0],parts[1]??parts[0],parts[2]??parts[0],parts[3]??parts[1]??parts[0]]:
    names.length===2?[parts[0],parts[1]??parts[0]]:parts;
  return names.map((name,index)=>({name,value:expanded[index]}));
}

export function supportsPadding(name,input) {
  const value=normalizePadding(name,input);
  if(value===undefined)return undefined;
  if(value===null)return false;
  const parsed=parseCSSComponentValues(value);
  return parsed.pending||supportsLengthUnits(parsed.tokens);
}
