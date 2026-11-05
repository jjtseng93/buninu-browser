import {parseCSSComponentValues} from './css-value-tokens.js';

const wide=new Set(['initial','inherit','unset','revert','revert-layer']);
const excluded=new Set([...wide,'revert-rule','default','none','all','auto','will-change']);
function identifier(value) {
  return Array.from(value,(c,i)=>{
    const n=c.codePointAt(0);
    if(n<32||n===127||i===0&&/[0-9]/.test(c)||i===1&&value[0]==='-'&&/[0-9]/.test(c))return `\\${n.toString(16)} `;
    if(value==='-')return '\\-';
    return /[a-z0-9_-]/i.test(c)||n>=128?c:`\\${c}`;
  }).join('');
}

/** Preserve case and duplicates of custom identifiers; only the two built-in
 * hints are keywords. Unknown property names are valid, inert future hints. */
export function normalizeWillChange(name,input,allowPending=true) {
  if(name.toLowerCase()!=='will-change')return undefined;
  const text=String(input).trim(),parsed=parseCSSComponentValues(text);
  if(!parsed)return null;
  if(parsed.pending)return allowPending?text:null;
  const tokens=parsed.tokens;
  if(tokens.length===1&&tokens[0].kind==='ident') {
    const lower=tokens[0].value.toLowerCase();
    if(lower==='auto'||wide.has(lower))return lower;
  }
  if(!tokens.length||tokens.length%2!==1)return null;
  const values=[];
  for(let i=0;i<tokens.length;i++) {
    const token=tokens[i];
    if(i%2) {if(token.kind!==',')return null;continue;}
    if(token.kind!=='ident'||excluded.has(token.value.toLowerCase()))return null;
    values.push(['contents','scroll-position'].includes(token.value.toLowerCase())?token.value.toLowerCase():identifier(token.value));
  }
  return values.join(', ');
}

const transformHints=new Set(['transform','translate','rotate','scale','perspective','-webkit-perspective','transform-style','offset-path']);
const fixedHints=new Set(['filter','backdrop-filter','contain']);
const stackingHints=new Set(['opacity','position','isolation','mix-blend-mode','clip-path','mask','mask-image','mask-border','view-transition-name',...fixedHints]);
const cache=new WeakMap();
const noHints=Object.freeze([]);
function hints(style) {
  const text=style?.willChange??'auto';
  if(text==='auto')return noHints;
  const cached=cache.get(style);
  if(cached?.text===text)return cached.values;
  const values=(parseCSSComponentValues(text)?.tokens??[]).filter(t=>t.kind==='ident').map(t=>t.value.toLowerCase());
  cache.set(style,{text,values});return values;
}
export function transformableBox(node,blockified=false) {
  return !!node&&node.style?.display!=='contents'&&node.style?.display!=='none'
    &&(blockified||!['inline','text','line-break','contents','table-column','table-column-group'].includes(node.type));
}
/** Geometry/stacking effects for boxes supported by the block layout path.
 * No GPU allocation is implied. Ordinary inline fragmentation is separate:
 * unlike transform, filter and position hints can apply to ordinary inline
 * boxes in CSS, but their fragmented containing blocks are not implemented. */
export function fixedContainingBlock(node,blockified=false) {
  const style=node?.style;
  if(!style||!transformableBox(node,blockified))return false;
  return !!(style.transform||style.translate||style.transformStyle==='preserve-3d')
    ||hints(style).some(name=>transformHints.has(name)||fixedHints.has(name));
}
export function absoluteContainingBlock(node,blockified=false) {
  return fixedContainingBlock(node,blockified)||node?.style?.position!=='static'&&!!node?.style?.position
    ||transformableBox(node,blockified)&&hints(node.style).includes('position');
}
export function stackingContext(node,{blockified=false,item=false}={}) {
  const style=node?.style;if(!style||style.display==='contents'||style.display==='none')return false;
  const positioned=!!style.position&&style.position!=='static',zApplies=positioned||item;
  return zApplies&&Number.isInteger(style.zIndex)||['fixed','sticky'].includes(style.position)
    ||style.opacity<1||!!style.clipPath||fixedContainingBlock(node,blockified)
    ||hints(style).some(name=>stackingHints.has(name)||name==='z-index'&&zApplies);
}
