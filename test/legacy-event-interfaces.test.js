import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {BindingRealm, eventConstructors, eventTargetConstructor, installKeyboardEventMethods} from '../lib/renderer/bindings.js';
import {storageInterface} from '../lib/renderer/interfaces.js';
import {RendererHost} from '../lib/renderer/host.js';

function fixture(secure = true) {
  const parsed = parseHTMLDocument('<!doctype html><body></body>');
  class PageTypeError extends TypeError {}
  const global = {TypeError:PageTypeError};
  const realm = new BindingRealm(parsed.window, {pageGlobal:() => global,
    call:(callback, receiver, args) => Reflect.apply(callback, receiver, args)});
  realm.inputValueIntrinsics = {TypeError:PageTypeError, DOMException};
  const events = eventConstructors(realm, {secure});
  installKeyboardEventMethods(realm);
  const targets = eventTargetConstructor(realm);
  const storage = storageInterface();
  return {...parsed, ...events, ...targets, realm, global, PageTypeError,
    document:realm.wrap(parsed.document), storage:storage.create(new Map()),
    close:() => parsed.window.happyDOM.close()};
}
const eventState = e => [e.type,e.bubbles,e.cancelable,e.defaultPrevented,e.target,e.currentTarget,e.eventPhase,e.isTrusted];
const storageState = e => [...eventState(e),e.key,e.oldValue,e.newValue,e.url,e.storageArea];

test('legacy aliases create actual interfaces with uninitialized dispatch state', () => {
  const f=fixture();
  try {
    const aliases={BeforeUnloadEvent:'BeforeUnloadEvent',CompositionEvent:'CompositionEvent',CustomEvent:'CustomEvent',
      DeviceMotionEvent:'DeviceMotionEvent',DeviceOrientationEvent:'DeviceOrientationEvent',DragEvent:'DragEvent',
      Event:'Event',Events:'Event',FocusEvent:'FocusEvent',HashChangeEvent:'HashChangeEvent',HTMLEvents:'Event',
      KeyboardEvent:'KeyboardEvent',MessageEvent:'MessageEvent',MouseEvent:'MouseEvent',MouseEvents:'MouseEvent',
      StorageEvent:'StorageEvent',SVGEvents:'Event',TextEvent:'TextEvent',UIEvent:'UIEvent',UIEvents:'UIEvent',TouchEvent:'TouchEvent'};
    const target=new f.EventTarget();
    for(const [alias,name] of Object.entries(aliases))for(const spelling of [alias,alias.toUpperCase(),alias.toLowerCase()]) {
      const e=f.document.createEvent(spelling);
      expect(Object.getPrototypeOf(e)).toBe(f[name].prototype);
      expect(eventState(e)).toEqual(['',false,false,false,null,null,0,false]);
      expect(()=>target.dispatchEvent(e)).toThrow(DOMException);
      e.initEvent('');expect(target.dispatchEvent(e)).toBeTrue();
    }
    for(const name of ['PopStateEvent','KeyboardEvents','MessageEvents','SVGEvent',' Event','Event ','KeyboardEvent','MouseEvent\0'])
      expect(()=>f.document.createEvent(name)).toThrow(DOMException);
    expect(()=>f.document.createEvent()).toThrow(f.PageTypeError);
    expect(()=>f.document.createEvent(Symbol())).toThrow(f.PageTypeError);
    let calls=0;expect(()=>f.document.createEvent({toString(){calls++;return 'missing'}})).toThrow(DOMException);expect(calls).toBe(1);
    const marker={};let caught;try{f.document.createEvent({toString(){throw marker}})}catch(e){caught=e}expect(caught).toBe(marker);
    const drag=f.document.createEvent('DragEvent');expect(drag.dataTransfer).toBeNull();expect(drag instanceof f.MouseEvent).toBeTrue();
    const message=f.document.createEvent('MessageEvent');expect([message.data,message.origin,message.lastEventId,message.source,message.ports.length]).toEqual([null,'','',null,0]);
  } finally {f.close();}
});

test('BeforeUnload and Text are illegal constructors but usable legacy events', () => {
  const f=fixture();
  try {
    for(const name of ['BeforeUnloadEvent','TextEvent','TouchList','DeviceMotionEventAcceleration','DeviceMotionEventRotationRate']) {
      expect(()=>new f[name]()).toThrow(f.PageTypeError);expect(()=>f[name]()).toThrow(f.PageTypeError);
    }
    const before=f.document.createEvent('BeforeUnloadEvent');expect(before.returnValue).toBe('');
    before.initEvent('beforeunload',false,true);before.returnValue=123;
    expect([before.returnValue,before.defaultPrevented]).toEqual(['123',false]);
    expect(()=>{before.returnValue=Symbol()}).toThrow(f.PageTypeError);expect(before.returnValue).toBe('123');
    const text=f.document.createEvent('TextEvent');expect(text.data).toBe('');
    text.initTextEvent('textInput');expect([text.data,text.view,text.detail]).toEqual(['undefined',null,0]);
    text.initTextEvent('textInput',true,true,f.global,'\ud800');
    expect([text.data,text.view,text.detail,text.bubbles,text.cancelable]).toEqual(['\ud800',f.global,0,true,true]);
    // Current UI Events differs from Chromium's older DOMString/default here.
    const composition=new f.CompositionEvent('compositionend',{data:'\ud800',detail:3,view:f.global});
    expect([composition.data,composition.detail,composition.view]).toEqual(['\ufffd',3,f.global]);
    composition.initCompositionEvent('compositionstart');expect([composition.data,composition.detail,composition.view]).toEqual(['',0,null]);
    expect(f.CompositionEvent.prototype.initCompositionEvent.length).toBe(1);
    expect(f.TextEvent.prototype.initTextEvent.length).toBe(1);
  } finally {f.close();}
});

test('Storage and HashChange convert in dictionary order, preserve values and reject forged brands', () => {
  const f=fixture(),other=fixture();
  try {
    const order=[], source={bubbles:true,cancelable:true,composed:true,key:1,newValue:2,oldValue:3,storageArea:other.storage,url:'\ud800'};
    const options=new Proxy(source,{get(target,key){order.push(key);return target[key]}});
    const event=new f.StorageEvent('storage',options);
    expect(order).toEqual(['bubbles','cancelable','composed','key','newValue','oldValue','storageArea','url']);
    expect(storageState(event)).toEqual(['storage',true,true,false,null,null,0,false,'1','3','2','\ufffd',other.storage]);
    expect(event.composed).toBeTrue();
    event.initStorageEvent(null,null,null,null,null,null,null,null);
    expect(storageState(event)).toEqual(['null',false,false,false,null,null,0,false,null,null,null,'null',null]);
    event.initStorageEvent(undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined);
    expect([event.type,event.key,event.url,event.storageArea]).toEqual(['undefined',null,'',null]);
    for(const storageArea of [{},Object.create(f.storage),new Proxy(f.storage,{})])
      expect(()=>new f.StorageEvent('storage',{storageArea})).toThrow(f.PageTypeError);
    const hash=new f.HashChangeEvent('hashchange',{oldURL:'\ud800',newURL:'relative'});
    expect([hash.oldURL,hash.newURL]).toEqual(['\ufffd','relative']);
    const native=new f.window.HashChangeEvent('hashchange',{oldURL:'https://a/#x',newURL:'https://a/#y'});
    const wrapped=f.realm.wrapEvent(native),rewrapped=other.realm.wrapEvent(native);
    expect(wrapped instanceof f.HashChangeEvent).toBeTrue();expect(rewrapped instanceof other.HashChangeEvent).toBeTrue();
    expect([wrapped.oldURL,rewrapped.newURL]).toEqual(['https://a/#x','https://a/#y']);
  } finally {f.close();other.close();}
});

test('supplemental initializers retain shared state and guard dispatch after conversion', () => {
  const f=fixture(),other=fixture();
  try {
    for(const [name,init,args] of [
      ['StorageEvent','initStorageEvent',['next',true,true,'key','old','new','url',f.storage]],
      ['CompositionEvent','initCompositionEvent',['next',true,true,f.global,'data']],
      ['TextEvent','initTextEvent',['next',true,true,f.global,'data']],
    ]) {
      const event=f.document.createEvent(name);event.initEvent('start',true,true);
      const rewrapped=other.realm.wrapEvent(f.realm.unwrapEvent(event));
      expect(Object.getPrototypeOf(rewrapped)).toBe(other[name].prototype);
      let overridden=0;event.initEvent=event.initUIEvent=()=>overridden++;
      const target=new f.EventTarget();let calls=0;
      target.addEventListener('start',()=>{
        event.preventDefault();const snapshot=eventState(event);
        event[init](...args);expect(eventState(event)).toEqual(snapshot);
        event[init]({toString(){calls++;return 'unused'}});expect(calls).toBe(1);
      });
      expect(target.dispatchEvent(event)).toBeFalse();
      rewrapped[init](...args);expect(event.type).toBe('next');expect(event.defaultPrevented).toBeFalse();expect(event.target).toBeNull();
      expect(overridden).toBe(0);
      if(name==='StorageEvent')expect([event.key,event.storageArea]).toEqual(['key',f.storage]);
      else expect([event.data,event.view,event.detail]).toEqual(['data',f.global,0]);
      for(const receiver of [{},Object.create(event),new Proxy(event,{}),new f.Event('x')])
        expect(()=>f[name].prototype[init].call(receiver,'x')).toThrow(f.PageTypeError);
    }
  } finally {f.close();other.close();}
});

test('sensor constructors are secure-only, with typed readonly finite data and no hardware access', () => {
  const f=fixture(),insecure=fixture(false);
  try {
    for(const name of ['DeviceMotionEvent','DeviceOrientationEvent','DeviceMotionEventAcceleration','DeviceMotionEventRotationRate']) {
      expect(insecure[name]).toBeUndefined();expect(()=>insecure.document.createEvent(name)).toThrow(DOMException);
    }
    const orientation=new f.DeviceOrientationEvent('orientation',{alpha:1,beta:null,gamma:'3',absolute:true});
    expect([orientation.alpha,orientation.beta,orientation.gamma,orientation.absolute]).toEqual([1,null,3,true]);
    const motion=new f.DeviceMotionEvent('motion',{acceleration:{x:1,y:'2'},accelerationIncludingGravity:null,rotationRate:{beta:3},interval:16});
    expect(motion.acceleration instanceof f.DeviceMotionEventAcceleration).toBeTrue();
    expect([motion.acceleration.x,motion.acceleration.y,motion.acceleration.z,motion.accelerationIncludingGravity.x,motion.rotationRate.beta,motion.interval]).toEqual([1,2,null,null,3,16]);
    expect(Reflect.set(motion.acceleration,'x',9)).toBeFalse();expect(motion.acceleration.x).toBe(1);
    const defaults=new f.DeviceMotionEvent('motion');expect([defaults.acceleration,defaults.accelerationIncludingGravity,defaults.rotationRate,defaults.interval]).toEqual([null,null,null,0]);
    for(const invalid of [NaN,Infinity,1n,Symbol(),Object(1n)]) {
      expect(()=>new f.DeviceOrientationEvent('x',{alpha:invalid})).toThrow(f.PageTypeError);
      expect(()=>new f.DeviceMotionEvent('x',{interval:invalid})).toThrow(f.PageTypeError);
    }
  } finally {f.close();insecure.close();}
});

test('Touch snapshots use real EventTarget brands, readonly indexed lists and modifier fields', () => {
  const f=fixture(),other=fixture();
  try {
    const targets=[f.document,f.document.body,new f.EventTarget(),f.global,new other.EventTarget(),other.global];
    for(const target of targets)expect(new f.Touch({identifier:-1,target}).target).toBe(target);
    for(const target of [null,undefined,{},Object.create(f.document),new Proxy(f.document,{}),Object.create(f.EventTarget.prototype)])
      expect(()=>new f.Touch({identifier:1,target})).toThrow(f.PageTypeError);
    const touch=new f.Touch({identifier:4294967297,target:f.document,clientX:3.5,force:0.4,touchType:'stylus'});
    expect(touch.identifier).toBe(1);expect(touch.force).toBe(Math.fround(0.4));expect(Reflect.set(touch,'clientX',9)).toBeFalse();
    const input=[touch], event=new f.TouchEvent('touchstart',{touches:input,altKey:true,modifierAltGraph:true,view:f.global,detail:2});
    input.length=0;expect(event.touches.length).toBe(1);expect(event.touches.item(0)).toBe(touch);expect([...event.touches]).toEqual([touch]);
    expect(event.touches.item(-1)).toBeNull();expect(()=>event.touches.item()).toThrow(f.PageTypeError);expect(()=>event.touches.item(1n)).toThrow(f.PageTypeError);
    expect(Reflect.set(event.touches,'0',null)).toBeFalse();expect(Reflect.deleteProperty(event.touches,'0')).toBeFalse();
    expect(Reflect.defineProperty(event.touches,'0',{value:null})).toBeFalse();
    expect([event.altKey,event.ctrlKey,event.getModifierState('Alt'),event.getModifierState('AltGraph'),event.getModifierState('toString'),event.view,event.detail]).toEqual([true,false,true,true,false,f.global,2]);
    expect(()=>event.getModifierState(Symbol())).toThrow(f.PageTypeError);
    expect(()=>new f.TouchEvent('x',{touches:[Object.create(touch)]})).toThrow(f.PageTypeError);
    expect(()=>new f.TouchEvent('x',{touches:[new Proxy(touch,{})]})).toThrow(f.PageTypeError);
    for(const options of [{},{identifier:0},{target:f.document},{identifier:0,target:f.document,force:1e99},
      {identifier:0,target:f.document,touchType:'other'},{identifier:0,target:f.document,clientX:Infinity}])
      expect(()=>new f.Touch(options)).toThrow(f.PageTypeError);
    const rewrapped=other.realm.wrapEvent(f.realm.unwrapEvent(event));expect(rewrapped instanceof other.TouchEvent).toBeTrue();expect(rewrapped.touches).toBe(event.touches);
  } finally {f.close();other.close();}
});

test('constructors preserve subclass prototypes, conversion exceptions and defining-realm errors', () => {
  const f=fixture();
  try {
    f.global.TypeError=function Replacement(){throw 'must not be called'};
    for(const name of ['StorageEvent','CompositionEvent','HashChangeEvent','DeviceMotionEvent','DeviceOrientationEvent','TouchEvent']) {
      class Sub extends f[name] {}
      const event=new Sub('x');expect(event instanceof Sub).toBeTrue();expect(event instanceof f.Event).toBeTrue();
      expect(()=>new f[name]()).toThrow(f.PageTypeError);expect(()=>f[name]('x')).toThrow(f.PageTypeError);
      expect(()=>new f[name](Symbol())).toThrow(f.PageTypeError);expect(()=>new f[name]('x',3)).toThrow(f.PageTypeError);
      const marker={};let caught;try{new f[name]({toString(){throw marker}})}catch(e){caught=e}expect(caught).toBe(marker);
    }
    let closed=0;
    const iterable={*[Symbol.iterator](){try{yield {}}finally{closed++}}};
    expect(()=>new f.TouchEvent('x',{touches:iterable})).toThrow(f.PageTypeError);expect(closed).toBe(1);
    for(const touches of [null,{}, {[Symbol.iterator](){return 1}}, {[Symbol.iterator](){return {next(){return 1}}}}])
      expect(()=>new f.TouchEvent('x',{touches})).toThrow(f.PageTypeError);
  } finally {f.close();}
});

test('newTarget prototype is read once before conversion and supports fallback and reentry', () => {
  const f=fixture();
  try {
    for(const [Constructor,args] of [[f.StorageEvent,['x']],[f.Touch,[{identifier:1,target:f.document}]]]) {
      const customPrototype={}, trace=[];
      const Target=new Proxy(function Target(){}, {get(target,key,receiver) {
        if(key==='prototype') {trace.push('prototype');new f.HashChangeEvent('nested');return customPrototype;}
        return Reflect.get(target,key,receiver);
      }});
      const instance=Reflect.construct(Constructor,args,Target);
      expect(Object.getPrototypeOf(instance)).toBe(customPrototype);expect(trace).toEqual(['prototype']);
      trace.length=0;
      const converted=Constructor===f.Touch ? [{get identifier(){trace.push('identifier');return 1},target:f.document}]
        : [{toString(){trace.push('type');return 'x'}},{get bubbles(){trace.push('bubbles');return false}}];
      Reflect.construct(Constructor,converted,Target);
      expect(trace).toEqual(Constructor===f.Touch?['prototype','identifier']:['prototype','type','bubbles']);
      trace.length=0;expect(()=>Reflect.construct(Constructor,[],Target)).toThrow(f.PageTypeError);
      expect(trace).toEqual(['prototype']);
      const fallback=new Proxy(function Target(){},{get(target,key,receiver){return key==='prototype'?1:Reflect.get(target,key,receiver)}});
      expect(Object.getPrototypeOf(Reflect.construct(Constructor,args,fallback))).toBe(Constructor.prototype);
      const marker={},throwing=new Proxy(function Target(){},{get(){throw marker}});let caught;
      try{Reflect.construct(Constructor,args,throwing)}catch(error){caught=error}expect(caught).toBe(marker);
    }
  } finally {f.close();}
});

test('page realm exposes genuine legacy interfaces, captured errors and ordinary hash navigation', async () => {
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();await host.call('loadDocument',{url:'https://events.test/',contentType:'text/html',source:'<!doctype html><body></body>'});
    await host.call('whenLoaded');
    expect(await host.call('evaluate',`(() => {
      const e=new StorageEvent('storage',{storageArea:localStorage}), t=new Touch({identifier:1,target:document.body});
      const touch=new TouchEvent('touchstart',{touches:[t],view:window});const Type=TypeError;window.TypeError=function Replacement(){};
      const r=[e.storageArea===localStorage,touch.view===window,[...touch.touches][0]===t,
        Object.getPrototypeOf(touch)===TouchEvent.prototype,TouchList.prototype[Symbol.iterator]===Array.prototype.values];
      for(const invoke of [()=>document.createEvent(),()=>document.createEvent(Symbol()),()=>new TouchEvent('x',{touches:null}),
        ()=>new StorageEvent('x',{storageArea:{}}),()=>new TextEvent(),()=>Document.prototype.createEvent.call({},'Event')]) {
        try{invoke();r.push(false)}catch(error){r.push(error.constructor===Type)}
      }
      const hash=new HashChangeEvent('hashchange',{oldURL:'a',newURL:'b'});let observed;
      window.addEventListener('hashchange',e=>observed=[e.oldURL,e.newURL,e instanceof HashChangeEvent],{once:true});
      window.dispatchEvent(hash);r.push(observed);const legacy=document.createEvent('CompositionEvent');
      try{document.dispatchEvent(legacy)}catch(error){r.push(error.name)}
      legacy.initCompositionEvent('start',true,false,window,'ok');r.push(legacy.data,legacy.view===window,document.dispatchEvent(legacy));
      globalThis.hashObserved=null;window.addEventListener('hashchange',e=>hashObserved=[e.oldURL,e.newURL,e instanceof HashChangeEvent]);
      location.hash='next';return r;
    })()`)).toEqual([true,true,true,true,true,true,true,true,true,true,true,['a','b',true],'InvalidStateError','ok',true,true]);
    await Bun.sleep(30);
    expect(await host.call('evaluate','hashObserved')).toEqual(['https://events.test/','https://events.test/#next',true]);
  } finally {await host.close();}
},30000);
