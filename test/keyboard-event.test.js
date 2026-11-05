import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {BindingRealm, eventConstructors, eventTargetConstructor, installKeyboardEventMethods} from '../lib/renderer/bindings.js';
import {RendererHost} from '../lib/renderer/host.js';
import {createMessaging} from '../lib/renderer/messaging.js';

function fixture() {
  const f = parseHTMLDocument('<!doctype html><body></body>');
  class RealmTypeError extends TypeError {}
  const global = {TypeError:RealmTypeError};
  const realm = new BindingRealm(f.window, {pageGlobal:() => global,
    call:(callback, receiver, args) => Reflect.apply(callback, receiver, args)});
  const events = eventConstructors(realm);
  realm.inputValueIntrinsics = {TypeError:RealmTypeError};
  installKeyboardEventMethods(realm);
  const {EventTarget} = eventTargetConstructor(realm);
  return {...f, global, realm, ...events, EventTarget, RealmTypeError, close:() => f.window.happyDOM.close()};
}
const snapshot = event => [event.type,event.bubbles,event.cancelable,event.detail,event.location,
  event.key,event.code,event.keyCode,event.charCode,event.repeat,event.isComposing,
  event.ctrlKey,event.altKey,event.shiftKey,event.metaKey,event.view,event.defaultPrevented,event.target];

test('legacy keyboard initialization updates UI state and modifiers while retaining key identity', () => {
  const f = fixture();
  try {
    const e = new f.KeyboardEvent('keydown', {key:'A',code:'KeyA',keyCode:65,
      location:2,repeat:true,isComposing:true,detail:9,cancelable:true});
    // Native keyboard input can carry the legacy character code separately.
    f.realm.unwrapEvent(e).charCode=97;
    const target = new f.EventTarget();
    target.addEventListener('keydown', event => event.preventDefault());
    expect(target.dispatchEvent(e)).toBeFalse();
    e.initKeyboardEvent('keyup',true,true,f.global,'ignored',4294967297,true,false,true,false);
    expect(snapshot(e)).toEqual(['keyup',true,true,0,1,'A','KeyA',65,97,false,true,true,false,true,false,f.global,false,null]);
    expect(e.getModifierState('Control')).toBeTrue();expect(e.getModifierState('Shift')).toBeTrue();
    e.initKeyboardEvent('again');
    expect(snapshot(e)).toEqual(['again',false,false,0,0,'A','KeyA',65,97,false,true,false,false,false,false,null,false,null]);
    for (const [name,value] of Object.entries({STANDARD:0,LEFT:1,RIGHT:2,NUMPAD:3})) {
      const key='DOM_KEY_LOCATION_'+name;
      expect(f.KeyboardEvent[key]).toBe(value);expect(e[key]).toBe(value);
      expect(Object.getOwnPropertyDescriptor(f.KeyboardEvent.prototype,key)).toEqual({value,writable:false,enumerable:true,configurable:false});
    }
    expect(f.Event.prototype.initKeyboardEvent).toBeUndefined();
    expect(f.MouseEvent.prototype.initKeyboardEvent).toBeUndefined();
    expect(f.KeyboardEvent.prototype.initKeyboardEvent.length).toBe(1);
    expect(Object.getOwnPropertyDescriptor(f.KeyboardEvent.prototype,'location').set).toBeUndefined();
  } finally {f.close();}
});

test('keyboard initializers convert before the dispatch guard and never call overridden initializers', () => {
  const f = fixture();
  try {
    const e = new f.KeyboardEvent('keydown', {key:'A',location:2,repeat:true,isComposing:true});
    let overridden=0;
    e.initEvent=e.initUIEvent=() => overridden++;
    const target = new f.EventTarget(), order=[];
    target.addEventListener('keydown', () => {
      const before=snapshot(e);
      e.initKeyboardEvent({toString(){order.push('type');return 'other'}},true,true,f.global,
        {toString(){order.push('key');return 'ignored'}},{valueOf(){order.push('location');return 3}},true,true,true,true);
      expect(snapshot(e)).toEqual(before);
      const marker={};
      let caught;
      try {e.initKeyboardEvent('other',false,false,null,{toString(){throw marker}})} catch(error) {caught=error;}
      expect(caught).toBe(marker);
      expect(snapshot(e)).toEqual(before);
    });
    expect(target.dispatchEvent(e)).toBeTrue();
    expect(order).toEqual(['type','key','location']);expect(overridden).toBe(0);
    e.initKeyboardEvent('after',false,false,null,'',3,true);
    expect([e.type,e.location,e.ctrlKey,overridden]).toEqual(['after',3,true,0]);
  } finally {f.close();}
});

test('keyboard conversion failures preserve state, exceptions and defining-realm brands', () => {
  const f=fixture(), other=fixture();
  try {
    const e=new f.KeyboardEvent('before',{key:'X',repeat:true}), before=snapshot(e);
    const init=f.KeyboardEvent.prototype.initKeyboardEvent, typeError=f.RealmTypeError;
    f.global.TypeError=function Replacement(){throw 'replacement must not run'};
    for(const invoke of [() => init.call(e), () => init.call(e,Symbol()),
      () => init.call(e,'x',false,false,{}), () => init.call(e,'x',false,false,new Proxy(f.global,{})),
      () => init.call(e,'x',false,false,null,Symbol()),
      () => init.call(e,'x',false,false,null,'',1n),
      () => init.call(e,'x',false,false,null,'',Object(1n))]) {
      expect(invoke).toThrow(typeError);expect(snapshot(e)).toEqual(before);
    }
    const marker=new Error('author conversion'),order=[];
    expect(() => init.call(e,{toString(){order.push('type');return 'x'}},false,false,{},
      {toString(){order.push('key');throw marker}})).toThrow(typeError);
    expect(order).toEqual(['type']);
    let caught;try{init.call(e,'x',false,false,null,'',{valueOf(){throw marker}})}catch(error){caught=error}
    expect(caught).toBe(marker);expect(snapshot(e)).toEqual(before);
    for(const receiver of [{},Object.create(e),new Proxy(e,{}),new f.Event('x'),new f.MouseEvent('x')]) {
      expect(() => init.call(receiver,'x')).toThrow(typeError);
      expect(() => Object.getOwnPropertyDescriptor(f.KeyboardEvent.prototype,'location').get.call(receiver)).toThrow(typeError);
    }
    const revocable=Proxy.revocable(e,{});revocable.revoke();
    expect(() => init.call(revocable.proxy,'x')).toThrow(typeError);
    const foreign=new other.KeyboardEvent('foreign');
    init.call(foreign,'updated',false,false,other.global,'',-1);
    expect([foreign.type,foreign.view,foreign.location]).toEqual(['updated',other.global,4294967295]);
  } finally {f.close();other.close();}
});

test('keyboard location uses unsigned-long conversion in constructors and initializers', () => {
  const f=fixture();
  try {
    for (const [input,expected] of [[-1,4294967295],[2.5,2],[4294967296,0],[NaN,0],[Infinity,0],['3',3]]) {
      const event=new f.KeyboardEvent('test',{location:input});
      expect(event.location).toBe(expected);
      event.initKeyboardEvent('test',false,false,null,'',input);
      expect(event.location).toBe(expected);
    }
    for (const location of [1n,Object(1n),Symbol()])
      expect(() => new f.KeyboardEvent('test',{location})).toThrow(f.RealmTypeError);
    let reads=0;
    expect(new f.KeyboardEvent('test',{get location(){reads++;return 2}}).location).toBe(2);
    expect(reads).toBe(1);
    const marker={};let caught;
    try{new f.KeyboardEvent('test',{location:{valueOf(){throw marker}}})}catch(error){caught=error}
    expect(caught).toBe(marker);
  } finally {f.close();}
});

test('keyboard UI state is shared across wrappers and accepts engine Window facades', () => {
  const f=fixture(),other=fixture();
  try {
    const self={origin:()=>'https://a.test',children:()=>[]};
    const cross={origin:()=>'https://b.test',children:()=>[],closed:()=>false};
    const messaging=createMessaging({realm:f.realm,window:f.window,pageGlobal:()=>f.global,
      runTask:callback=>callback(),callPage:Reflect.apply,DOMException,frames:{self}});
    const views=[f.global,other.global,messaging.framesOf(f.global),messaging.proxyFor(cross),messaging.proxyFor(cross).frames];
    const event=new f.KeyboardEvent('old',{detail:9,location:2});
    const foreign=other.realm.wrapEvent(f.realm.unwrapEvent(event));
    for (const view of views) {
      event.initKeyboardEvent('new',false,false,view,'',3);
      expect([event.view,foreign.view,event.detail,foreign.detail,foreign.location]).toEqual([view,view,0,0,3]);
      expect(() => event.initKeyboardEvent('bad',false,false,new Proxy(view,{}))).toThrow(f.RealmTypeError);
    }
    foreign.initUIEvent('ui',false,false,null,7);
    expect([event.view,foreign.view,event.detail,foreign.detail]).toEqual([null,null,7,7]);
    messaging.dispose();
  } finally {f.close();other.close();}
});

test('renderer keyboard initialization works before and after dispatch with native page errors', async () => {
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://keyboard.test/',contentType:'text/html',source:'<!doctype html><body></body>'});
    await host.call('whenLoaded');
    expect(await host.call('evaluate',`(() => {
      const e=document.createEvent('KeyboardEvent'),result=[];
      try{document.dispatchEvent(e)}catch(error){result.push(error.name)}
      e.initKeyboardEvent('keypress',true,true,window,'ignored',3,true,false,true,false);
      result.push(e.type,e.location,e.view===window,e.key,e.repeat,e.ctrlKey,e.shiftKey,e.isComposing,e.detail);
      document.addEventListener('keypress',()=>{e.initKeyboardEvent('other',false,false,null,'',1);result.push(e.type,e.location,e.view===window)});
      result.push(document.dispatchEvent(e));
      const Type=TypeError,marker={};
      try{e.initKeyboardEvent('x',false,false,null,'',1n)}catch(error){result.push(error.constructor===Type)}
      try{e.initKeyboardEvent('x',false,false,null,{toString(){throw marker}})}catch(error){result.push(error===marker)}
      const init=KeyboardEvent.prototype.initKeyboardEvent;
      for(const receiver of [{},new Event('x'),new Proxy(e,{})])try{init.call(receiver,'x')}catch(error){result.push(error.constructor===Type)}
      e.initKeyboardEvent('after');result.push(e.type,e.location,e.view,e.target,e.ctrlKey);
      return result;
    })()`)).toEqual(['InvalidStateError','keypress',3,true,'',false,true,true,false,0,'keypress',3,true,true,true,true,true,true,true,'after',0,null,null,false]);
  } finally {await host.close();}
},30000);
