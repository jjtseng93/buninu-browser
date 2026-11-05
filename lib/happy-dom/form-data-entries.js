import {formControls} from './form-association.js';
import {actuallyDisabled, optionDisabled} from './form-disabled.js';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

const html = 'http://www.w3.org/1999/xhtml';
const isHTML = (node, name) => node?.namespaceURI === html && node.localName === name;
const attr = (node, name) => node.getAttributeNS(null, name);
const constructing = new WeakSet();
const wellFormed = String.prototype.toWellFormed;
const scalar = text => wellFormed.call(text);
const buttons = new Set(['button', 'submit', 'reset', 'image']);

// Explicit HTML directionality inherits through the DOM, independently of
// CSS direction. The dir=auto Unicode first-strong/tree-exclusion algorithm
// remains a separate directionality feature; do not guess by script ranges.
function direction(field) {
  for (let node=field;node;node=node.parentElement) {
    if(node.namespaceURI!==html)continue;
    const dir=(attr(node,'dir')??'').toLowerCase();
    if(dir==='ltr'||dir==='rtl')return dir;

  }
  return 'ltr';
}

// Callback boundaries keep native documents independent of any particular
// page realm. The event's mutable FormData is snapshotted only after dispatch.
export function constructFormEntries(form, submitter, {File, dispatch, encoding='UTF-8'} = {}) {
  const identity=form[S.proxy]??form;
  if(constructing.has(identity))return null;
  constructing.add(identity);
  try {
    const entries=[];
    const append=(name,value)=>entries.push([scalar(name),typeof value==='string'?scalar(value):value]);
    for(const field of formControls(form,{includeImages:true})) {
      if(!['input','select','textarea','button'].includes(field.localName)||actuallyDisabled(field))continue;
      let datalist=false;for(let p=field.parentElement;p;p=p.parentElement)if(isHTML(p,'datalist')){datalist=true;break;}
      if(datalist)continue;
      const type=field.type;
      if((isHTML(field,'button')||(isHTML(field,'input')&&buttons.has(type)))&&field!==submitter)continue;
      if(isHTML(field,'input')&&(type==='checkbox'||type==='radio')&&!field.checked)continue;
      const name=attr(field,'name')??'';
      if(isHTML(field,'input')&&type==='image') {
        const prefix=name?name+'.':'';
        // No image activation position has been recorded by the current input
        // pipeline; programmatic/unactivated image submission has origin (0,0).
        append(prefix+'x','0');append(prefix+'y','0');continue;
      }
      if(!name)continue;
      if(isHTML(field,'select')) {
        for(const option of field.options)if(option.selected&&!optionDisabled(option))append(name,option.value);
      } else if(isHTML(field,'input')&&(type==='checkbox'||type==='radio')) append(name,attr(field,'value')??'on');
      else if(isHTML(field,'input')&&type==='file') {
        const files=field.files;
        if(files.length)for(const file of files)append(name,file);
        else append(name,new File([],'',{type:'application/octet-stream'}));
      } else if(isHTML(field,'input')&&type==='hidden'&&name.toLowerCase()==='_charset_')append(name,encoding);
      else append(name,field.value);
      const dirname=attr(field,'dirname');
      if(dirname&&(isHTML(field,'textarea')||(isHTML(field,'input')&&['text','search','tel','url','email','hidden'].includes(type))))append(dirname,direction(field));
    }
    return dispatch?dispatch(entries):entries;
  } finally {constructing.delete(identity);}
}
