import { computeElementStyle } from '../style/computed-style.js';
export const inputPresentation = new WeakMap();
export const inputOwner = new WeakMap();

const spans = new WeakMap();
const carets = new WeakMap();
export const inputCaretNode = element => carets.get(element);

// Form controls share native selection and caret presentation across frontends.
export function textInputSelection(element, text, style, make) {
  const options=inputPresentation.get(element)||{};
  const focused=element.ownerDocument.activeElement===element;
  const value=String(element.value??'');
  const position=at=>element.type==='password'?[...value.slice(0,at)].length:at;
  const start=position(element.selectionStart??0),end=position(element.selectionEnd??0);
  const raw=(focused||options.persistent)&&end>start ? {start,end,background:options.background||'#3874f2',color:options.selectedColor||'white'}:null;
  const caretAt = (at, selected=false) => {
    let span=carets.get(element);
    if(!span){span=element.ownerDocument.createElement('span');carets.set(element,span);inputOwner.set(span,element);}
    const height=options.height||parseFloat(style.fontSize)||16;
    const color=options.color||style.color;
    const on=!selected&&options.on!==false&&options.visible!==false;
    span.style.cssText=`display:inline-block;width:0;height:${height}px;border-left:1px solid ${on?color:'transparent'};margin-right:-1px;vertical-align:text-bottom;pointer-events:none`;
    return make('caret','inline-block',{tagName:'SPAN',style:computeElementStyle(span,style),children:Object.freeze([])},span);
  };
  if (!raw) {
    if(!focused||element.disabled||options.visible===false)return null;
    const node=(part,text)=>make(part,'text',{text,style,valueStart:part==='after'?start:0,pseudo:'value',children:Object.freeze([])},element);
    return [node('before',text.slice(0,start)),caretAt(start),node('after',text.slice(start))];
  }
  const { background, color } = raw;
  const from = Math.max(0, Math.min(text.length, start)),
    to = Math.max(from, Math.min(text.length, end));
  if (from === to) return null;
  const textNode = (part, text, textStyle = style, domNode = element) => make(part, 'text', {
    text, style: textStyle, valueStart:part==='selected'?from:part==='after'?to:0, pseudo: 'value', children: Object.freeze([]),
  }, domNode);
  let span = spans.get(element);
  if (!span) { span = element.ownerDocument.createElement('span'); spans.set(element, span); inputOwner.set(span,element); }
  span.style.pointerEvents = 'none';
  span.style.backgroundColor = background;
  span.style.color = color;
  const selectedStyle = computeElementStyle(span, style);
  const children = [];
  if (from) children.push(textNode('before', text.slice(0, from)));
  if(focused&&element.selectionDirection==='backward')children.push(caretAt(from,true));
  children.push(make('selection', 'inline', {
    tagName: 'SPAN', style: selectedStyle,
    children: Object.freeze([textNode('selected', text.slice(from, to), selectedStyle, span)]),
  }, span));
  if(focused&&element.selectionDirection!=='backward')children.push(caretAt(to,true));
  if (to < text.length) children.push(textNode('after', text.slice(to)));
  return children;
}
