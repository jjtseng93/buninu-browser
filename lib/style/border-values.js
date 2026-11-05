import {parseCSSComponentValues} from './css-value-tokens.js';
import {normalizeTableValue,computedTableSpacing} from './table-values.js';
import {radiusCorners,borderRadiusParts} from './border-radius-values.js';

const properties=/^border(?:-(?:top|right|bottom|left))?(?:-(?:width|style|color))?$/;
const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
const styles=new Set(['none','hidden','solid','dashed','dotted','double','groove','ridge','inset','outset']);
const widths=new Map([['thin',1],['medium',3],['thick',5]]);
const sides=['top','right','bottom','left'];
const imageParts=['source','slice','width','outset','repeat'].map(part=>`border-image-${part}`);
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
  if(value==='currentcolor')return value;
  const rgba=value?Bun.color(value,'rgba'):null;
  if(!/^rgba?\(/.test(rgba??''))return null;
  // Opaque rgb()/rgba() colors share the legacy rgb() serialization. Preserve
  // named colors and other color spaces at specified-value time.
  return /^rgba?\(/i.test(value)&&/, 1\)$/.test(rgba)?rgba.replace(/^rgba\(/,'rgb(').replace(/, 1\)$/,')'):value;
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

/** The physical longhands affected by one of the implemented border shorthands. */
export function borderLonghands(name) {
  if(name==='border-radius')return radiusCorners;
  if(radiusCorners.includes(name))return [name];
  if(!properties.test(name))return null;
  const side=sides.find(side=>name.startsWith(`border-${side}`));
  const kind=/(width|style|color)$/.exec(name)?.[1];
  return (side?[side]:sides).flatMap(side=>(kind?[kind]:['width','style','color']).map(kind=>`border-${side}-${kind}`))
    .concat(name==='border'?imageParts:[]);
}

/** Expand before priority resolution, retaining pending substitution per longhand. */
export function expandBorderValue(name,input,allowPending=true) {
  name=name.toLowerCase();
  const radii=borderRadiusParts(name,input,allowPending);
  if(radii!==undefined) {
    if(radii===null)return null;
    if(Object.hasOwn(radii,'border-radius'))return allowPending
      ?radiusCorners.map(name=>({name,value:radii['border-radius'],pendingBorder:'border-radius'})):null;
    return Object.entries(radii).map(([name,value])=>({name,value}));
  }
  const value=normalizeBorderValue(name,input,allowPending);
  if(value===undefined||value===null)return value;
  const names=borderLonghands(name),parsed=parseCSSComponentValues(value);
  if(names.length===1)return [{name,value}];
  if(parsed.pending)return names.map(longhand=>({name:longhand,value,pendingBorder:name}));
  if(wide.has(value))return names.map(name=>({name,value}));
  const kind=/(width|style|color)$/.exec(name)?.[1];
  if(kind) {
    const [a,b=a,c=a,d=b]=parsed.tokens.map(token=>part(kind,token));
    return names.map((name,index)=>({name,value:[a,b,c,d][index]}));
  }
  const components={width:'medium',style:'none',color:'currentcolor'};
  for(const token of parsed.tokens) {
    const kind=['width','style','color'].find(kind=>part(kind,token)!==null);
    components[kind]=part(kind,token);
  }
  return names.map(name=>({name,value:name.startsWith('border-image-')?'initial':components[name.split('-').at(-1)]}));
}
