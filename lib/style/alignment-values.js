import {parseCSSComponentValues,trimCSSWhitespace} from './css-value-tokens.js';

const names=new Map();
for(const part of ['content','items','self']) {
  const pair=[`align-${part}`,`justify-${part}`];
  names.set(`place-${part}`,pair);
  for(const name of pair)names.set(name,[name]);
}
const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
const positions=new Set(['center','start','end','flex-start','flex-end','flow-start','flow-end']);
const distribution=new Set(['space-between','space-around','space-evenly','stretch']);
export const alignmentLonghands=name=>names.get(name.toLowerCase())??null;
export const serializeAlignment=(align,justify)=>align===justify?align:`${align} ${justify}`;

function longhand(name,words) {
  const content=name.endsWith('-content'),justify=name.startsWith('justify-');
  let [first,second]=words;
  if(words.length===1) {
    if(first==='normal'||first==='stretch'||positions.has(first))return first;
    if(first==='auto'&&name.endsWith('-self'))return first;
    if(first==='baseline'&&name!=='justify-content')return first;
    if(content&&distribution.has(first))return first;
    if(!content&&['self-start','self-end'].includes(first))return first;
    if(justify&&['left','right'].includes(first))return first;
    if(name==='justify-items'&&first==='legacy')return first;
  }
  if(words.length!==2)return null;
  if(name!=='justify-content'&&['first','last'].includes(first)&&second==='baseline')return first==='first'?'baseline':'last baseline';
  if(name==='justify-items'&&words.includes('legacy')) {
    const position=first==='legacy'?second:first;
    return ['left','right','center'].includes(position)?`legacy ${position}`:null;
  }
  if(!['safe','unsafe'].includes(first))return null;
  if(positions.has(second)||justify&&['left','right'].includes(second)||!content&&['normal','self-start','self-end'].includes(second))return `${first} ${second}`;
  return null;
}

function parse(name,input,allowPending) {
  const longhands=alignmentLonghands(name);if(!longhands)return undefined;
  const text=trimCSSWhitespace(String(input)),parsed=parseCSSComponentValues(text);
  if(!parsed)return null;
  if(parsed.pending)return allowPending?{values:longhands.map(()=>text),pending:longhands.length>1}:null;
  if(parsed.tokens.some(token=>token.kind!=='ident'))return null;
  const words=parsed.tokens.map(token=>token.value.toLowerCase());
  if(words.length===1&&wide.has(words[0]))return {values:longhands.map(()=>words[0])};
  if(longhands.length===1) {
    const value=longhand(name,words);return value===null?null:{values:[value]};
  }
  // Each side is a complete grammar production (possibly two identifiers),
  // not one whitespace-delimited word. Only place-content changes the omitted
  // second value for baseline alignment.
  for(let split=1;split<=Math.min(2,words.length);split++) {
    const align=longhand(longhands[0],words.slice(0,split));
    if(align===null)continue;
    const justify=split===words.length
      ?name==='place-content'&&align.endsWith('baseline')?'start':longhand(longhands[1],words.slice(0,split))
      :longhand(longhands[1],words.slice(split));
    if(justify!==null)return {values:[align,justify]};
  }
  return null;
}
export function normalizeAlignment(name,input,allowPending=true) {
  name=name.toLowerCase();const parsed=parse(name,input,allowPending);
  if(parsed===undefined||parsed===null)return parsed;
  return parsed.pending?parsed.values[0]:parsed.values.length===1?parsed.values[0]:serializeAlignment(...parsed.values);
}
export function expandAlignment(name,input,allowPending=true) {
  name=name.toLowerCase();const parsed=parse(name,input,allowPending);
  if(parsed===undefined||parsed===null)return parsed;
  return alignmentLonghands(name).map((longhand,index)=>({name:longhand,value:parsed.values[index],...(parsed.pending?{pendingBorder:name}:{})}));
}
export const computedAlignment=value=>value.replace(/\bflex-(start|end)\b/g,'flow-$1');

// Horizontal-writing layout uses increasing physical coordinates, except the
// main-axis flex sequence which is mirrored after positioning. Keep logical
// start/end separate from flow-start/end until that coordinate system is known.
export function usedAlignment(value='normal',{axis='x',direction='ltr',selfDirection=direction,reverse=false,flex=false,self=false,free=0}={}) {
  let safe=false;
  if(value.startsWith('safe ')){safe=true;value=value.slice(5);}
  else if(value.startsWith('unsafe '))value=value.slice(7);
  if(value.startsWith('legacy '))value=value.slice(7);
  // Baseline-sharing groups are not formed by this layout engine yet; use
  // their specified fallback, including the item's direction for self alignment.
  if(value==='baseline'){value=self?'self-start':'start';safe=true;}
  else if(value==='last baseline'){value=self?'self-end':'end';safe=true;}
  if(safe&&free<0)value='flow-start';
  value=computedAlignment(value);
  if(value==='flow-start'||value==='flow-end') {
    if(flex)return value==='flow-start'?'start':'end';
    value=value==='flow-start'?'start':'end';
  }
  let end;
  if(value==='start'||value==='end')end=(axis==='x'&&direction==='rtl')!==(value==='end');
  else if(value==='self-start'||value==='self-end')end=(axis==='x'&&selfDirection==='rtl')!==(value==='self-end');
  else if(value==='left'||value==='right')end=axis==='x'&&value==='right';
  else return value;
  return end!==reverse?'end':'start';
}
export function alignmentOffset(value,free,options={}) {
  const used=usedAlignment(value,{...options,free});
  if(used==='center')return free/2;
  if(used==='end')return free;
  if(used==='normal'||used==='stretch')return usedAlignment('flow-start',options)==='end'?free:0;
  return 0;
}

export function alignmentDistribution(value,free,count,options={}) {
  let offset=0,between=0;
  if(!count)return {offset,between};
  if(value==='space-between'&&free>0&&count>1)between=free/(count-1);
  else if(value==='space-around'&&free>0){between=free/count;offset=between/2;}
  else if(value==='space-evenly'&&free>0){between=free/(count+1);offset=between;}
  else {
    const fallback=value==='space-between'?'safe flow-start':['space-around','space-evenly'].includes(value)?'safe center':value;
    offset=alignmentOffset(fallback,free,options);
  }
  return {offset,between};
}
