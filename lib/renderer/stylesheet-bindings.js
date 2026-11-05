import {parseCSSOMRules, renderRuleText} from './stylesheet-parser.js';
import * as symbols from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import {ruleStyleBinding} from './bindings.js';
import {associatedSheet, associateSheet} from './stylesheet-state.js';

// Wrap the existing parser's objects; never forward raw DOM/parser properties.
export function createStyleSheetBindings(window, realm, getSource) {
  const sheetStates=new WeakMap(), ruleStates=new WeakMap();
  const fail=(name,message)=>{throw new DOMException(message,name);};
  const list=(read,wrap)=>new Proxy(Object.create(null),{
    get(_target,key){
      if(key==='length')return read().length;
      if(key==='item')return index=>wrap(read()[+index>>>0])??null;
      if(key===Symbol.iterator)return function*(){for(const item of read())yield wrap(item);};
      if(typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key))return wrap(read()[Number(key)]);
    },
    has(_target,key){return key==='length'||key==='item'||(typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)&&Number(key)<read().length);},
    set(){return false;},
    ownKeys(){return [...read().keys()].map(String);},
    getOwnPropertyDescriptor(_target,key){if(typeof key==='string'&&/^(0|[1-9]\d*)$/.test(key)&&Number(key)<read().length)return {value:wrap(read()[+key]),enumerable:true,configurable:true};},
  });
  function state(sheet){const s=sheetStates.get(sheet);if(!s)throw new TypeError('Illegal invocation');return s;}
  function readable(s){if(!s.readable)fail('SecurityError','Stylesheet is not origin-clean');return s;}
  function changed(s){
    s.changed=true;s.text=s.raw.cssRules.map(renderRuleText).join('\n');
    realm.hooks.touch(s.owner);
  }
  function wrapRule(raw,s,parent=null){
    if(!raw)return undefined;
    let result=s.rules.get(raw);if(result)return result;
    const Proto=raw.type===1?CSSStyleRule.prototype:raw.type===12?CSSSupportsRule.prototype:raw.type===4?CSSMediaRule.prototype:raw.cssRules?CSSGroupingRule.prototype:CSSRule.prototype;
    result=Object.create(Proto);s.rules.set(raw,result);
    ruleStates.set(result,{raw,s,parent,list:null,style:null});return result;
  }
  function insert(raw,s,text,index,parent){
    const position=+index>>>0;
    if(position>raw.cssRules.length)fail('IndexSizeError','Rule index out of range');
    // Parse in isolation before mutating the target; exactly one rule is required.
    const parsed=parseCSSOMRules(window,''+text,s.raw,parent);
    if(parsed.length!==1)fail('SyntaxError','Expected one CSS rule');
    const rule=parsed[0];
    if(rule.type===3&&s.constructed)fail('SyntaxError','Constructed sheets cannot contain @import');
    rule[symbols.parentStyleSheet]=s.raw;
    rule[symbols.parentRule]=parent;
    raw.cssRules.splice(position,0,rule);changed(s);return position;
  }
  function remove(raw,s,index){const position=+index>>>0;if(position>=raw.cssRules.length)fail('IndexSizeError','Rule index out of range');raw.cssRules.splice(position,1);changed(s);}
  class CSSRule {
    constructor(){throw new TypeError('Illegal constructor');}
    get type(){const type=ruleStates.get(this).raw.type;return type>=16?0:type;}
    get cssText(){return ruleStates.get(this).raw.cssText;}
    get parentRule(){return ruleStates.get(this).parent;}
    get parentStyleSheet(){return ruleStates.get(this).s.view;}
  }
  class CSSGroupingRule extends CSSRule {
    get cssRules(){const r=ruleStates.get(this);return r.list??=list(()=>r.raw.cssRules,raw=>wrapRule(raw,r.s,this));}
    insertRule(text,index=0){if(!arguments.length)throw new TypeError('insertRule requires a rule');const r=ruleStates.get(this);return insert(r.raw,r.s,text,index,r.raw);}
    deleteRule(index){if(!arguments.length)throw new TypeError('deleteRule requires an index');const r=ruleStates.get(this);remove(r.raw,r.s,index);}
  }
  class CSSStyleRule extends CSSGroupingRule {
    get selectorText(){return ruleStates.get(this).raw.selectorText;}
    set selectorText(value){
      const r=ruleStates.get(this),parsed=new window.CSSStyleSheet();parsed.replaceSync(`${value} {}`);
      if(parsed.cssRules.length!==1||parsed.cssRules[0].type!==1)return;
      r.raw[symbols.selectorText]=parsed.cssRules[0].selectorText;changed(r.s);
    }
    get style(){const r=ruleStates.get(this);return r.style??=ruleStyleBinding(r.raw.style,realm,this,()=>changed(r.s));}
  }
  class CSSSupportsRule extends CSSGroupingRule {get conditionText(){return ruleStates.get(this).raw.conditionText;}}
  class CSSMediaRule extends CSSGroupingRule {get conditionText(){return ruleStates.get(this).raw.conditionText;}}
  class CSSStyleSheet {
    constructor(){initialize(this,{constructed:true,source:'',owner:null,readable:true,href:null});}
    get cssRules(){return readable(state(this)).list;}
    get rules(){return this.cssRules;}
    get type(){return 'text/css';}
    get ownerNode(){return realm.wrap(state(this).owner);}
    get href(){return state(this).href;}
    get title(){return state(this).owner?.getAttribute('title')??null;}
    get parentStyleSheet(){return null;}
    get ownerRule(){return null;}
    get disabled(){const s=state(this);return s.owner ? Boolean(s.owner.disabled) : s.disabled;}
    set disabled(value){const s=state(this);s.disabled=Boolean(value);if(s.owner)s.owner.disabled=s.disabled;realm.hooks.touch(s.owner);}
    get media(){return state(this).media;}
    insertRule(text,index=0){if(!arguments.length)throw new TypeError('insertRule requires a rule');const s=readable(state(this));return insert(s.raw,s,text,index,null);}
    deleteRule(index){if(!arguments.length)throw new TypeError('deleteRule requires an index');const s=readable(state(this));remove(s.raw,s,index);}
    replaceSync(text){
      const s=state(this);if(!s.constructed)fail('NotAllowedError','Only constructed sheets can be replaced');
      if(!arguments.length)throw new TypeError('replaceSync requires text');
      const parsed=parseCSSOMRules(window,''+text,s.raw);
      s.raw.cssRules.splice(0,s.raw.cssRules.length,...parsed.filter(r=>r.type!==3));changed(s);
    }
    async replace(text){if(!arguments.length)throw new TypeError('replace requires text');this.replaceSync(text);return this;}
  }
  function initialize(view,options){
    const raw={cssRules:[]};raw.cssRules=parseCSSOMRules(window,options.source,raw);
    const s={...options,raw,view,disabled:false,changed:false,text:options.source,rules:new WeakMap()};
    s.list=list(()=>s.raw.cssRules,rule=>wrapRule(rule,s));
    const readMedia=()=>s.owner?.getAttribute('media')??'';
    s.media={get mediaText(){return readMedia();},set mediaText(value){if(s.owner){s.owner.setAttribute('media',''+value);realm.hooks.touch(s.owner);}},get length(){return readMedia().split(',').filter(x=>x.trim()).length;},item(i){return readMedia().split(',').map(x=>x.trim()).filter(Boolean)[+i>>>0]??'';}};
    sheetStates.set(view,s);return s;
  }
  function sheetFor(node){
    const source=getSource(node);if(!source)return null;
    let s=associatedSheet(node);
    if(!s||!sheetStates.has(s.view)||s.source!==source.text||s.href!==source.href){
      const view=Object.create(CSSStyleSheet.prototype);
      s=initialize(view,{constructed:false,source:source.text,owner:node,href:source.href,readable:source.readable});
      associateSheet(node,s);
    }
    return s.view;
  }
  for(const [name,type] of Object.entries({STYLE_RULE:1,IMPORT_RULE:3,MEDIA_RULE:4,FONT_FACE_RULE:5,PAGE_RULE:6,KEYFRAMES_RULE:7,KEYFRAME_RULE:8,NAMESPACE_RULE:10,SUPPORTS_RULE:12})){
    Object.defineProperty(CSSRule,name,{value:type});Object.defineProperty(CSSRule.prototype,name,{value:type});
  }
  const documentLists=new WeakMap();
  function sheetsFor(document){
    let sheets=documentLists.get(document);
    if(!sheets){sheets=list(()=>[...document.querySelectorAll('style, link[rel~="stylesheet"]')].map(sheetFor).filter(Boolean),value=>value);documentLists.set(document,sheets);}
    return sheets;
  }
  return {CSSRule,CSSStyleRule,CSSGroupingRule,CSSSupportsRule,CSSMediaRule,CSSStyleSheet,sheetFor,sheetsFor};
}
