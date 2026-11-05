import {beforeAll, afterAll, test, expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

let host;
beforeAll(async () => {
  host = new RendererHost({timeout:20000});
  await host.start();
  await host.call('loadDocument', {url:'https://test.local/',contentType:'text/html',source:'<!doctype html><body></body>'});
  await host.call('whenLoaded');
});
afterAll(() => host?.close());
const evaluate = source => host.call('evaluate', source);

test('activation-generated input/change are trusted, while click() and redispatch remain synthetic', async () => {
  expect(await evaluate(`(() => {
    const result=[];
    for (const kind of ['node','window','target','init']) {
      const r=document.createElement('input');r.type='radio';document.body.append(r);
      let captured;
      r.addEventListener('click',e=>result.push(e.isTrusted));
      r.addEventListener('input',e=>{captured=e;result.push(e.isTrusted)});
      r.addEventListener('change',e=>result.push(e.isTrusted));
      r.click();
      const target=kind==='node'?document.body:kind==='window'?window:new EventTarget();
      if(kind==='init') captured.initEvent('input');
      else target.dispatchEvent(captured);
      result.push(captured.isTrusted);r.remove();
    }
    return result;
  })()`)).toEqual(Array.from({length:4},()=>[false,true,true,false]).flat());
});

test('legacy events need initialization, but an empty type passed to Event is initialized', async () => {
  expect(await evaluate(`(() => {
    const result=[];
    for (const target of [document,window,new EventTarget()]) {
      const e=document.createEvent('Event');
      try{target.dispatchEvent(e);result.push('accepted')}catch(error){result.push(error.name)}
      e.initEvent('');result.push(target.dispatchEvent(e));
      result.push(target.dispatchEvent(new Event('')));
    }
    return result;
  })()`)).toEqual(Array.from({length:3},()=>['InvalidStateError',true,true]).flat());
});

test('dispatching again during a listener throws without changing the original trusted event', async () => {
  expect(await evaluate(`(() => {
    const r=document.createElement('input');r.type='radio';document.body.append(r);const result=[];
    r.addEventListener('input',e=>{
      for(const target of [r,window,new EventTarget()]) {
        try{target.dispatchEvent(e);result.push('accepted')}catch(error){result.push(error.name)}
        result.push(e.isTrusted);
      }
      e.initEvent('changed');result.push(e.type,e.isTrusted);
    });
    r.click();r.remove();return result;
  })()`)).toEqual(['InvalidStateError',true,'InvalidStateError',true,'InvalidStateError',true,'input',true]);
});

test('invalid dispatch receivers cannot clear another event trust flag', async () => {
  expect(await evaluate(`(() => {
    const r=document.createElement('input');r.type='radio';document.body.append(r);let captured;
    r.oninput=e=>{captured=e};r.click();r.remove();
    let name;try{EventTarget.prototype.dispatchEvent.call({},captured)}catch(error){name=error.name}
    return [name,captured.isTrusted];
  })()`)).toEqual(['TypeError',true]);
});

test('legacy initializers do not invoke page-overridden initializer methods', async () => {
  expect(await evaluate(`(() => {
    let calls=0;const result=[];
    for (const [kind,method] of [['CustomEvent','initCustomEvent'],['UIEvent','initUIEvent'],['MouseEvent','initMouseEvent']]) {
      const e=document.createEvent(kind);
      e.initEvent=()=>calls++;
      if(kind==='MouseEvent') e.initUIEvent=()=>calls++;
      if(kind==='CustomEvent') e[method]('hello',false,false,123);
      else e[method]('hello',false,false,null,123);
      result.push(e.type,e.detail,document.dispatchEvent(e));
    }
    return [calls,result];
  })()`)).toEqual([0,['hello',123,true,'hello',123,true,'hello',123,true]]);
});

test('conversion failures leave legacy events uninitialized and keep exception identity', async () => {
  expect(await evaluate(`(() => {
    const result=[];
    for (const method of ['initUIEvent','initMouseEvent']) {
      const e=document.createEvent(method==='initUIEvent'?'UIEvent':'MouseEvent');
      const marker={};
      try{e[method]('hello',false,false,null,{valueOf(){throw marker}})}catch(error){result.push(error===marker)}
      result.push(e.type);
      try{document.dispatchEvent(e);result.push('accepted')}catch(error){result.push(error.name)}
      try{e[method]('hello',false,false,null,1n)}catch(error){result.push(error instanceof TypeError)}
      e[method]('hello',false,false,null,4294967297);result.push(e.detail);
      e[method]('hello',false,false,null,2);result.push(e.detail);
    }
    return result;
  })()`)).toEqual(Array.from({length:2},()=>[true,'','InvalidStateError',true,1,2]).flat());
});

test('reused load events keep normal phases and reject recursive dispatch', async () => {
  expect(await evaluate(`(() => {
    const t=new EventTarget(), e=new Event('load'), result=[];let calls=0;
    t.addEventListener('load',()=>{
      result.push(++calls,e.eventPhase);
      if(calls===2) {
        try{t.dispatchEvent(e);result.push('accepted')}catch(error){result.push(error.name)}
        e.initEvent('changed');result.push(e.type);
      }
    });
    t.dispatchEvent(e);t.dispatchEvent(e);return result;
  })()`)).toEqual([1,2,2,2,'InvalidStateError','load']);
});

test('dispatch clears propagation flags, init clears the target, and cancelBubble shares state', async () => {
  expect(await evaluate(`(() => {
    const t=new EventTarget(), result=[];let calls=0;
    const e=new Event('x',{cancelable:true});
    t.addEventListener('x',()=>{calls++;e.stopPropagation();result.push(e.cancelBubble);e.preventDefault()});
    t.dispatchEvent(e);result.push(e.cancelBubble,e.defaultPrevented,e.target===t);
    t.dispatchEvent(e);result.push(calls,e.cancelBubble);
    e.cancelBubble=true;result.push(e.cancelBubble);
    e.initEvent('new');result.push(e.target,e.cancelBubble,e.defaultPrevented);
    return result;
  })()`)).toEqual([true,false,true,true,true,2,false,true,null,false,false]);
});

test('native activation dispatch clears stop flags without clearing trust', async () => {
  expect(await evaluate(`(() => {
    const r=document.createElement('input');r.type='radio';document.body.append(r);let captured;
    r.oninput=e=>{captured=e;e.stopImmediatePropagation()};r.click();r.remove();
    const e=new Event('x');e.stopImmediatePropagation();
    return [captured.cancelBubble,captured.isTrusted,captured.eventPhase,captured.currentTarget,e.cancelBubble];
  })()`)).toEqual([false,true,0,null,true]);
});

test('stopping before dispatch suppresses all listeners but leaves the event reusable', async () => {
  expect(await evaluate(`(() => {
    const target=document.createElement('div');document.body.append(target);let calls=0;
    const listener=()=>calls++;window.addEventListener('pre-stopped',listener,true);
    target.addEventListener('pre-stopped',listener);
    const event=new Event('pre-stopped');event.stopPropagation();
    const first=target.dispatchEvent(event), before=calls;
    const same=event.target===target;target.dispatchEvent(event);
    window.removeEventListener('pre-stopped',listener,true);target.remove();
    return [first,before,same,calls,event.cancelBubble];
  })()`)).toEqual([true,0,true,2,false]);
});

test('post-dispatch activation can reinitialize or redispatch the completed click event', async () => {
  expect(await evaluate(`(() => {
    const result=[];
    for(const mode of ['init','dispatch']) {
      const r=document.createElement('input');r.type='radio';document.body.append(r);
      const click=new MouseEvent('click');
      r.oninput=()=>{
        result.push(click.eventPhase,click.type);
        if(mode==='init') {click.initEvent('changed');result.push(click.type)}
        else result.push(new EventTarget().dispatchEvent(click));
      };
      result.push(r.dispatchEvent(click));r.remove();
    }
    return result;
  })()`)).toEqual([0,'click','changed',true,0,'click',true,true]);
});

test('replacing an on-event handler preserves its slot and null reactivation moves it to the end', async () => {
  expect(await evaluate(`(() => {
    const results=[];
    for(const target of [document.createElement('button'),document,window]) {
      const order=[];
      const first=()=>order.push('first'),last=()=>order.push('last');
      target.addEventListener('click',first);
      target.onclick=()=>order.push('old');
      target.addEventListener('click',last);
      target.onclick=function(event){order.push(this===target?'new':'bad-this');return false};
      const event=new MouseEvent('click',{cancelable:true});
      const accepted=target.dispatchEvent(event);
      results.push([order.slice(),accepted,event.defaultPrevented]);
      order.length=0;target.onclick=null;target.onclick=()=>order.push('readded');
      target.dispatchEvent(new MouseEvent('click'));
      results.push(order.slice());
      target.onclick=null;target.removeEventListener('click',first);target.removeEventListener('click',last);
    }
    return results;
  })()`)).toEqual(Array.from({length:3},()=>[[['first','new','last'],false,true],['first','last','readded']]).flat());
});
