import {afterAll,beforeAll,test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
let host;
beforeAll(async()=>{host=new RendererHost({timeout:20000});await host.start();await host.call('resize',400,300,1);});
afterAll(()=>host?.close());
test('hit stack respects paint order, pointer-events, clipping and viewport bounds',async()=>{
 await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:`<!doctype html><style>body{margin:0} .box{position:absolute;left:10px;top:10px;width:100px;height:100px} #bottom{z-index:1} #top{z-index:2} #ignore{z-index:3;pointer-events:none}</style><div id="bottom" class="box"></div><div id="top" class="box"></div><div id="ignore" class="box"></div>`});await host.call('whenLoaded');
 const state=JSON.parse(await host.call('evaluate',`JSON.stringify({stack:document.elementsFromPoint(20,20).map(e=>e.id||e.localName),first:document.elementFromPoint(20,20).id,outside:document.elementsFromPoint(-1,0).length,empty:document.elementFromPoint(390,290).localName,detached:document.implementation.createHTMLDocument().elementsFromPoint(1,1).length})`));
 expect(state.stack.slice(0,2)).toEqual(['top','bottom']);expect(state.stack).not.toContain('ignore');expect(new Set(state.stack).size).toBe(state.stack.length);expect(state.stack.at(-1)).toBe('html');expect(state.first).toBe('top');expect(state.outside).toBe(0);expect(state.empty).toBe('html');expect(state.detached).toBe(0);
});
