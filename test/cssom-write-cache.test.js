import {test,expect} from 'bun:test';
import {createInertWindow} from '../lib/happy-dom/parser.js';
import {BindingRealm,ruleStyleBinding} from '../lib/renderer/bindings.js';
import {cssDeclarationRevision} from '../lib/happy-dom/css-declaration-mutations.js';
import Manager from '../vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts';
import * as S from '../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

function fixture(run) {
  const window=createInertWindow(),element=window.document.createElement('div');
  window.document.body.append(element);
  try{return run({window,element});}finally{window.happyDOM.close();}
}

test('repeated style writes reuse serialization without losing real changes or mutation old values',()=>fixture(({window,element})=>{
  let notifications=0,clones=0;
  const realm=new BindingRealm(window,{touch(){notifications++;}}),s=realm.wrap(element).style;
  s.cssText='position:absolute;left:0px;border:2px solid red;padding:4px;margin:0px';
  // Let the first assignment settle declaration order before testing no-ops.
  s.left='0px';s.cssText;notifications=0;
  const observer=new window.MutationObserver(()=>{});
  observer.observe(element,{attributes:true,attributeOldValue:true});
  const original=Manager.prototype.clone;
  Manager.prototype.clone=function(){clones++;return original.call(this);};
  try {
    for(let i=0;i<100;i++) {s.left='0px';s.getPropertyValue('left');s.cssText;}
    expect(clones).toBe(0);
    expect(notifications).toBe(0);
    expect(observer.takeRecords()).toHaveLength(0);
    const old=element.getAttribute('style');
    s.left='5px';
    expect(s.left).toBe('5px');expect(notifications).toBe(1);
    expect(observer.takeRecords().map(record=>record.oldValue)).toEqual([old]);
    expect(s.cssText).toContain('left: 5px;');
    s.removeProperty('unknown-property');expect(notifications).toBe(1);
    s.removeProperty('left');expect(notifications).toBe(2);expect(s.left).toBe('');
  }finally{Manager.prototype.clone=original;observer.disconnect();}
}));

test('cached serialization observes direct record edits and independent clone mutations',()=>{
  const manager=new Manager({cssText:'left:1px;border:2px solid red;padding:3px;overflow:var(--flow)'});
  const compare=()=>expect(manager.toString()).toBe(manager.clone().toString());
  compare();
  manager.properties.left.value='8px';compare();expect(manager.toString()).toContain('left: 8px;');
  manager.properties.left.important=true;compare();expect(manager.toString()).toContain('left: 8px !important;');
  manager.properties['overflow-x'].overflowSource='var(--other)';compare();
  manager.properties['overflow-y'].overflowSource='var(--other)';compare();
  expect(manager.toString()).toContain('overflow: var(--other);');
  manager.properties.left.declarationOrder=10000;compare();
  const before=manager.toString(),clone=manager.clone();
  clone.toString();clone.properties.left.value='19px';
  expect(clone.toString()).toContain('left: 19px !important;');expect(manager.toString()).toBe(before);
  const p=manager.properties.left;delete manager.properties.left;manager.properties.left=p;compare();
});

test('cache keeps cascade order, pending provenance and direct style-attribute reparsing',()=>fixture(({element})=>{
  const s=element.style;
  for(const source of [
    'padding:1px;all:initial;padding-left:2px;margin-inline:3px;margin-left:4px',
    'border:var(--edge);border-left-width:5px;overflow:var(--flow);overflow-x:clip',
    'font:italic 12px serif;background:red;border-radius:3px;place-items:center',
  ]) {
    s.cssText=source;
    const manager=s[S.getPropertyManager]();
    for(const [name,value,priority] of [['padding-left','9px','important'],['border-color','blue',''],['margin-inline','7px',''],['left','3px','']]) {
      s.cssText; s.setProperty(name,value,priority);
      expect(s.cssText).toBe(manager.clone().toString());
      s.removeProperty(name);expect(s.cssText).toBe(manager.clone().toString());
    }
  }
  s.cssText='border:var(--first);border-left-width:5px';
  const revision=cssDeclarationRevision(s),before=s.cssText;
  s.border='var(--second)';s.borderLeftWidth='5px';
  expect(s.cssText).toBe(before);expect(cssDeclarationRevision(s)).toBeGreaterThan(revision);
  const manager=s[S.getPropertyManager]();
  element.setAttribute('style',s.cssText);
  expect(s[S.getPropertyManager]()).not.toBe(manager);
  expect(Object.values(s[S.getPropertyManager]().properties).some(p=>p.pendingBorder)).toBe(false);
}));

test('rule notifications and reentrant value conversion use the shared CSSOM revision',()=>fixture(({window,element})=>{
  const realm=new BindingRealm(window,{touch(){}});
  let changes=0;
  const s=ruleStyleBinding(element.style,realm,{},()=>changes++);
  s.cssText='left:0px;border:var(--first);border-left-width:5px';
  const before=s.cssText;
  s.border='var(--second)';s.borderLeftWidth='5px';
  expect(s.cssText).toBe(before);expect(changes).toBe(3);
  s.left={toString(){s.setProperty('color','red');return '5px';}};
  expect(s.left).toBe('5px');expect(s.color).toBe('red');expect(changes).toBe(5);
  s.removeProperty('missing');expect(changes).toBe(5);
  expect(()=>{s.left={toString(){throw Error('conversion');}};}).toThrow('conversion');
  expect(s.left).toBe('5px');expect(changes).toBe(5);
}));

test('changing inline styles serialize without cloning a whole declaration',()=>fixture(({element})=>{
  const s=element.style;
  s.cssText='position:absolute;left:0px;border:2px solid red;padding:4px;margin:0px;font:italic 14px serif;border-radius:4px';
  const original=Manager.prototype.clone;
  let clones=0;
  Manager.prototype.clone=function(){clones++;return original.call(this);};
  try {
    for(let i=1;i<=50;i++) {
      s.left=i+'px';
      expect(s.cssText).toContain(`left: ${i}px;`);
      expect(s.cssText).toContain('border-radius: 4px;');
      expect(s.cssText).toContain('font: italic 14px serif;');
    }
    expect(clones).toBe(0);
  }finally{Manager.prototype.clone=original;}
}));

test('border image shorthand selection preserves border reset and declaration order',()=>fixture(({element})=>{
  const s=element.style;
  s.cssText='border:2px solid red;all:initial;border-image:initial';
  expect(s.cssText).toBe('border-top: 2px solid red; border-right: 2px solid red; border-bottom: 2px solid red; border-left: 2px solid red; all: initial; border-image-source: initial; border-image-slice: initial; border-image-width: initial; border-image-outset: initial; border-image-repeat: initial;');
  s.cssText='padding:2px;border-image:initial';
  expect(s.cssText).toBe('padding: 2px; border-image: initial;');
}));
