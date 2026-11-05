import {parseCSSComponentValues} from './css-value-tokens.js';
import {normalizeTableValue,computedTableSpacing} from './table-values.js';

const properties=/^border(?:-(?:top|right|bottom|left))?(?:-(?:width|style|color))?$/;
const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
const styles=new Set(['none','hidden','solid','dashed','dotted','double','groove','ridge','inset','outset']);
const widths=new Map([['thin',1],['medium',3],['thick',5]]);
const text=token=>token.kind==='ident'?token.value.toLowerCase():token.kind==='hash'?`#${token.value}`
  :token.kind==='number'||token.kind==='dimension'?`${token.value}${token.unit??''}`:token.source;

function width(token) {
  if(token.kind==='ident')return widths.has(token.value.toLowerCase())?token.value.toLowerCase():null;
  if(!['number','dimension','function'].includes(token.kind))return null;
  return normalizeTableValue('border-spacing',text(token),false);
}
function color(token) {
  const value=text(token);
  // Bun can also return an unresolved system-color keyword. Keep feature
  // queries limited to colors the existing CPU painter can actually resolve.
  return value&&(value==='currentcolor'||/^rgba?\(/.test(Bun.color(value,'rgba')??''))?value:null;
}
const part=(name,token)=>name==='width'?width(token):name==='style'
  ?token.kind==='ident'&&styles.has(token.value.toLowerCase())?token.value.toLowerCase():null
  :color(token);

/** Shared grammar for the existing physical borders, not border-image. */
export function normalizeBorderValue(name,input,allowPending=true) {
  name=name.toLowerCase();
  if(!properties.test(name))return undefined;
  const value=String(input).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g,''),parsed=parseCSSComponentValues(value);
  if(!parsed)return null;
  if(parsed.pending)return allowPending?value:null;
  const {tokens}=parsed;
  if(tokens.length===1&&tokens[0].kind==='ident'&&wide.has(tokens[0].value.toLowerCase()))return tokens[0].value.toLowerCase();
  const kind=/(width|style|color)$/.exec(name)?.[1];
  if(kind) {
    const maximum=name===`border-${kind}`?4:1;
    if(tokens.length<1||tokens.length>maximum)return null;
    const values=tokens.map(token=>part(kind,token));
    return values.includes(null)?null:values.join(' ');
  }
  if(tokens.length<1||tokens.length>3)return null;
  const seen=new Set(),values=[];
  for(const token of tokens) {
    const kind=['width','style','color'].find(kind=>part(kind,token)!==null);
    if(!kind||seen.has(kind))return null;
    seen.add(kind);values.push(part(kind,token));
  }
  return values.join(' ');
}

export function computedBorderWidth(value,resolve) {
  if(widths.has(value))return widths.get(value);
  return computedTableSpacing(value,resolve)?.[0]??null;
}
