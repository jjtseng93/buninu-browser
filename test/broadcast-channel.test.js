import { expect, test } from "bun:test";
import { createBroadcastChannels } from "../lib/renderer/broadcast-channel.js";
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {BindingRealm,eventConstructors,eventTargetConstructor} from '../lib/renderer/bindings.js';

const scope = (origin, runTask = task => task()) => {
  const parsed = parseHTMLDocument('<!doctype html><body></body>');
  class PageTypeError extends TypeError {}
  let eventTargets;
  const realm = new BindingRealm(parsed.window, {pageGlobal:()=>({TypeError:PageTypeError}),
    call:(fn,self,args)=>Reflect.apply(fn,self,args), targetOf:real=>eventTargets.targetOf(real)});
  realm.inputValueIntrinsics={TypeError:PageTypeError,DOMException};
  const events=eventConstructors(realm);
  eventTargets=eventTargetConstructor(realm);
  const channels=createBroadcastChannels({origin,eventTargets,realm,runTask,DOMException});
  return {...channels,...eventTargets,...events,PageTypeError,
    dispose(){channels.dispose();parsed.window.happyDOM.close();}};
};
const waitFor = async predicate => {
  for(let i=0;i<100&&!predicate();i++)await Bun.sleep(2);
  expect(predicate()).toBeTruthy();
};

test("BroadcastChannel separates origins, channel names and opaque document origins and disposes native channels", async () => {
  const a=scope('https://a.test'), b=scope('https://b.test'), a2=scope('https://a.test'), opaque1=scope('null'), opaque2=scope('null');
  const name=crypto.randomUUID(), sender=new a.BroadcastChannel(name), other=new b.BroadcastChannel(name),
    peer=new a2.BroadcastChannel(name), otherName=new a.BroadcastChannel(name+'other'),
    opaqueSender=new opaque1.BroadcastChannel(name), opaquePeer=new opaque2.BroadcastChannel(name);
  const received=[];
  other.onmessage=()=>received.push('other origin');peer.onmessage=()=>received.push('same origin');
  otherName.onmessage=()=>received.push('other name');opaquePeer.onmessage=()=>received.push('opaque');
  try {
    sender.postMessage('message');opaqueSender.postMessage('opaque message');
    for(let i=0;i<100&&!received.length;i++)await Bun.sleep(2);
    await Bun.sleep(10);
    expect(received).toEqual(['same origin']);
    a.dispose();
    expect(()=>sender.postMessage(()=>{})).not.toThrow();
    const inert=new a.BroadcastChannel('closed realm');
    expect(inert.name).toBe('closed realm');
    expect(()=>inert.postMessage(Symbol())).not.toThrow();
    inert.close();expect(()=>inert.postMessage(Symbol())).not.toThrow();
    expect(()=>inert.postMessage()).toThrow(a.PageTypeError);
  } finally {for(const item of [a,b,a2,opaque1,opaque2])item.dispose();}
});

test('delivery is trusted and handler replacement retains listener order; redispatch clears trust', async () => {
  const f=scope('https://events.test'),name=crypto.randomUUID();
  const sender=new f.BroadcastChannel(name),receiver=new f.BroadcastChannel(name),seen=[];
  let captured;
  try {
    receiver.onmessage=()=>seen.push('old');
    receiver.addEventListener('message',event=>{captured=event;seen.push(['listener',event.isTrusted,event.target===receiver]);});
    receiver.onmessage=function(event){seen.push(['new',this===receiver,event.isTrusted,event.data]);};
    // Delivery must use captured internal dispatch/handler machinery.
    receiver.dispatchEvent=()=>{throw Error('page override');};
    sender.postMessage('hello');
    await waitFor(()=>seen.length===2);
    expect(seen).toEqual([['new',true,true,'hello'],['listener',true,true]]);
    expect(captured.currentTarget).toBeNull();
    expect(captured.eventPhase).toBe(0);
    expect(captured.isTrusted).toBeTrue();
    receiver.onmessage=null;
    receiver.onmessage=()=>seen.push('readded');
    f.EventTarget.prototype.dispatchEvent.call(receiver,captured);
    expect(seen.slice(2)).toEqual([['listener',false,true],'readded']);
    expect(captured.isTrusted).toBeFalse();
  } finally {f.dispose();}
});

test('Web IDL conversion, defining-realm errors and author clone exceptions preserve identity', () => {
  const f=scope('https://idl.test');
  try {
    const C=f.BroadcastChannel;
    for(const invoke of [()=>C('x'),()=>new C(),()=>new C(Symbol()),()=>C.prototype.close.call({}),
      ()=>C.prototype.postMessage.call({},1),()=>Object.getOwnPropertyDescriptor(C.prototype,'name').get.call({}),
      ()=>Object.getOwnPropertyDescriptor(C.prototype,'onmessage').set.call(new f.EventTarget(),()=>{})])
      expect(invoke).toThrow(f.PageTypeError);
    const log=[],marker={marker:true};
    const c=new C({[Symbol.toPrimitive](hint){log.push(hint);return 'converted'}});
    expect([log,c.name]).toEqual([['string'],'converted']);
    for(const thrown of [marker,new DOMException('author','DataCloneError'),null,undefined]) {
      let caught=false;
      try{c.postMessage({get value(){throw thrown}})}catch(error){caught=true;expect(error).toBe(thrown)}
      expect(caught).toBeTrue();
    }
    expect(()=>c.postMessage(()=>{})).toThrow(DOMException);
    c.close();
    expect(()=>c.postMessage()).toThrow(f.PageTypeError);
    expect(()=>c.postMessage(Symbol())).toThrow('The channel is closed');
    const descriptor=Object.getOwnPropertyDescriptor(C.prototype,'onmessage');
    c.onmessage=()=>{};c.onmessage=0;expect(descriptor.get.call(c)).toBeNull();
  } finally {f.dispose();}
});

test('borrowed methods operate on the receiver realm and inert realms never reopen native channels', async () => {
  const a=scope('https://borrow.test'),b=scope('https://borrow.test'),name=crypto.randomUUID();
  const sender=new a.BroadcastChannel(name),receiver=new b.BroadcastChannel(name),seen=[];
  try {
    const foreignHandler=Object.getOwnPropertyDescriptor(a.BroadcastChannel.prototype,'onmessage');
    foreignHandler.set.call(receiver,event=>seen.push(event.data));
    b.BroadcastChannel.prototype.postMessage.call(sender,42);
    await waitFor(()=>seen.length===1);expect(seen).toEqual([42]);
    expect(Object.getOwnPropertyDescriptor(b.BroadcastChannel.prototype,'name').get.call(sender)).toBe(name);
    a.dispose();
    const local=new b.BroadcastChannel(name);local.onmessage=event=>seen.push(event.data);
    // Borrowing a method from a disposed realm must not disable a live receiver.
    a.BroadcastChannel.prototype.postMessage.call(receiver,43);
    await waitFor(()=>seen.length===2);expect(seen).toEqual([42,43]);
    a.BroadcastChannel.prototype.close.call(receiver);
    expect(()=>receiver.postMessage(1)).toThrow('The channel is closed');
    expect(()=>b.BroadcastChannel.prototype.postMessage.call(sender,()=>{})).not.toThrow();
  } finally {a.dispose();b.dispose();}
});

test('closing or disposing between native receipt and the page task discards pending delivery', async () => {
  for(const action of ['close','dispose']) {
    const tasks=[],f=scope('https://queue.test',fn=>tasks.push(fn)),name=crypto.randomUUID();
    const sender=new f.BroadcastChannel(name),receiver=new f.BroadcastChannel(name);
    let deliveries=0;receiver.onmessage=()=>deliveries++;
    try {
      sender.postMessage('queued');await waitFor(()=>tasks.length===1);
      if(action==='close')receiver.close();else f.dispose();
      tasks.shift()();expect(deliveries).toBe(0);
    } finally {f.dispose();}
  }
});
