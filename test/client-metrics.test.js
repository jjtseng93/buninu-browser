import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {layoutText} from '../lib/layout/text-layout.js';
import {elementBox,elementClientBox} from '../lib/input/hit-test.js';
import {RendererHost} from '../lib/renderer/host.js';

test('client box lookup preserves block geometry while exposing inline replaced boxes',()=>{
  const {window,document}=parseHTMLDocument(`<!doctype html><body style="margin:0">
    <span id=inline style="border:5px solid;padding:3px">text</span>
    <canvas id=bare width=20 height=30></canvas>
    <canvas id=padded width=20 height=30 style="padding:6px"></canvas>
    <svg id=svg style="width:50px;height:100px;padding:30px;border:5px solid;transform:scale(2,3)"></svg>
    <input id=input style="width:100px;height:20px;padding:2px;border:3px solid">
    <div style="display:contents" id=contents>text</div><div style="display:none" id=hidden>hidden</div>`);
  try {
    const styles=new StyleEngine().compute(document),tree=new RenderTreeBuilder().build(document,styles);
    const layout=layoutText(tree,{width:400,height:300,x:0,y:0});
    const found=id=>elementClientBox(tree,layout,document.getElementById(id));
    expect(found('inline')).toBeNull();expect(found('contents')).toBeNull();expect(found('hidden')).toBeNull();
    for(const [id,width,height] of [['bare',20,30],['padded',32,42],['svg',120,170]]) {
      expect(elementBox(tree,layout,document.getElementById(id))).toBeNull();
      const result=found(id);expect(result.box.width).toBe(width);expect(result.box.height).toBe(height);
      expect(found(id)).toBe(result);
    }
    expect(found('input').box).toBe(elementBox(tree,layout,document.getElementById('input')).box);
  }finally{window.happyDOM.close();}
});

test('page client metrics use untransformed padding boxes and active standards-mode roots',async()=>{
  const host=new RendererHost({timeout:20000});
  try {
    await host.start();await host.call('resize',500,400,1);
    await host.call('loadDocument',{url:'https://client-metrics.test/',contentType:'text/html',source:`<!doctype html>
      <style>body{margin:0} .box{width:100px;height:60px;border:5px solid;padding:7px}
      #scaled{transform:scale(2,3)}#ancestor{transform:scale(3)}#scroller{overflow:auto}
      #inner{width:300px;height:200px}#atomic{display:inline-block}#none{display:none}
      #contents{display:contents}#svg{width:50px;height:100px;padding:30px;border:5px solid;transform:scale(2,3)}
      #input,#area{width:300px;height:200px;border:10px solid;border-left-width:20px;border-right-width:20px;padding:2px;box-sizing:content-box}
      #table{border:8px solid;width:40px;height:30px;transform:scale(2)}</style>
      <div id=scaled class=box></div><div id=ancestor><div id=child class=box></div></div>
      <span id=inline class=box>inline</span><span id=atomic class=box>atomic</span>
      <div id=scroller class=box><div id=inner></div></div>
      <canvas id=bare width=20 height=30></canvas><canvas id=padded width=20 height=30 style="padding:6px"></canvas>
      <svg id=svg></svg><input id=input><textarea id=area></textarea>
      <div id=none><div id=hiddenchild class=box></div></div><div id=contents><div class=box></div></div>
      <table id=table></table>`});
    await host.call('whenLoaded');
    const evaluate=source=>host.call('evaluate',source);
    await evaluate(`window.cm=e=>[e.clientWidth,e.clientHeight,e.clientLeft,e.clientTop];window.by=id=>document.getElementById(id)`);
    for(const id of ['scaled','child','atomic','scroller'])expect(await evaluate(`cm(by('${id}'))`)).toEqual([114,74,5,5]);
    expect(await evaluate(`by('scaled').getBoundingClientRect().width>by('scaled').clientWidth`)).toBe(true);
    for(const id of ['inline','none','hiddenchild','contents'])expect(await evaluate(`cm(by('${id}'))`)).toEqual([0,0,0,0]);
    expect(await evaluate(`cm(by('bare'))`)).toEqual([20,30,0,0]);
    expect(await evaluate(`cm(by('padded'))`)).toEqual([32,42,0,0]);
    expect(await evaluate(`cm(by('svg'))`)).toEqual([110,160,5,5]);
    for(const id of ['input','area'])expect(await evaluate(`cm(by('${id}'))`)).toEqual([304,204,20,10]);
    expect(await evaluate(`cm(by('table'))`)).toEqual([56,46,0,0]);
    expect(await evaluate(`cm(document.documentElement)`)).toEqual([500,400,0,0]);
    expect(await evaluate(`cm(document.implementation.createHTMLDocument('').documentElement)`)).toEqual([0,0,0,0]);
    expect(await evaluate(`cm(document.createElement('div'))`)).toEqual([0,0,0,0]);
    expect(await evaluate(`by('scroller').scrollTo(100,80);[...cm(by('scroller')),by('scroller').scrollLeft,by('scroller').scrollTop]`)).toEqual([114,74,5,5,100,80]);
    expect(await evaluate(`by('scaled').style.width='150px';cm(by('scaled'))`)).toEqual([164,74,5,5]);
    expect(await evaluate(`document.documentElement.style.display='none';cm(document.documentElement)`)).toEqual([500,400,0,0]);
    expect(await evaluate(`cm(by('scaled'))`)).toEqual([0,0,0,0]);
    expect(await evaluate(`document.documentElement.style.display='';document.body.style.display='none';cm(document.body)`)).toEqual([0,0,0,0]);
    expect(await evaluate(`cm(by('scaled'))`)).toEqual([0,0,0,0]);
    expect(await evaluate(`document.body.style.display='contents';cm(document.body)`)).toEqual([0,0,0,0]);
    expect(await evaluate(`cm(by('scaled'))`)).toEqual([164,74,5,5]);
    expect(await evaluate(`document.body.style.display='inline';cm(document.body)`)).toEqual([0,0,0,0]);
    for(const rule of ['position:absolute','position:fixed','float:left']) {
      expect(await evaluate(`document.body.style.cssText='display:inline;${rule}';document.body.clientWidth>0`)).toBe(true);
    }
    for(const display of ['flex','grid']) {
      expect(await evaluate(`document.body.style.cssText='display:inline';document.documentElement.style.display='${display}';document.body.clientWidth>0`)).toBe(true);
    }
  }finally{await host.close();}
},30000);

test('root dimensions avoid synchronous restyles and preserve pending descendant layout',async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/client-metrics-lazy.js',import.meta.url).pathname],
    {stdout:'pipe',stderr:'pipe'});
  const [exit,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(exit).toBe(0);
},30000);
