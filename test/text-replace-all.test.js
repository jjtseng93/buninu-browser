import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {createDetachedDocument} from '../lib/renderer/document-constructor.js';
import * as S from '../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

const tick=()=>new Promise(resolve=>queueMicrotask(resolve));
const observe=(window,target,options={childList:true})=>{
  const observer=new window.MutationObserver(()=>{});observer.observe(target,options);return observer;
};
const expectRecord=(record,target,removed,added)=>{
  expect(record.type).toBe('childList');expect(record.target).toBe(target);
  expect(record.removedNodes).toEqual(removed);expect(record.addedNodes).toEqual(added);
  expect([record.previousSibling,record.nextSibling,record.oldValue,record.attributeName,record.attributeNamespace]).toEqual([null,null,null,null,null]);
};

test('textContent replaces all child kinds with one atomic record, including equal text and empty values',async()=>{
  const f=parseHTMLDocument('<!doctype html><body></body>');
  try{
    const xml=createDetachedDocument(f.window,{contentType:'application/xml'});
    const host=f.document.createElement('div');f.document.body.appendChild(host);
    const parents=[f.document.createElement('div'),f.document.createDocumentFragment(),host.attachShadow({mode:'open'}),
      f.document.createElement('form'),f.document.createElement('select'),xml.createElement('root')];
    for(const parent of parents){
      const doc=parent.ownerDocument;
      const children=[doc.createTextNode('same'),doc.createComment('comment'),doc.createElement('span')];
      if(doc===xml)children.push(xml.createCDATASection('same'));
      for(const child of children)parent.appendChild(child);
      const observer=observe(f.window,parent);
      parent.textContent='same';let records=observer.takeRecords();
      expect(records).toHaveLength(1);expectRecord(records[0],parent,children,[parent.firstChild]);
      expect(parent.firstChild.nodeType).toBe(3);expect(parent.firstChild.data).toBe('same');
      for(const child of children)expect(child.parentNode).toBeNull();
      const previous=parent.firstChild;
      parent.textContent='same';records=observer.takeRecords();
      expect(records).toHaveLength(1);expectRecord(records[0],parent,[previous],[parent.firstChild]);
      expect(parent.firstChild).not.toBe(previous);
      const last=parent.firstChild;parent.textContent=null;records=observer.takeRecords();
      expect(records).toHaveLength(1);expectRecord(records[0],parent,[last],[]);
      parent.textContent='';parent.textContent=undefined;expect(observer.takeRecords()).toEqual([]);
      observer.disconnect();
    }
  }finally{await f.window.happyDOM.close();}
});

test('separate writes, borrowed Node setters and conversion reentry retain independent record order',async()=>{
  const f=parseHTMLDocument('<div>before</div>');
  try{
    const parent=f.document.querySelector('div'),initial=parent.firstChild,observer=observe(f.window,parent);
    const setter=Object.getOwnPropertyDescriptor(f.window.Node.prototype,'textContent').set;
    let conversions=0;
    setter.call(parent,{toString(){conversions++;parent.textContent='inner';return 'outer'}});
    const records=observer.takeRecords();expect(conversions).toBe(1);expect(records).toHaveLength(2);
    expectRecord(records[0],parent,[initial],[records[1].removedNodes[0]]);
    expectRecord(records[1],parent,[records[0].addedNodes[0]],[parent.firstChild]);
    const marker={};let caught;
    try{parent.textContent={toString(){throw marker}}}catch(error){caught=error}
    expect(caught).toBe(marker);expect(observer.takeRecords()).toEqual([]);expect(parent.textContent).toBe('outer');
    const added=f.document.createElement('b');parent.appendChild(added);parent.removeChild(added);
    expect(observer.takeRecords()).toHaveLength(2);observer.disconnect();
  }finally{await f.window.happyDOM.close();}
});

test('subtree transients survive atomic replacement and takeRecords until observer notification',async()=>{
  const f=parseHTMLDocument('<div><span><b></b></span></div>');
  try{
    const parent=f.document.querySelector('div'),child=parent.firstChild,descendant=child.firstChild;
    const observer=observe(f.window,parent,{childList:true,attributes:true,subtree:true});
    observer.observe(child,{attributes:true});
    parent.textContent='replacement';const records=observer.takeRecords();
    expect(records).toHaveLength(1);expectRecord(records[0],parent,[child],[parent.firstChild]);
    descendant.setAttribute('before','yes');expect(observer.takeRecords().map(r=>r.attributeName)).toEqual(['before']);
    await tick();descendant.setAttribute('after','no');expect(observer.takeRecords()).toEqual([]);
    child.setAttribute('direct','yes');expect(observer.takeRecords().map(r=>r.attributeName)).toEqual(['direct']);
    observer.disconnect();
    parent.textContent='again';const text=parent.firstChild;
    const onlyData=observe(f.window,parent,{subtree:true,characterData:true,characterDataOldValue:true});
    parent.textContent='new';text.data='detached';expect(onlyData.takeRecords().map(r=>r.oldValue)).toEqual(['again']);
    await tick();text.data='ignored';expect(onlyData.takeRecords()).toEqual([]);onlyData.disconnect();
  }finally{await f.window.happyDOM.close();}
});

test('custom reactions observe the completed DOM and record before author reentry',async()=>{
  const f=parseHTMLDocument('<main></main>');
  try{
    const parent=f.document.querySelector('main'),seen=[];let observer;
    f.window.customElements.define('removed-child',class extends f.window.HTMLElement{
      disconnectedCallback(){
        seen.push(parent.textContent,observer.takeRecords());
        parent.textContent='nested';
        this.setAttribute('detached','yes');
      }
    });
    const child=f.document.createElement('removed-child');parent.appendChild(child);
    observer=observe(f.window,parent,{childList:true,attributes:true,subtree:true});
    parent.textContent='whole';expect(seen[0]).toBe('whole');expect(seen[1]).toHaveLength(1);
    const firstAdded=seen[1][0].addedNodes[0];expectRecord(seen[1][0],parent,[child],[firstAdded]);
    const records=observer.takeRecords();expect(records).toHaveLength(2);
    expectRecord(records[0],parent,[firstAdded],[parent.firstChild]);
    expect([records[1].type,records[1].target,records[1].attributeName]).toEqual(['attributes',child,'detached']);
    expect(parent.textContent).toBe('nested');observer.disconnect();
  }finally{await f.window.happyDOM.close();}
});

test('queued custom reactions retain per-element order across reentry and report exceptions',async()=>{
  const f=parseHTMLDocument('<main></main>');
  try{
    const parent=f.document.querySelector('main'),events=[];let second;
    f.window.addEventListener('error',e=>{events.push(e.message);e.preventDefault()});
    f.window.customElements.define('first-child',class extends f.window.HTMLElement{
      disconnectedCallback(){events.push('first removed');parent.appendChild(second);throw Error('reaction marker')}
    });
    f.window.customElements.define('second-child',class extends f.window.HTMLElement{
      connectedCallback(){events.push('second connected')}
      disconnectedCallback(){events.push('second removed')}
    });
    parent.appendChild(f.document.createElement('first-child'));second=f.document.createElement('second-child');parent.appendChild(second);
    events.length=0;parent.textContent='new';
    expect(events).toEqual(['first removed','second removed','second connected','reaction marker']);
    const observer=observe(f.window,parent);parent.textContent='again';expect(observer.takeRecords()).toHaveLength(1);observer.disconnect();
  }finally{await f.window.happyDOM.close();}
});

test('native mutation hooks remain active and interrupted operations restore their scopes',async()=>{
  const f=parseHTMLDocument('<style>body{color:red}</style><textarea>abcdef</textarea><div><b></b></div>');
  try{
    const area=f.document.querySelector('textarea');area.setSelectionRange(2,5);area.textContent='x';
    expect([area.value,area.defaultValue,area.selectionStart,area.selectionEnd]).toEqual(['x','x',0,0]);
    const style=f.document.querySelector('style');style.textContent='body{color:blue}';expect(style.sheet.cssRules[0].style.color).toBe('blue');
    const parent=f.document.querySelector('div'),old=parent.firstChild,observer=observe(f.window,parent),marker={};
    const disconnect=old[S.disconnectedFromNode];
    old[S.disconnectedFromNode]=function(){disconnect.call(this);throw marker};
    let caught;try{parent.textContent='fails'}catch(error){caught=error}
    expect(caught).toBe(marker);expect(observer.takeRecords()).toHaveLength(1);
    parent.textContent='after';const records=observer.takeRecords();expect(records).toHaveLength(1);
    expectRecord(records[0],parent,[],[parent.firstChild]);observer.disconnect();
  }finally{await f.window.happyDOM.close();}
});

test('replace-all signals affected slots once after observer records and completed DOM',async()=>{
  const f=parseHTMLDocument('<div>old</div>');
  try{
    const parent=f.document.querySelector('div'),shadow=parent.attachShadow({mode:'open'});
    shadow.innerHTML='<slot></slot>';await tick();const slot=shadow.firstChild,events=[];
    const observer=new f.window.MutationObserver(records=>events.push(['mutation',records.length,parent.textContent]));
    observer.observe(parent,{childList:true});slot.addEventListener('slotchange',()=>events.push(['slot',parent.textContent]));
    parent.textContent='new';expect(events).toEqual([]);await tick();
    expect(events).toEqual([['mutation',1,'new'],['slot','new']]);observer.disconnect();
  }finally{await f.window.happyDOM.close();}
});

test('signaled slots survive removal, deduplicate across writes, and follow later observer registration',async()=>{
  const f=parseHTMLDocument('<div>old</div>');
  try{
    const parent=f.document.querySelector('div'),shadow=parent.attachShadow({mode:'open'});
    shadow.innerHTML='<slot></slot>';const slot=shadow.firstChild,events=[];
    slot.addEventListener('slotchange',()=>events.push('slot'));
    parent.textContent='first';parent.textContent='second';
    const observer=new f.window.MutationObserver(()=>events.push('observer'));
    observer.observe(parent,{attributes:true});parent.setAttribute('x','1');
    parent.remove();await tick();expect(events).toEqual(['observer','slot']);observer.disconnect();
  }finally{await f.window.happyDOM.close();}
});

test('removal and window teardown inside reactions leave no queued observers or active scopes',async()=>{
  const f=parseHTMLDocument('<main></main>'),other=parseHTMLDocument('<div>old</div>');
  try{
    const parent=f.document.querySelector('main'),events=[];let closing;
    f.window.customElements.define('dispose-child',class extends f.window.HTMLElement{
      disconnectedCallback(){events.push(parent.textContent);parent.remove();closing=f.window.happyDOM.close()}
    });
    parent.appendChild(f.document.createElement('dispose-child'));
    const observer=new f.window.MutationObserver(()=>events.push('unexpected notification'));
    observer.observe(parent,{childList:true,subtree:true});parent.textContent='done';
    await closing;await tick();expect(events).toEqual(['done']);expect(observer.takeRecords()).toEqual([]);
    const target=other.document.querySelector('div'),independent=observe(other.window,target);
    target.textContent='after disposal';expect(independent.takeRecords()).toHaveLength(1);independent.disconnect();
  }finally{await f.window.happyDOM.close();await other.window.happyDOM.close();}
});

test('queued disconnect reactions retain their callback when an earlier reaction adopts the element',async()=>{
  const f=parseHTMLDocument('<main></main>');
  try{
    const parent=f.document.querySelector('main'),other=f.document.implementation.createHTMLDocument(),events=[];
    let second;
    f.window.customElements.define('adopting-first',class extends f.window.HTMLElement{
      disconnectedCallback(){events.push('first');other.adoptNode(second)}
    });
    f.window.customElements.define('adopted-second',class extends f.window.HTMLElement{
      disconnectedCallback(){events.push('second');expect(this.ownerDocument).toBe(other)}
    });
    parent.appendChild(f.document.createElement('adopting-first'));
    second=f.document.createElement('adopted-second');parent.appendChild(second);
    parent.textContent='complete';
    expect(events).toEqual(['first','second']);expect(parent.textContent).toBe('complete');
  }finally{await f.window.happyDOM.close();}
});

test('reaction slot mutations coalesce with replace-all while author dispatch stays synchronous',async()=>{
  const f=parseHTMLDocument('<div></div>');
  try{
    const parent=f.document.querySelector('div'),shadow=parent.attachShadow({mode:'open'});
    shadow.innerHTML='<slot></slot>';const slot=shadow.firstChild,events=[];
    f.window.customElements.define('slot-reentry-child',class extends f.window.HTMLElement{
      disconnectedCallback(){
        events.push('disconnected');parent.appendChild(f.document.createElement('span'));
        slot.dispatchEvent(new f.window.Event('slotchange',{cancelable:true}));
        events.push('callback-end');
      }
    });
    parent.appendChild(f.document.createElement('slot-reentry-child'));await tick();
    slot.addEventListener('slotchange',event=>events.push(event.cancelable?'author':'slot'));
    const observer=new f.window.MutationObserver(()=>events.push('observer'));
    observer.observe(parent,{childList:true});parent.textContent='new';events.push('setter-end');
    expect(events).toEqual(['disconnected','author','callback-end','setter-end']);
    await tick();expect(events).toEqual(['disconnected','author','callback-end','setter-end','observer','slot']);
    observer.disconnect();
  }finally{await f.window.happyDOM.close();}
});

test('observer-induced slot changes notify in the next batch after the current slot snapshot',async()=>{
  const f=parseHTMLDocument('<div>old</div>');
  try{
    const parent=f.document.querySelector('div'),shadow=parent.attachShadow({mode:'open'});
    shadow.innerHTML='<slot></slot>';const slot=shadow.firstChild,events=[];await tick();
    slot.addEventListener('slotchange',()=>events.push('slot'));
    let first=true;
    const observer=new f.window.MutationObserver(()=>{
      events.push('observer-start');
      if(first){first=false;parent.appendChild(f.document.createElement('span'))}
      events.push('observer-end');
    });
    observer.observe(parent,{childList:true});parent.textContent='new';
    await tick();await tick();
    expect(events).toEqual(['observer-start','observer-end','slot','observer-start','observer-end','slot']);
    observer.disconnect();
  }finally{await f.window.happyDOM.close();}
});

test('native slot/name attribute changes share async delivery and preserve synthetic events',async()=>{
  const f=parseHTMLDocument('<div><span></span></div>');
  try{
    const parent=f.document.querySelector('div'),child=parent.firstChild,shadow=parent.attachShadow({mode:'open'});
    shadow.innerHTML='<slot></slot><slot name="named"></slot>';const [fallback,named]=shadow.children,events=[];
    await tick();fallback.addEventListener('slotchange',()=>events.push('default'));
    named.addEventListener('slotchange',()=>events.push('named'));
    child.slot='named';child.removeAttribute('slot');child.slot='named';
    expect(events).toEqual([]);await tick();expect(events).toEqual(['default','named']);
    events.length=0;named.name='other';expect(events).toEqual([]);await tick();expect(events).toEqual(['named']);
    events.length=0;named.dispatchEvent(new f.window.Event('slotchange'));expect(events).toEqual(['named']);
  }finally{await f.window.happyDOM.close();}
});

test('a failing slot listener is reported without interrupting bubbling or the remaining slot batch',async()=>{
  const f=parseHTMLDocument('<div>old</div><div>old</div>');
  try{
    const [first,second]=f.document.querySelectorAll('div'),events=[];
    const a=first.attachShadow({mode:'open'}),b=second.attachShadow({mode:'open'});
    a.innerHTML='<slot></slot>';b.innerHTML='<slot></slot>';await tick();
    f.window.addEventListener('error',event=>{events.push(event.message);event.preventDefault()});
    a.firstChild.addEventListener('slotchange',()=>{throw Error('slot marker')});
    a.addEventListener('slotchange',()=>events.push('bubble'));
    b.firstChild.addEventListener('slotchange',()=>events.push('second'));
    const observer=new f.window.MutationObserver(()=>events.push('observer'));
    observer.observe(f.document.body,{childList:true,subtree:true});
    first.textContent='first';second.textContent='second';await tick();
    expect(events).toEqual(['observer','slot marker','bubble','second']);observer.disconnect();
  }finally{await f.window.happyDOM.close();}
});
