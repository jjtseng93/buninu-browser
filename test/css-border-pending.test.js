import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';
import {parseCSSOMRules,renderStyleSheet} from '../lib/renderer/stylesheet-parser.js';
import {RendererHost} from '../lib/renderer/host.js';
import {pendingBorderDeclarations} from '../lib/happy-dom/css-border-pending.js';

function fixture(run) {
  const {window,document}=parseHTMLDocument('<main id=parent><div id=box></div></main>');
  try {run({window,document,box:document.getElementById('box'),parent:document.getElementById('parent')});}
  finally {window.happyDOM.close();}
}
const result=(document,box,sheets=[])=>new StyleEngine().compute(document,sheets).get(box);

test('pending border shorthands retain only their surviving physical components',()=>fixture(({document,box})=>{
  const s=box.style;
  s.cssText='BORDER:1px solid red;Border-Left-Width:5px';
  expect(result(document,box).borderWidths).toEqual([1,1,1,5]);
  for(const variable of ['var(--edge)','VAR(--日本)']) {
    s.cssText=`--edge:2px solid red;--日本:2px solid red;border:${variable}`;
    expect(s.border).toBe(variable);
    expect([s.borderWidth,s.borderStyle,s.borderColor,s.borderLeftWidth]).toEqual(['','','','']);
    s.borderLeftWidth='5px';expect(s.border).toBe('');expect(s.borderLeftWidth).toBe('5px');
    expect(result(document,box).borderWidths).toEqual([2,2,2,5]);
    s.removeProperty('border-right-style');
    expect(result(document,box).borderWidths).toEqual([2,0,2,5]);
    s.removeProperty('border-left-width');
    expect(result(document,box).borderWidths).toEqual([2,0,2,3]);
    s.borderTopColor='blue';expect(result(document,box).borderColors).toEqual(['rgba(0, 0, 255, 1)',...Array(3).fill('rgba(255, 0, 0, 1)')]);
    s.setProperty('--edge','4px dotted green');s.setProperty('--日本','4px dotted green');
    expect(result(document,box).borderWidths).toEqual([4,0,4,3]);
    s.removeProperty('border');expect(result(document,box).borderWidths).toEqual([0,0,0,0]);
  }
  s.cssText='--edge:2px solid red;border:var(--edge);border-left-width:5px';
  s.setProperty('--edge','broken');expect(result(document,box).borderWidths).toEqual([0,0,0,0]);
  expect(result(document,box).borderSpecifiedWidths).toEqual([3,3,3,5]);
  s.cssText='--widths:2px 4px;--side:9px dotted blue;border-style:solid;border-width:var(--widths);border-left:var(--side)';
  expect(result(document,box).borderWidths).toEqual([2,4,2,9]);
  s.removeProperty('border-left');expect(result(document,box).borderWidths).toEqual([2,4,2,0]);
  s.cssText='--edge:2px solid red;border:var(--edge);border-image-source:url(example.png)';
  s.borderLeft='3px solid blue';s.removeProperty('border-left');
  expect(s.borderImageSource).toBe('url("example.png")');
  expect(result(document,box).borderWidths).toEqual([2,2,2,0]);
  s.cssText='border:2px solid red;border-image-source:url(example.png)';
  expect(s.border).toBe('');s.cssText=s.cssText;expect(s.borderImageSource).toBe('url("example.png")');
}));

test('border priority is resolved independently per longhand in CSS text and across rules',()=>fixture(({document,box})=>{
  for(const source of [
    '--edge:2px solid red;border-left-width:5px!important;border:var(--edge)',
    '--edge:2px solid red;border:var(--edge);border-left-width:5px!important',
  ]) {
    box.style.cssText=source;
    expect(result(document,box).borderWidths).toEqual([2,2,2,5]);
    expect(box.style.getPropertyPriority('border-left-width')).toBe('important');
    box.style.borderLeftWidth='7px';expect(box.style.getPropertyPriority('border-left-width')).toBe('');
    expect(result(document,box).borderWidths).toEqual([2,2,2,7]);
  }
  box.style.cssText='--edge:2px solid red;border:var(--edge)!important;border-left-width:5px';
  expect(result(document,box).borderWidths).toEqual([2,2,2,2]);
  box.removeAttribute('style');
  expect(result(document,box,['#box {--edge:2px solid red;border:var(--edge)!important} div {border-left-width:5px}']).borderWidths).toEqual([2,2,2,2]);
  expect(result(document,box,['#box {--edge:2px solid red;border:var(--edge)} div {border-left-width:5px!important}']).borderWidths).toEqual([2,2,2,5]);
}));

test('pending border and overflow use the same source order around all, logical axes and ordinary shorthands',()=>fixture(({document,box})=>{
  for(const [source,widths,overflow,margin] of [
    ['margin:5px;padding:2px;all:initial;border:var(--edge);border-left-width:9px;overflow:var(--scroll);overflow-x:scroll',[2,2,2,9],['scroll','hidden'],[0,0,0,0]],
    ['border:var(--edge);border-left-width:9px;overflow:var(--scroll);overflow-x:scroll;all:initial; margin:5px',[0,0,0,0],['visible','visible'],[5,5,5,5]],
    ['border:var(--edge);all:initial;border-left:var(--side);overflow:var(--scroll);overflow-inline:clip',[0,0,0,4],['clip','hidden'],[0,0,0,0]],
    ['overflow:var(--scroll);all:initial;border:var(--edge);overflow-block:scroll',[2,2,2,2],['auto','scroll'],[0,0,0,0]],
  ]) {
    box.style.cssText=`--edge:2px solid red;--side:4px dotted green;--scroll:auto hidden;${source}`;
    const s=result(document,box);expect(s.borderWidths).toEqual(widths);
    expect([s.overflowValueX,s.overflowValueY]).toEqual(overflow);expect(s.margin).toEqual(margin);
  }
  for(const source of ['border:var(--edge);all:initial','all:initial;border:var(--edge)','border:2px solid red;all:initial','all:initial;border:2px solid red']) {
    box.style.cssText=`--edge:2px solid red;${source}`;
    const before=result(document,box).borderWidths;
    box.style.cssText=box.style.cssText;
    expect(result(document,box).borderWidths).toEqual(before);
  }
}));

test('mutated stylesheet snapshots preserve partial border and overflow without reordering ordinary declarations',()=>fixture(({window,document,box})=>{
  const rules=parseCSSOMRules(window,'#box {--edge:2px solid red;--scroll:auto hidden;margin:5px;all:initial;border:var(--edge);overflow:var(--scroll)}',null);
  rules[0].style.borderLeftWidth='7px';rules[0].style.overflowX='scroll';
  const read=()=>result(document,box,[renderStyleSheet(rules)]);
  expect(read().borderWidths).toEqual([2,2,2,7]);expect(read().margin).toEqual([0,0,0,0]);
  expect([read().overflowValueX,read().overflowValueY]).toEqual(['scroll','hidden']);
  rules[0].style.removeProperty('border-top-width');expect(read().borderWidths).toEqual([3,2,2,7]);
  rules[0].style.setProperty('--edge','4px dotted blue');expect(read().borderWidths).toEqual([3,4,4,7]);
  rules[0].style.all='initial';expect(read().borderWidths).toEqual([0,0,0,0]);
  const source='--a:2px solid red;--b:4px solid blue;border:var(--a);border-left-width:7px';
  const sameTextRules=parseCSSOMRules(window,`#box{${source}}`,null),rule=sameTextRules[0];
  const before=rule.style.cssText;
  expect(result(document,box,[renderStyleSheet(sameTextRules)]).borderWidths).toEqual([2,2,2,7]);
  rule.style.cssText=source.replace('var(--a)','var(--b)');
  expect(rule.style.cssText).toBe(before);expect(rule.renderUsesCSSOM).toBe(true);
  expect(result(document,box,[renderStyleSheet(sameTextRules)]).borderWidths).toEqual([4,4,4,7]);
}));

test('ordinary border serialization preserves font, background and box resets across all',()=>fixture(({document,box})=>{
  for(const source of [
    'font:italic 20px serif;background:red;margin:4px;padding:2px;all:initial;border:2px solid blue',
    'border:2px solid blue;all:initial;font:italic 20px serif;background:red;margin:4px;padding:2px',
    'font:italic 20px serif;border:2px solid blue;background:red;all:initial',
    'all:initial;font:italic 20px serif;border:2px solid blue;background:red',
  ]) {
    const expected=result(document,box,[`#box{${source}}`]);
    box.style.cssText=source;
    const actual=result(document,box);
    for(const field of ['fontSize','fontStyle','fontFamily','backgroundColor','margin','padding','borderWidths'])expect(actual[field]).toEqual(expected[field]);
    box.style.cssText=box.style.cssText;
    const roundTrip=result(document,box);
    for(const field of ['fontSize','fontStyle','fontFamily','backgroundColor','margin','padding','borderWidths'])expect(roundTrip[field]).toEqual(expected[field]);
    box.removeAttribute('style');
  }
  box.style.cssText='border-top:inherit';expect(box.style.cssText).toBe('border-top: inherit;');
  box.style.borderTopWidth='medium';expect(box.style.borderTop).toBe('');
  box.style.borderColor='rgba(117,117,117,1)';expect(box.style.borderColor).toBe('rgb(117, 117, 117)');
}));

test('external style attribute changes invalidate pending metadata even when the text is unchanged',()=>fixture(({document,box})=>{
  const source='--edge:2px solid red;border:var(--edge);border-left-width:5px';
  for(const change of [
    ()=>box.setAttribute('style',box.style.cssText),
    ()=>box.getAttributeNode('style').value=box.style.cssText,
    ()=>box.style.cssText=box.style.cssText,
  ]) {
    box.style.cssText=source;expect(result(document,box).borderWidths).toEqual([2,2,2,5]);
    change();expect(result(document,box).borderWidths).toEqual([0,0,0,0]);
    expect(result(document,box).borderSpecifiedWidths).toEqual([3,3,3,5]);
  }
  box.style.cssText=source;
  box.setAttributeNS('urn:other','style','border:20px solid blue');
  expect(result(document,box).borderWidths).toEqual([2,2,2,5]);
  box.removeAttribute('style');expect(result(document,box).borderWidths).toEqual([0,0,0,0]);
  box.setAttributeNS(null,'style','border:7px solid blue');expect(result(document,box).borderWidths).toEqual([7,7,7,7]);
}));

test('reading CSSOM leaves the renderer original inline and stylesheet declarations authoritative',()=>fixture(({window,document,box})=>{
  const source='--edge:2px solid red;border:var(--edge);font-size:clamp(10px,20px,30px)';
  box.setAttribute('style',source);
  expect(result(document,box).fontSize).toBe(20);
  void box.style.cssText;void box.style.border;
  expect(result(document,box).fontSize).toBe(20);
  box.removeAttribute('style');
  const rules=parseCSSOMRules(window,`#box {${source}}`,null);
  expect(result(document,box,[renderStyleSheet(rules)]).fontSize).toBe(20);
  void rules[0].style.cssText;void rules[0].style.border;
  expect(result(document,box,[renderStyleSheet(rules)]).fontSize).toBe(20);
  rules[0].style.borderLeftWidth='9px';
  expect(result(document,box,[renderStyleSheet(rules)]).borderWidths).toEqual([2,2,2,9]);
  const nativeSheet=new window.CSSStyleSheet();nativeSheet.replaceSync('div {}');
  nativeSheet.cssRules[0].style.cssText='--edge:2px solid red;border:var(--edge);border-left-width:7px';
  const snapshot=pendingBorderDeclarations(nativeSheet.cssRules[0].style);
  expect(snapshot?.find(item=>item.name==='border-top-width')?.pendingBorder).toBe('border');
  expect(snapshot?.find(item=>item.name==='border-left-width')?.value).toBe('7px');
}));

test('renderer observes live inline and stylesheet pending source changes after cached computed reads',async()=>{
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:`<!doctype html><style>#box {--edge:2px solid red;border:var(--edge)}</style><div id=box></div>`});await host.call('whenLoaded');
    expect(await host.call('evaluate',`(()=>{const box=document.getElementById('box'),s=getComputedStyle(box),read=()=>[s.borderTopWidth,s.borderLeftWidth],out=[read()],rule=document.styleSheets[0].cssRules[0].style;rule.borderLeftWidth='5px';out.push(read());rule.setProperty('--edge','4px dotted blue');out.push(read());rule.removeProperty('border-top-width');out.push(read());box.style.cssText='--local:8px solid green;border:VAR(--local);border-right-width:9px';out.push([s.borderTopWidth,s.borderRightWidth,s.borderLeftWidth]);box.style.setProperty('--local','10px dashed red');out.push([s.borderTopWidth,s.borderRightWidth,s.borderLeftWidth]);return out})()`)).toEqual([['2px','2px'],['2px','5px'],['4px','5px'],['3px','5px'],['8px','9px','8px'],['10px','9px','10px']]);
    expect(await host.call('evaluate',`(()=>{const box=document.getElementById('box');box.removeAttribute('style');document.styleSheets[0].cssRules[0].style.cssText='--edge:2px solid red;border:var(--edge);border-left-width:7px';const s=getComputedStyle(box);return [s.borderTopWidth,s.borderLeftWidth]})()`)).toEqual(['2px','7px']);
    expect(await host.call('evaluate',`(()=>{const source='--a:2px solid red;--b:4px solid blue;border:var(--a);border-left-width:7px',sheet=new CSSStyleSheet();sheet.replaceSync('#box{'+source+'}');document.adoptedStyleSheets=[sheet];const rule=sheet.cssRules[0].style,s=getComputedStyle(document.getElementById('box')),read=()=>[s.borderTopWidth,s.borderLeftWidth],out=[read()],before=rule.cssText;rule.cssText=source.replace('var(--a)','var(--b)');out.push(rule.cssText===before,read());return out})()`)).toEqual([['2px','7px'],true,['4px','7px']]);
  } finally {await host.close();}
});
