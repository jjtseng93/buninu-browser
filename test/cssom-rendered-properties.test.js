import {test,expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

test('CSSOM exposes rendered inherited, decoration, alignment and SVG styles',async()=>{
 const host=new RendererHost({timeout:20000});
 try{
  await host.start();
  await host.call('loadDocument',{url:'https://test.local/',contentType:'text/html',source:`<!doctype html><div style="direction:rtl;color:green"><div id="box" style="text-decoration:underline;justify-items:center;justify-self:end;list-style-type:square"></div></div><svg><rect id="shape" style="color:blue;fill:currentcolor;stroke:red;stroke-width:3px;fill-opacity:.5;stroke-opacity:.25;fill-rule:evenodd"/></svg>`});
  await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{const s=getComputedStyle(document.getElementById('box')),v=getComputedStyle(document.getElementById('shape'));return [s.direction,s.textDecorationLine,s.textDecorationColor,s.justifyItems,s.justifySelf,s.listStyleType,v.fill,v.stroke,v.strokeWidth,v.fillOpacity,v.strokeOpacity,v.fillRule,v.getPropertyValue('stroke-width'),s['text-decoration-color'],v['stroke-width'],'justify-self' in s]})()`)).toEqual(['rtl','underline','rgb(0, 128, 0)','center','end','square','rgb(0, 0, 255)','rgb(255, 0, 0)','3px','0.5','0.25','evenodd','3px','rgb(0, 128, 0)','3px',true]);
 }finally{await host.close();}
});
