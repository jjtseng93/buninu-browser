import {parseCSSComponentValues} from './css-value-tokens.js';
import {lengthPercentage} from './sizing-values.js';

export const radiusCorners=['top-left','top-right','bottom-right','bottom-left'].map(corner=>`border-${corner}-radius`);
const properties=/^border(?:-(?:(?:top|bottom)-(?:left|right)|(?:start|end)-(?:start|end)))?-radius$/;
const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
const expand=([a,b=a,c=a,d=b])=>[a,b,c,d];
const compress=([a,b,c,d])=>a===c&&b===d?a===b?a:`${a} ${b}`:b===d?`${a} ${b} ${c}`:`${a} ${b} ${c} ${d}`;

/** CSS Backgrounds radius grammar shared by CSSOM, cascade and feature queries. */
export function normalizeBorderRadius(name,input,allowPending=true) {
  name=name.toLowerCase();
  if(!properties.test(name))return undefined;
  const value=String(input).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g,''),parsed=parseCSSComponentValues(value);
  if(!parsed)return null;
  if(parsed.pending)return allowPending?value:null;
  const {tokens}=parsed;
  if(tokens.length===1&&tokens[0].kind==='ident'&&wide.has(tokens[0].value.toLowerCase()))return tokens[0].value.toLowerCase();
  const slash=tokens.findIndex(token=>token.kind==='/'),shorthand=name==='border-radius';
  if(!shorthand&&slash!==-1)return null;
  const axes=slash===-1?[tokens]:[tokens.slice(0,slash),tokens.slice(slash+1)];
  const values=axes.map(axis=>axis.length&&axis.length<=(shorthand?4:2)?axis.map(lengthPercentage):null);
  if(values.some(axis=>!axis||axis.includes(null)))return null;
  if(!shorthand)return values[0].length===1||values[0][0]===values[0][1]?values[0][0]:values[0].join(' ');
  const horizontal=compress(expand(values[0])),vertical=values[1]?compress(expand(values[1])):horizontal;
  return horizontal===vertical?horizontal:`${horizontal} / ${vertical}`;
}

/** Expanded physical corner values; pending shorthand stays unexpanded. */
export function borderRadiusParts(name,input,allowPending=true) {
  name=name.toLowerCase();
  const value=normalizeBorderRadius(name,input,allowPending);
  if(value===null||value===undefined)return value;
  const parsed=parseCSSComponentValues(value);
  if(name!=='border-radius'||parsed.pending)return {[name]:value};
  if(wide.has(value))return Object.fromEntries(radiusCorners.map(name=>[name,value]));
  const slash=parsed.tokens.findIndex(token=>token.kind==='/');
  const horizontal=expand((slash===-1?parsed.tokens:parsed.tokens.slice(0,slash)).map(lengthPercentage));
  const vertical=slash===-1?horizontal:expand(parsed.tokens.slice(slash+1).map(lengthPercentage));
  return Object.fromEntries(radiusCorners.map((name,index)=>[name,horizontal[index]===vertical[index]?horizontal[index]:`${horizontal[index]} ${vertical[index]}`]));
}

/** Serialize four complete corner longhands without changing their meaning. */
export function serializeBorderRadius(values) {
  if(values.some(value=>!value))return null;
  if(values.some(value=>wide.has(value)))return values.every(value=>value===values[0])?values[0]:null;
  const axes=values.map(value=>{
    const parsed=parseCSSComponentValues(value);
    return !parsed||parsed.pending?null:parsed.tokens.map(lengthPercentage);
  });
  if(axes.some(axis=>!axis||!axis.length||axis.length>2||axis.includes(null)))return null;
  const horizontal=compress(axes.map(axis=>axis[0])),vertical=compress(axes.map(axis=>axis[1]??axis[0]));
  return horizontal===vertical?horizontal:`${horizontal} / ${vertical}`;
}
