import {parseCSSComponentValues} from './css-value-tokens.js';
import {lengthPercentage} from './sizing-values.js';

const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
const physical=['top','right','bottom','left'].map(side=>`margin-${side}`);
const axes=new Map(['block','inline'].map(axis=>[`margin-${axis}`,['start','end'].map(edge=>`margin-${axis}-${edge}`)]));
const single=new Map([...physical,...axes.values()].flat().map(name=>[name,[name]]));
export function marginLonghands(name) {
  name=name.toLowerCase();
  if(name==='margin')return physical;
  return axes.get(name)??single.get(name)??null;
}
export function compressMargin(values) {
  const parts=[...values];
  if(parts.length===4&&parts[3]===parts[1])parts.pop();
  if(parts.length===3&&parts[2]===parts[0])parts.pop();
  if(parts.length===2&&parts[1]===parts[0])parts.pop();
  return parts.join(' ');
}
function component(token) {
  if(token.kind==='ident'&&token.value.toLowerCase()==='auto')return 'auto';
  // Margins allow signed lengths, unlike sizing/padding. Functions retain
  // their deferred percentage basis and are never range-clamped here.
  if(token.kind==='dimension'&&Number(token.value)<0) {
    const positive=lengthPercentage({...token,value:String(-Number(token.value))});
    return positive===null?null:`-${positive}`;
  }
  return lengthPercentage(token);
}
export function normalizeMargin(name,input,allowPending=true) {
  const names=marginLonghands(name);if(!names)return undefined;
  const text=String(input).trim(),parsed=parseCSSComponentValues(text);
  if(!parsed)return null;
  if(parsed.pending)return allowPending?text:null;
  if(parsed.tokens.length===1&&parsed.tokens[0].kind==='ident'&&wide.has(parsed.tokens[0].value.toLowerCase()))return parsed.tokens[0].value.toLowerCase();
  if(!parsed.tokens.length||parsed.tokens.length>names.length)return null;
  const values=parsed.tokens.map(component);
  return values.includes(null)?null:compressMargin(values);
}
export function expandMargin(name,input,allowPending=true) {
  name=name.toLowerCase();
  const value=normalizeMargin(name,input,allowPending);
  if(value===undefined||value===null)return value;
  const names=marginLonghands(name),shorthand=name,parsed=parseCSSComponentValues(value);
  if(parsed.pending)return names.map(name=>({name,value,pendingBorder:names.length>1?shorthand:undefined}));
  const parts=wide.has(value)?[value]:parsed.tokens.map(component);
  const expanded=names.length===4?[parts[0],parts[1]??parts[0],parts[2]??parts[0],parts[3]??parts[1]??parts[0]]:
    names.length===2?[parts[0],parts[1]??parts[0]]:parts;
  return names.map((name,index)=>({name,value:expanded[index]}));
}
