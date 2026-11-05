import {test, expect} from 'bun:test';
import {serializeComputedColor} from '../lib/style/cssom-color.js';
import {RendererHost} from '../lib/renderer/host.js';

test('CSSOM alpha serialization round-trips every 8-bit alpha', () => {
 for(let alpha=0;alpha<255;alpha++) {
  const result=serializeComputedColor(`rgba(12, 34, 56, ${alpha/255})`);
  expect(Math.round(Number(result.slice(result.lastIndexOf(',')+1,-1))*255)).toBe(alpha);
 }
 expect(serializeComputedColor('rgba(1, 2, 3, 1)')).toBe('rgb(1, 2, 3)');
 expect(serializeComputedColor('rgba(1, 2, 3, 0.5019608)')).toBe('rgba(1, 2, 3, 0.5)');
 expect(serializeComputedColor('rgba(1, 2, 3, 0.2509804)')).toBe('rgba(1, 2, 3, 0.25)');
});
test('page CSSOM colors serialize consistently and remain live', async()=>{
 const host=new RendererHost({timeout:20000});
 try {
  await host.start();
  await host.call('loadDocument',{url:'https://test.local/',source:'<!doctype html><div id="box" style="color:red;background:rgba(2,3,4,.5);border:1px solid currentcolor"></div>',contentType:'text/html'});
  await host.call('whenLoaded');
  expect(await host.call('evaluate',`(()=>{const b=document.getElementById('box'),s=getComputedStyle(b);const r=[s.color,s.backgroundColor,s.borderTopColor,s.getPropertyValue('border-right-color')];b.style.color='blue';r.push(s.color,s.borderTopColor);return r})()`)).toEqual(['rgb(255, 0, 0)','rgba(2, 3, 4, 0.5)','rgb(255, 0, 0)','rgb(255, 0, 0)','rgb(0, 0, 255)','rgb(0, 0, 255)']);
 }finally{await host.close();}
});
