import {afterAll, beforeAll, expect, test} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

let renderer;
beforeAll(async () => {
  renderer = new RendererHost({timeout:20_000});
  await renderer.start();
});
afterAll(() => renderer?.close());
async function evaluate(source) {
  await renderer.call('loadDocument', {url:'https://computed.test/', contentType:'text/html', status:200,
    source:'<!doctype html><div id="one" style="width:100px;color:red;background-color:blue;--tone:first"></div><div id="two" style="width:200px;color:green;background-color:red"></div>'});
  await renderer.call('whenLoaded');
  return renderer.call('evaluate', `(() => {
    const one=document.getElementById('one'),two=document.getElementById('two');
    const a=getComputedStyle(one),b=getComputedStyle(two);
    ${source}
  })()`);
}

test('computed declarations preserve their own property order and accessor descriptors', async () => {
  expect(await evaluate(`
    const css=Array.from({length:a.length},(_,i)=>a.item(i));
    const idl=css.map(name=>name.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()));
    const base=['length','item','getPropertyValue','getPropertyPriority','cssText','parentRule','setProperty','removeProperty'];
    const first=[...base,...idl,'webkitLineClamp','webkitBoxOrient'];
    const canonical=[...first,...css.filter(name=>!first.includes(name))];
    const aliases=Reflect.ownKeys(a).slice(canonical.length);
    const expected=[...canonical,...aliases];
    if (!aliases.every(name=>name==='cssFloat'||/^(?:-webkit-|[Ww]ebkit)/.test(name))) throw Error('unexpected alias');
    const descriptors=Object.getOwnPropertyDescriptors(a);
    const named=expected.slice(base.length);
    return {order:JSON.stringify(Reflect.ownKeys(a))===JSON.stringify(expected),
      enumerable:JSON.stringify(Object.keys(a))===JSON.stringify(expected),
      aliases:['backgroundColor','background-color','WebkitLineClamp','webkitLineClamp','-webkit-line-clamp'].every(name=>Object.hasOwn(a,name)),
      flags:named.every(name=>descriptors[name].enumerable&&descriptors[name].configurable
        &&typeof descriptors[name].get==='function'&&typeof descriptors[name].set==='function'
        &&!('value' in descriptors[name])&&!('writable' in descriptors[name])),
      prototype:Object.getPrototypeOf(a)===Object.prototype,
      independent:a!==b};
  `)).toEqual({order:true, enumerable:true, aliases:true, flags:true, prototype:true, independent:true});
});

test('shared computed getters use the declaration receiver and remain live after detach and reattach', async () => {
  expect(await evaluate(`
    const color=Object.getOwnPropertyDescriptor(a,'color').get;
    const background=Object.getOwnPropertyDescriptor(a,'background-color').get;
    const width=Object.getOwnPropertyDescriptor(a,'width').get;
    const shared=color===Object.getOwnPropertyDescriptor(b,'color').get;
    const initial=[color.call(a),color.call(b),background.call(b),width.call(b)];
    two.style.color='blue';two.style.width='240px';
    const changed=[color.call(b),width.call(b),Reflect.get(a,'color',b)];
    two.remove();const detached=[color.call(b),width.call(b)];
    document.body.appendChild(two);const attached=[color.call(b),width.call(b)];
    return {shared,initial,changed,detached,attached,original:color.call(a)};
  `)).toEqual({shared:true, initial:['rgb(255, 0, 0)','rgb(0, 128, 0)','rgb(255, 0, 0)','200px'],
    changed:['rgb(0, 0, 255)','240px','rgb(0, 0, 255)'], detached:['',''],
    attached:['rgb(0, 0, 255)','240px'], original:'rgb(255, 0, 0)'});
});

test('computed named accessors reject receivers without declaration state', async () => {
  expect(await evaluate(`
    const read=Object.getOwnPropertyDescriptor(a,'color').get;
    const receivers=[undefined,null,true,42,'x',Symbol('x'),1n,{},one,Object.create(a)];
    const errors=receivers.map(receiver=>{
      try {read.call(receiver);return 'accepted'} catch(error) {return error.name}
    });
    let detached;try {read();detached='accepted'} catch(error) {detached=error.name}
    return {errors,detached,readable:a.color};
  `)).toEqual({errors:Array(10).fill('TypeError'), detached:'TypeError', readable:'rgb(255, 0, 0)'});
});

test('computed setters reject writes while local descriptor overrides and expandos remain independent', async () => {
  expect(await evaluate(`
    const setter=Object.getOwnPropertyDescriptor(a,'color').set;
    const error=action=>{try {action();return 'accepted'} catch(e) {return e.name}};
    const writes=[()=>setter.call(a,'blue'),()=>setter.call(b,'blue'),()=>a.color='blue',
      ()=>a['background-color']='green',()=>a.cssText='',()=>a.setProperty('--tone','changed'),()=>a.removeProperty('color')];
    const errors=writes.map(error);
    delete a.color;errors.push(error(()=>a.color='blue'));
    Object.defineProperty(a,'color',{value:'local',writable:true,enumerable:true,configurable:true});
    a.color='changed local';a.extra=42;
    return {errors,local:a.color,other:b.color,inline:one.style.color,extra:a.extra,otherExtra:b.extra??null,
      custom:a.getPropertyValue('--tone'),shared:setter===Object.getOwnPropertyDescriptor(b,'color').set};
  `)).toEqual({errors:Array(8).fill('NoModificationAllowedError'), local:'changed local',
    other:'rgb(0, 128, 0)', inline:'red', extra:42, otherExtra:null, custom:'first', shared:true});
});

test('shared computed accessor functions cannot carry page data into another document realm', async () => {
  expect(await evaluate(`
    const {get,set}=Object.getOwnPropertyDescriptor(a,'color');
    return [get,set].map(fn=>{
      const result={frozen:Object.isFrozen(fn),prototype:Object.hasOwn(fn,'prototype'),
        assigned:Reflect.set(fn,'__computedCrossRealm','secret')};
      try {Object.defineProperty(fn,'__computedCrossRealm',{value:{secret:one}});result.defined=true}
      catch(error) {result.defined=error.name}
      return result;
    });
  `)).toEqual(Array.from({length:2},()=>({frozen:true,prototype:false,assigned:false,defined:'TypeError'})));
  await renderer.call('loadDocument', {url:'https://another-computed.test/', contentType:'text/html', status:200,
    source:'<!doctype html><div style="color:blue"></div>'});
  await renderer.call('whenLoaded');
  expect(await renderer.call('evaluate', `(() => {
    const declaration=getComputedStyle(document.querySelector('div'));
    const {get,set}=Object.getOwnPropertyDescriptor(declaration,'color');
    return {clean:[get,set].every(fn=>!Object.hasOwn(fn,'__computedCrossRealm')&&Object.isFrozen(fn)
      &&!Object.hasOwn(fn,'prototype')),value:declaration.color};
  })()`)).toEqual({clean:true,value:'rgb(0, 0, 255)'});
});

test('prefixed declarations share cascade, priority, geometry and CSSOM mutations', async () => {
  expect(await evaluate(`
    const s=one.style;
    s.cssText='width:100px;-webkit-transform:scaleX(2);user-select:none;float:left';
    const first=[s.transform,s.WebkitTransform,s.webkitTransform,one.getBoundingClientRect().width,a.cssFloat,a.userSelect];
    s.setProperty('-webkit-transform','scaleX(3)','important');
    const second=[s.getPropertyPriority('transform'),a.webkitTransform===a.transform,
      a.getPropertyValue('-webkit-transform')===a.transform,one.getBoundingClientRect().width];
    s.WebkitTransform='none';
    const last=[s.removeProperty('-webkit-transform'),s.transform,'webkitMadeUp' in s];
    s.webkitLineClamp='3'; s.WebkitBoxOrient='vertical';
    return [first,second,last,[s.getPropertyValue('-webkit-line-clamp'),s.webkitBoxOrient]];
  `)).toEqual([['scaleX(2)','scaleX(2)','scaleX(2)',200,'left','none'],
    ['important',true,true,300],['none','',false],['3','vertical']]);
});

test('invalid content visibility leaves valid inline and parsed declarations intact', async () => {
  expect(await evaluate(`
    const s=one.style;
    s.cssText='content-visibility:auto;content-visibility:none';
    const initial=s.contentVisibility;
    s.contentVisibility='hidden';s.setProperty('content-visibility','none');
    const valid=s.contentVisibility;
    s.contentVisibility='var(--mode)';
    return [initial,valid,s.contentVisibility];
  `)).toEqual(['auto','hidden','var(--mode)']);
});

test('stylesheet aliases affect geometry and agree with CSS feature queries', async () => {
  expect(await evaluate(`
    const sheet=document.createElement('style');
    sheet.textContent='#one{-webkit-transform:scaleX(2);-webkit-user-select:none}';
    document.head.appendChild(sheet);
    return [one.getBoundingClientRect().width,a.userSelect,CSS.supports('-webkit-transform','scaleX(2)')];
  `)).toEqual([200,'none',true]);
});

test('accent color validates declarations, inherits and resolves currentColor and var()', async () => {
  expect(await evaluate(`
    const s=one.style;
    document.body.style.accentColor='red';
    const inherited=a.accentColor;
    s.cssText='accent-color:blue;accent-color:none;color:lime';
    s.setProperty('accent-color','red blue');
    const kept=[s.accentColor,a.getPropertyValue('accent-color')];
    s.accentColor='currentColor';const current=a.accentColor;
    s.accentColor='var(--missing, none)';const invalid=a.accentColor;
    s.accentColor='auto';
    return [inherited,kept,current,invalid,a.accentColor,CSS.supports('accent-color','none')];
  `)).toEqual(['rgb(255, 0, 0)',['blue','rgb(0, 0, 255)'],'rgb(0, 255, 0)','rgb(255, 0, 0)','auto',false]);
});

test('computed outline, flex shorthands and 3D transform properties reflect cascade changes', async () => {
  expect(await evaluate(`
    const s=one.style, read=()=>[a.outline,a.outlineOffset,a.flex,a.flexFlow,
      a.webkitBackfaceVisibility,a.getPropertyValue('-webkit-transform-style')];
    s.cssText='';
    const initial=read();
    const sheet=document.createElement('style');
    sheet.textContent='#one{color:red;outline:2px dotted;outline-offset:-1px;flex:1;flex-flow:column wrap;-webkit-transform-style:preserve-3d}';
    document.head.appendChild(sheet);
    s.WebkitBackfaceVisibility='hidden';
    const styled=read();
    s.color='green';s.flexGrow='3';s.webkitTransformStyle='flat';
    return [initial,styled,read(),s.getPropertyValue('backface-visibility')];
  `)).toEqual([
    ['rgb(0, 0, 0) none 3px','0px','0 1 auto','row nowrap','visible','flat'],
    ['rgb(255, 0, 0) dotted 2px','-1px','1 1 0%','column wrap','hidden','preserve-3d'],
    ['rgb(0, 128, 0) dotted 2px','-1px','3 1 0%','column wrap','hidden','flat'],'hidden',
  ]);
});

test('transform origin resolves against the current border box across CSSOM aliases', async () => {
  expect(await evaluate(`
    const s=one.style; s.cssText='width:100px;height:80px';
    const initial=a.transformOrigin;
    s.webkitTransformOrigin='calc(50% - 2px) top';
    const calc=a.getPropertyValue('-webkit-transform-origin');
    s.width='200px';const resized=a.webkitTransformOrigin;
    s.transformOrigin='bottom right 3px';s.transformOrigin='top 20%';
    const kept=a.transformOrigin;
    s.display='none';s.transformOrigin='30% 10%';
    return [initial,calc,resized,kept,a.transformOrigin];
  `)).toEqual(['50px 40px','48px 0px','98px 0px','200px 80px 3px','30% 10%']);
});

test('content visibility toggles intrinsic block height and continues to cascade', async () => {
  expect(await evaluate(`
    one.style.cssText='display:block;width:60px';
    one.innerHTML='<div style="height:35px"></div>';
    const state=()=>[getComputedStyle(one).contentVisibility,one.offsetHeight];
    const before=state();
    one.style.contentVisibility='hidden';
    const hidden=state();
    one.style.contentVisibility='visible';
    return [before,hidden,state()];
  `)).toEqual([['visible',35],['hidden',0],['visible',35]]);
});

test('appearance alias suppresses a checkbox face while preserving custom sizing and checked state', async () => {
  expect(await evaluate(`
    const box=document.createElement('input');box.type='checkbox';box.checked=true;
    one.appendChild(box);
    const style=getComputedStyle(box);
    const initial=style.appearance;
    box.style.webkitAppearance='none';
    box.style.width='20px';
    return [initial,style.appearance,style.webkitAppearance,style.borderTopWidth,box.offsetWidth,box.checked,getComputedStyle(one).appearance];
  `)).toEqual(['auto','none','none','0px',20,true,'none']);
});

test('prefixed text fill exposes its inherited color through CSSOM', async () => {
  expect(await evaluate(`
    one.style.webkitTextFillColor='red';
    one.style.webkitTextFillColor='23px';
    const child=document.createElement('b');one.appendChild(child);child.style.color='blue';
    const s=getComputedStyle(child);
    return [one.style.getPropertyValue('-webkit-text-fill-color'),s.webkitTextFillColor,s.getPropertyValue('-webkit-text-fill-color'),s.color];
  `)).toEqual(['red','rgb(255, 0, 0)','rgb(255, 0, 0)','rgb(0, 0, 255)']);
});

test('text stroke shorthand orders its components and resets omitted longhands', async () => {
  expect(await evaluate(`
    const s=one.style,c=getComputedStyle(one);
    s.webkitTextStroke='red 2px'; const first=[s.webkitTextStroke,c.webkitTextStroke];
    s.webkitTextStroke='blue';const second=[s.webkitTextStrokeWidth,c.webkitTextStroke];
    s.webkitTextStroke='3px 2px';const kept=s.webkitTextStroke;
    s.removeProperty('-webkit-text-stroke');
    return [first,second,kept,s.webkitTextStrokeColor];
  `)).toEqual([['2px red','2px rgb(255, 0, 0)'],['initial','0px rgb(0, 0, 255)'],'blue','']);
});

test('pending text stroke expands after substitution with longhand priority preserved', async () => {
  expect(await evaluate(`
    const sheet=document.createElement('style');
    sheet.textContent='#one{--outline: medium red;-webkit-text-stroke-color:blue!important;-webkit-text-stroke:var(--outline)}';
    document.head.appendChild(sheet);
    const c=getComputedStyle(one), first=c.webkitTextStroke;
    one.style.setProperty('--outline','green 4px');
    return [first,c.webkitTextStroke];
  `)).toEqual(['1px rgb(0, 0, 255)','4px rgb(0, 0, 255)']);
});

test('size containment excludes children from intrinsic sizing and preserves specified dimensions', async () => {
  expect(await evaluate(`
    const box=document.createElement('div');
    box.style.cssText='display:inline-block;padding:2px';
    box.innerHTML='<div style="width:80px;height:32px"></div>';
    document.body.appendChild(box);
    const state=()=>[getComputedStyle(box).contain,box.offsetWidth,box.offsetHeight];
    box.style.contain='paint size layout';const size=state();
    box.style.contain='size inline-size';const retained=box.style.contain;
    box.style.contain='inline-size';const inline=state();
    box.style.contain='size';box.style.height='18px';
    return [size,retained,inline,state(),box.firstChild.offsetHeight];
  `)).toEqual([['size layout paint',4,4],'size layout paint',['inline-size',4,36],['size',4,22],32]);
});

test('counter declarations preserve case, supply default integers and reject invalid replacements', async () => {
  expect(await evaluate(`
    const s=one.style,c=getComputedStyle(one);
    s.counterReset='Chapter item -3';s.counterIncrement='Chapter';s.counterSet='item';
    s.counterReset='none Chapter';s.counterIncrement='Chapter 1.5';
    return [s.counterReset,c.counterReset,c.counterIncrement,c.counterSet];
  `)).toEqual(['Chapter 0 item -3','Chapter 0 item -3','Chapter 1','item 0']);
});

test('filter percentages compute to factors and invalid replacements preserve the chain', async () => {
  expect(await evaluate(`
    one.style.webkitFilter='brightness(50%) opacity(150%) invert()';
    one.style.filter='contrast(-1)';
    return [one.style.filter,getComputedStyle(one).webkitFilter];
  `)).toEqual(['brightness(50%) opacity(100%) invert()','brightness(0.5) opacity(1) invert(1)']);
});

test('hue rotation accepts typed angle math and rejects unitless nonzero values', async () => {
  expect(await evaluate(`
    const s=one.style,c=getComputedStyle(one);
    s.filter='hue-rotate(-.5turn)';const initial=[s.filter,c.filter];
    s.filter='hue-rotate(calc(90deg + .25turn))';s.filter='hue-rotate(1)';
    return [initial,s.filter,c.filter];
  `)).toEqual([['hue-rotate(-0.5turn)','hue-rotate(-180deg)'],'hue-rotate(calc(180deg))','hue-rotate(180deg)']);
});

test('blur computes its radius with the current font and rejects negative lengths and percentages', async () => {
  expect(await evaluate(`
    one.style.fontSize='20px';one.style.filter='blur(.5em)';
    const first=a.filter;one.style.fontSize='30px';
    one.style.filter='blur(-2px)';one.style.filter='blur(10%)';
    return [first,a.filter,one.style.filter];
  `)).toEqual(['blur(10px)','blur(15px)','blur(0.5em)']);
});

test('numeric filter math preserves specified ranges and clamps computed factors', async () => {
  expect(await evaluate(`
    one.style.filter='opacity(calc(150%)) brightness(calc(-2)) contrast(calc(.2 + .3))';
    one.style.filter='opacity(calc(1px + 2px))';
    return [one.style.filter,getComputedStyle(one).filter];
  `)).toEqual(['opacity(calc(150%)) brightness(calc(-2)) contrast(calc(0.5))',
    'opacity(1) brightness(0) contrast(0.5)']);
});

test('filter math resolves length ratios against the element font', async () => {
  expect(await evaluate(`
    one.style.fontSize='10px';
    one.style.filter='brightness(calc(1em / 5px)) hue-rotate(calc(1em / 5px * 10deg))';
    const first=a.filter;
    one.style.fontSize='20px';
    one.style.filter='brightness(calc(1em * 5px))';
    return [first,a.filter];
  `)).toEqual(['brightness(2) hue-rotate(20deg)','brightness(4) hue-rotate(40deg)']);
});

test('drop-shadow resolves currentcolor and font lengths and rejects spread and inset', async () => {
  expect(await evaluate(`
    one.style.filter='drop-shadow(1em -2px)';
    one.style.fontSize='12px';one.style.color='red';
    one.style.filter='drop-shadow(0 0 0 2px)';one.style.filter='drop-shadow(inset 0 0)';
    return [one.style.filter,a.filter];
  `)).toEqual(['drop-shadow(1em -2px)','drop-shadow(rgb(255, 0, 0) 12px -2px 0px)']);
});

test('inherited drop shadows resolve currentcolor locally and retain inherited distances', async () => {
  expect(await evaluate(`
    one.appendChild(two);
    one.style.fontSize='10px';two.style.fontSize='30px';
    one.style.filter='drop-shadow(1em 0) drop-shadow(blue 0 0)';
    two.style.filter='inherit';
    const first=b.filter;
    two.style.color='black';
    return [first,b.filter];
  `)).toEqual(['drop-shadow(rgb(0, 128, 0) 10px 0px 0px) drop-shadow(rgb(0, 0, 255) 0px 0px 0px)',
    'drop-shadow(rgb(0, 0, 0) 10px 0px 0px) drop-shadow(rgb(0, 0, 255) 0px 0px 0px)']);
});

test('backdrop filters resolve lengths and establish a containing block for fixed descendants', async () => {
  expect(await evaluate(`
    one.style.marginLeft='50px';one.style.fontSize='20px';
    one.style.backdropFilter='blur(.5em) brightness(50%)';
    one.append(two);two.style.cssText='position:fixed;left:0;top:0';
    const offset=two.getBoundingClientRect().left;
    return [a.backdropFilter,offset===one.getBoundingClientRect().left,offset>0];
  `)).toEqual(['blur(10px) brightness(0.5)',true,true]);
});

test('isolation confines positioned descendants when enabled dynamically', async () => {
  expect(await evaluate(`
    one.style.cssText='';two.style.cssText='position:relative;width:40px;height:40px';
    const child=document.createElement('span');one.appendChild(child);
    child.style.cssText='position:absolute;z-index:100;width:40px;height:40px';
    const initial=document.elementFromPoint(12,12)===child;
    one.style.isolation='isolate';one.style.isolation='invalid';
    return [initial,a.isolation,document.elementFromPoint(12,12)===two];
  `)).toEqual([true,'isolate',true]);
});

test('image rendering inherits and tracks changes to the parent', async () => {
  expect(await evaluate(`
    one.append(two);one.style.imageRendering='pixelated';
    const before=b.imageRendering;
    one.style.imageRendering='auto';two.style.imageRendering='invalid';
    return [before,b.imageRendering];
  `)).toEqual(['pixelated','auto']);
});

test('text size adjustment aliases share the inherited desktop value', async () => {
  expect(await evaluate(`
    one.append(two);one.style.webkitTextSizeAdjust='none';
    const first=[one.style.textSizeAdjust,b.webkitTextSizeAdjust];
    one.style.textSizeAdjust='calc(80% + 20%)';one.style.textSizeAdjust='-3%';
    const second=[one.style.webkitTextSizeAdjust,b.textSizeAdjust];
    one.style.textSizeAdjust='calc(-5%)';return [first,second,b.textSizeAdjust];
  `)).toEqual([['none','100%'],['calc(100%)','100%'],'0%']);
});

test('transition timing lists compute independently and reject invalid replacements', async () => {
  expect(await evaluate(`
    one.style.webkitTransitionDuration='250ms, 2s';one.style.transitionDuration='auto';
    one.style.transitionDelay='-125ms';one.style.transitionTimingFunction='steps(2,end)';
    one.style.transitionBehavior='allow-discrete, normal';
    return [one.style.transitionDuration,a.transitionDuration,a.webkitTransitionDelay,a.transitionTimingFunction,a.transitionBehavior];
  `)).toEqual(['250ms, 2s','0.25s, 2s','-0.125s','steps(2)','allow-discrete, normal']);
});

test('transition-property preserves custom names and permits none only on its own', async () => {
  expect(await evaluate(`
    const initial=a.transitionProperty;
    one.style.webkitTransitionProperty='OPACITY, --Foo, Unknown';
    one.style.transitionProperty='none, opacity';one.style.transitionProperty='default';
    const list=a.transitionProperty;one.style.transitionProperty='NONE';
    return [initial,list,one.style.transitionProperty,a.webkitTransitionProperty];
  `)).toEqual(['all','opacity, --Foo, Unknown','none','none']);
});

test('transition shorthand resolves substituted lists and resets omitted behavior', async () => {
  expect(await evaluate(`
    one.style.cssText='--times:250ms linear;transition:opacity var(--times) 1s allow-discrete, color 2s';
    return [a.transitionProperty,a.transitionDuration,a.transitionDelay,a.transitionBehavior,a.webkitTransition];
  `)).toEqual(['opacity, color','0.25s, 2s','1s, 0s','allow-discrete, normal','opacity 0.25s linear 1s allow-discrete, color 2s']);
});

test('invalid transition assignments preserve the previous shorthand', async () => {
  expect(await evaluate(`
    one.style.transition='opacity 2s';
    one.style.webkitTransition='opacity 1s 2s 3s';
    one.style.setProperty('transition','opacity,,color');
    const previous=[one.style.transition,a.transitionDuration];
    one.style.transition='';
    return [...previous,one.style.transition,a.transitionDuration];
  `)).toEqual(['opacity 2s','2s','','0s']);
});

test('animation names preserve case and quoted commas and reject malformed lists', async () => {
  expect(await evaluate(`
    const initial=a.animationName;
    one.style.animation='1s "slide, left"';
    const fromShorthand=a.animationName;
    one.style.webkitAnimationName='FadeIn, NONE';
    one.style.animationName='spin, inherit';
    return [initial,fromShorthand,one.style.animationName,a.webkitAnimationName];
  `)).toEqual(['none','"slide, left"','FadeIn, none','FadeIn, none']);
});

test('animation shorthand participates in the cascade per longhand after substitution', async () => {
  expect(await evaluate(`
    const sheet=document.createElement('style');
    sheet.textContent='#one { animation-delay:3s!important; animation:fade 2s linear; } #two { animation:var(--motion)!important; --motion:slide 4s; }';
    document.head.appendChild(sheet);
    two.style.animationDuration='8s';
    return [a.animationName,a.animationDelay,b.animationName,b.animationDuration];
  `)).toEqual(['fade','3s','slide','4s']);
});

test('prefixed font smoothing validates keywords and inherits through the cascade', async () => {
  expect(await evaluate(`
    one.append(two);
    const initial=b.webkitFontSmoothing;
    one.style.WebkitFontSmoothing='ANTIALIASED';
    one.style.webkitFontSmoothing='invalid';
    return [initial,one.style.getPropertyValue('-webkit-font-smoothing'),b.webkitFontSmoothing,
      CSS.supports('-webkit-font-smoothing','subpixel-antialiased')];
  `)).toEqual(['auto','antialiased','antialiased',true]);
});

test('tap highlight color inherits and resolves currentcolor on each element', async () => {
  expect(await evaluate(`
    one.append(two);
    const initial=a.webkitTapHighlightColor;
    one.style.WebkitTapHighlightColor='currentcolor';
    one.style.webkitTapHighlightColor='none';
    return [initial,a.webkitTapHighlightColor,b.getPropertyValue('-webkit-tap-highlight-color'),
      CSS.supports('-webkit-tap-highlight-color','transparent')];
  `)).toEqual(['rgba(0, 0, 0, 0.18)','rgb(255, 0, 0)','rgb(0, 128, 0)',true]);
});

test('mask-size aliases share layer sizing and resolve lengths independently of the background', async () => {
  expect(await evaluate(`
    one.append(two);
    one.style.fontSize='20px';
    one.style.webkitMaskSize='2em 25%, cover';
    one.style.maskSize='auto cover';
    const initial=b.maskSize;
    two.style.maskSize='inherit';
    return [one.style.getPropertyValue('-webkit-mask-size'),a.maskSize,initial,b.WebkitMaskSize,a.backgroundSize,
      CSS.supports('-webkit-mask-size','contain, 50% auto')];
  `)).toEqual(['2em 25%, cover','40px 25%, cover','auto','40px 25%, cover','auto',true]);
});

test('mask repeat validates layer pairs and resolves variables independently of background repeat', async () => {
  expect(await evaluate(`
    one.append(two);
    one.style.webkitMaskRepeat='ROUND space, no-repeat no-repeat';
    one.style.maskRepeat='repeat-x space';
    const declared=one.style.maskRepeat;
    two.style.maskRepeat='inherit';
    const inherited=b.webkitMaskRepeat;
    one.style.setProperty('--tile','repeat-y');
    one.style.setProperty('-webkit-mask-repeat','var(--tile), space');
    return [declared,inherited,b.maskRepeat,a.backgroundRepeat,CSS.supports('mask-repeat','space,,repeat')];
  `)).toEqual(['round space, no-repeat','round space, no-repeat','repeat-y, space','repeat',false]);
});

test('mask-image shares image list parsing across CSSOM spellings', async () => {
  expect(await evaluate(`
    one.append(two);
    one.style.webkitMaskImage='linear-gradient(black, transparent), url(https://example.test/mask.png)';
    one.style.maskImage='none,,none';
    const layers=a.maskImage;
    two.style.maskImage='inherit';
    const inherited=b.WebkitMaskImage;
    one.style.setProperty('--layer','none');
    one.style.setProperty('-webkit-mask-image','var(--layer)');
    return [layers,inherited,b.maskImage,a.backgroundImage,CSS.supports('mask-image','bogus')];
  `)).toEqual([
    'linear-gradient(black, transparent), url("https://example.test/mask.png")',
    'linear-gradient(black, transparent), url("https://example.test/mask.png")','none','none',false]);
});
