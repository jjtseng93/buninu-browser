import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine, parseDeclarations, supportsDeclaration} from '../lib/style/computed-style.js';
import {normalizeOverflow} from '../lib/style/overflow-values.js';
import {RendererHost} from '../lib/renderer/host.js';

test('overflow CSSOM validates axis grammar and expands physical shorthands', () => {
  const {window,document} = parseHTMLDocument('<div></div>');
  try {
    const style = document.querySelector('div').style;
    style.overflow = 'SCROLL /**/ auto';
    expect([style.overflow,style.overflowX,style.overflowY]).toEqual(['scroll auto','scroll','auto']);
    style.overflowY = 'scroll';expect(style.overflow).toBe('scroll');
    for(const [property,value] of [['overflow','none'],['overflow','auto auto clip'],['overflow-x','visible clip'],['overflow-block','hidden scroll'],['overflow-inline','1'],['overflow-y','"clip"'],['overflow','var(foo)']]) {
      style.setProperty(property,'hidden');style.setProperty(property,value);
      expect(style.getPropertyValue(property)).toBe('hidden');
      expect(supportsDeclaration(property,value)).toBe(false);
      expect(parseDeclarations(`${property}:hidden;${property}:${value}`).get(property).value).toBe('hidden');
    }
    for(const property of ['overflow','overflow-x','overflow-y','overflow-inline','overflow-block']) {
      for(const value of ['clip','scroll','overlay','inherit','initial','unset','revert','revert-layer','var(--overflow)'])
        expect(supportsDeclaration(property,value)).toBe(true);
    }
    style.cssText='overflow-x:scroll!important;overflow-y:auto';expect(style.overflow).toBe('');
    style.setProperty('overflow-y','auto','important');expect(style.overflow).toBe('scroll auto');
    expect(style.removeProperty('overflow')).toBe('scroll auto');
    expect([style.overflow,style.overflowX,style.overflowY]).toEqual(['','','']);
    style.overflowX='var(--x)';style.overflowY='auto';expect(style.overflow).toBe('');
    expect(normalizeOverflow('overflow',String.raw`\73 croll auto`)).toBe('scroll auto');
    expect(normalizeOverflow('overflow','vis/**/ible')).toBeNull();
    expect(normalizeOverflow('overflow','\u00a0visible')).toBeNull();
    expect(normalizeOverflow('overflow','inherit auto')).toBeNull();
  } finally {window.happyDOM.close();}
});

test('overflow resolves both axes after cascade without losing wheel and clip flags', () => {
  const {window,document} = parseHTMLDocument(`<div id=parent><div id=mixed></div><div id=single></div><div id=inherited></div><div id=reset></div><div id=vars></div><div id=invalid></div><div id=logical></div></div>`);
  try {
    const styles = new StyleEngine().compute(document,[`
      #parent {overflow:scroll hidden}
      #mixed {overflow-x:visible;overflow-y:hidden}
      #single {overflow:auto clip}
      #inherited {overflow:inherit}
      #reset {overflow:hidden;all:initial}
      #vars {--o:scroll hidden;overflow:var(--o)}
      #invalid {overflow:scroll;overflow:var(--no);--no:nonsense}
      #logical {overflow:visible;overflow-inline:scroll;overflow-block:hidden}
    `]);
    const value = id => {
      const s=styles.get(document.getElementById(id));
      return [s.overflowValueX,s.overflowValueY,s.overflowX,s.overflowY,s.overflowScrollX,s.overflowScrollY];
    };
    expect(value('mixed')).toEqual(['auto','hidden','clip','clip','auto','hidden']);
    expect(value('single')).toEqual(['auto','clip','clip','clip','auto',null]);
    for(const id of ['parent','inherited','vars','logical'])
      expect(value(id)).toEqual(['scroll','hidden','clip','clip','auto','hidden']);
    for(const id of ['reset','invalid']) expect(value(id)).toEqual(['visible','visible','visible','visible',null,null]);
  } finally {window.happyDOM.close();}
});

test('overflow CSS-text priorities and partially replaced pending axes retain their source', () => {
  const {window,document}=parseHTMLDocument('<div id=box></div>');
  try {
    const element=document.getElementById('box'),style=element.style;
    style.cssText='overflow-x:scroll!important;overflow:hidden';
    expect([style.overflowX,style.overflowY,style.getPropertyPriority('overflow-x')]).toEqual(['scroll','hidden','important']);
    style.overflowX='clip';expect(style.getPropertyPriority('overflow-x')).toBe('');
    const computed=()=>{const s=new StyleEngine().compute(document).get(element);return [s.overflowValueX,s.overflowValueY];};
    style.cssText='--o:hidden clip;overflow:var(--o)';
    expect([style.length,style.overflowX,style.overflowY,style.overflow]).toEqual([3,'','','var(--o)']);
    expect(computed()).toEqual(['hidden','clip']);
    expect(style.removeProperty('overflow-x')).toBe('');
    expect([style.overflow,style.overflowX,style.overflowY]).toEqual(['','','']);
    expect(computed()).toEqual(['visible','clip']);
    style.setProperty('--o','auto hidden');expect(computed()).toEqual(['auto','hidden']);
    style.cssText='--o:hidden clip;overflow:var(--o)!important;overflow-x:scroll';
    expect([style.overflow,style.getPropertyPriority('overflow-x')]).toEqual(['var(--o)','important']);
    expect(computed()).toEqual(['hidden','clip']);
    style.overflowX='scroll';
    expect([style.overflow,style.overflowX,style.overflowY,style.getPropertyPriority('overflow-x'),style.getPropertyPriority('overflow-y')]).toEqual(['','scroll','','','important']);
    expect(computed()).toEqual(['scroll','clip']);
    style.setProperty('--o','auto hidden');expect(computed()).toEqual(['scroll','hidden']);
    style.cssText='--o:scroll hidden;overflow:var(--o);all:initial';expect(computed()).toEqual(['visible','visible']);
    style.cssText=style.cssText;expect(computed()).toEqual(['visible','visible']);
    style.cssText='--o:scroll hidden;all:initial;overflow:var(--o)';expect(computed()).toEqual(['scroll','hidden']);
    style.cssText=style.cssText;expect(computed()).toEqual(['scroll','hidden']);
    style.cssText='--o:scroll hidden;overflow:var(--o);overflow-inline:clip';
    expect(computed()).toEqual(['clip','hidden']);
    style.cssText=style.cssText;expect(computed()).toEqual(['clip','hidden']);
    for(const prior of ['overflow-x:hidden','overflow-y:hidden','overflow:var(--o)']) {
      style.cssText=`--o:scroll hidden;${prior};all:initial;overflow:var(--o)`;
      expect(computed()).toEqual(['scroll','hidden']);
      style.cssText=style.cssText;expect(computed()).toEqual(['scroll','hidden']);
    }
    style.cssText='--o:scroll hidden;overflow-x:auto;overflow-inline:clip;overflow:var(--o)';
    expect(computed()).toEqual(['scroll','hidden']);
    style.cssText=style.cssText;expect(computed()).toEqual(['scroll','hidden']);
    style.overflowInline='auto';expect(computed()).toEqual(['auto','hidden']);
    style.overflowX='scroll';expect(computed()).toEqual(['scroll','hidden']);
    style.overflowInline='clip';expect(computed()).toEqual(['clip','hidden']);
    for(const suffix of ['overflow:var(--o)','overflow:var(--o);overflow-x:scroll']) {
      style.cssText=`margin:5px;padding:1px;all:initial;border:2px solid red;--o:hidden;${suffix}`;
      const resolved=new StyleEngine().compute(document).get(element);
      expect(resolved.borderWidths).toEqual([2,2,2,2]);
      expect([resolved.overflowValueX,resolved.overflowValueY]).toEqual(suffix.includes('overflow-x')?['scroll','hidden']:['hidden','hidden']);
    }
  } finally {window.happyDOM.close();}
});

test('computed overflow and actual wheel/programmatic scrolling share the same axis policy', async () => {
  const host = new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:`<!doctype html><style>
      body{margin:0}#box{width:100px;height:100px}#content{width:400px;height:400px}
    </style><div id=box style="overflow:scroll hidden"><div id=content>content</div></div>`});
    await host.call('whenLoaded');
    const evaluate = source => host.call('evaluate',source);
    await evaluate(`window.box=document.getElementById('box')`);
    expect(await evaluate(`[getComputedStyle(box).overflow,getComputedStyle(box).overflowInline,getComputedStyle(box).overflowBlock]`)).toEqual(['scroll hidden','scroll','hidden']);
    await host.call('wheel',20,20,30,30);
    expect(await evaluate(`[box.scrollLeft,box.scrollTop]`)).toEqual([30,0]);
    expect(await evaluate(`box.scrollTop=40;box.scrollTop`)).toBe(40);
    await evaluate(`box.scrollLeft=0;box.scrollTop=0;box.style.overflow='auto clip'`);
    await host.call('wheel',20,20,30,30);
    expect(await evaluate(`box.scrollTop=40;[box.scrollLeft,box.scrollTop,getComputedStyle(box).overflow]`)).toEqual([30,0,'auto clip']);
    await evaluate(`box.style.overflow='hidden visible';box.scrollLeft=0;box.scrollTop=0`);
    await host.call('wheel',20,20,30,30);
    expect(await evaluate(`[box.scrollLeft,box.scrollTop,getComputedStyle(box).overflow]`)).toEqual([0,30,'hidden auto']);
    await evaluate(`box.style.overflow='clip visible';box.scrollLeft=40;box.scrollTop=40`);
    expect(await evaluate(`[box.scrollLeft,box.scrollTop,getComputedStyle(box).overflow]`)).toEqual([0,0,'clip visible']);
    await evaluate(`box.style.cssText='width:100px;height:100px;--o:scroll auto;overflow:var(--o)'`);
    expect(await evaluate(`getComputedStyle(box).overflow`)).toBe('scroll auto');
    await evaluate(`box.style.overflowX='hidden'`);
    expect(await evaluate(`getComputedStyle(box).overflow`)).toBe('hidden auto');
    await evaluate(`box.style.cssText='width:100px;height:100px;--o:hidden clip;overflow:var(--o)';box.style.removeProperty('overflow-x')`);
    expect(await evaluate(`getComputedStyle(box).overflow`)).toBe('visible clip');
    expect(await evaluate(`box.scrollLeft=40;box.scrollTop=40;[box.scrollLeft,box.scrollTop]`)).toEqual([0,0]);
    await evaluate(`box.style.overflowX='scroll'`);
    await host.call('wheel',20,20,30,30);
    expect(await evaluate(`[box.scrollLeft,box.scrollTop,getComputedStyle(box).overflow]`)).toEqual([30,0,'scroll clip']);
    await evaluate(`box.style.cssText='width:100px;height:100px';
      const sheet=document.createElement('style');sheet.id='sheet';sheet.textContent='#box{overflow-y:auto!important}@media(min-width:1px){#box{--o:hidden clip;overflow:var(--o)}}';document.head.append(sheet);
      window.sheet=sheet.sheet;window.rule=window.sheet.cssRules[1].cssRules[0];rule.style.overflowX='scroll'`);
    expect(await evaluate(`getComputedStyle(box).overflow`)).toBe('scroll auto');
    await evaluate(`sheet.deleteRule(0)`);
    expect(await evaluate(`getComputedStyle(box).overflow`)).toBe('scroll clip');
    await evaluate(`box.scrollLeft=0;box.scrollTop=0`);await host.call('wheel',20,20,30,30);
    expect(await evaluate(`[box.scrollLeft,box.scrollTop]`)).toEqual([30,0]);
    await evaluate(`rule.style.overflowY='hidden'`);
    expect(await evaluate(`getComputedStyle(box).overflow`)).toBe('scroll hidden');
  } finally {host.close();}
},30000);
