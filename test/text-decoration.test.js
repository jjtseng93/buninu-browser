import {test, expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';
import {loadGraphics} from '../lib/renderer/page-renderer.js';

test('decoration styles stay observable through CSSOM, inheritance and shorthand resets', async () => {
  const host = new RendererHost({timeout:20000});
  try {
    await host.call('loadDocument', {url:'https://style.test/',contentType:'text/html',source:
      '<div style="text-decoration:underline wavy"><span id="box" style="text-decoration-style:inherit">text</span></div>'});
    await host.call('whenLoaded');
    const read = () => host.call('evaluate', `(()=>{
      const s=getComputedStyle(document.getElementById('box'));
      return [s.textDecorationStyle,s.getPropertyValue('text-decoration-style'),s['text-decoration-style']];
    })()`);
    expect(await read()).toEqual(['wavy','wavy','wavy']);
    for (const value of ['solid','double','dotted','dashed','wavy']) {
      await host.call('evaluate', `document.getElementById('box').style.textDecorationStyle=${JSON.stringify(value)}`);
      expect(await read()).toEqual([value,value,value]);
    }
    await host.call('evaluate', "document.getElementById('box').style.textDecorationStyle='sparkly'");
    expect(await read()).toEqual(['wavy','wavy','wavy']);
    expect(await host.call('evaluate',"[CSS.supports('text-decoration-style','wavy'),CSS.supports('text-decoration-style','sparkly')]")).toEqual([true,false]);
    await host.call('evaluate',"document.getElementById('box').style.cssText='--bad:sparkly;text-decoration-style:var(--bad)'");
    expect(await read()).toEqual(['solid','solid','solid']);
    await host.call('evaluate',"document.getElementById('box').style.textDecorationStyle='DOUBLE'");
    expect(await read()).toEqual(['double','double','double']);
    await host.call('evaluate', "document.getElementById('box').style.textDecoration='underline'");
    expect(await read()).toEqual(['solid','solid','solid']);
  } finally {await host.close();}
},30000);

test('CPU text drawing distinguishes all decoration patterns and invalidates cached paragraphs', async () => {
  const host = new RendererHost({timeout:20000});
  const {CanvasKit:kit} = await loadGraphics();
  const capture = async () => {
    const image=kit.MakeImageFromEncoded(Buffer.from(await host.call('screenshot'),'base64'));
    try {
      const pixels=image.readPixels(0,0,{width:image.width(),height:image.height(),
        colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB});
      const red=[];
      for(let i=0;i<pixels.length;i+=4)
        if(pixels[i]>pixels[i+1]+30 && pixels[i]>pixels[i+2]+30) red.push(i);
      return red;
    } finally {image.delete();}
  };
  try {
    await host.call('resize',240,100,1);
    await host.call('loadDocument',{url:'https://style.test/',contentType:'text/html',source:
      '<style>body{margin:8px;background:white}#box{font:32px sans-serif;color:black;text-decoration:underline red}</style><span id="box">MMMMMM</span>'});
    await host.call('whenLoaded');
    const patterns=[];
    for(const value of ['solid','double','dotted','dashed','wavy','solid']) {
      await host.call('evaluate',`document.getElementById('box').style.textDecorationStyle=${JSON.stringify(value)}`);
      const red=await capture();
      expect(red.length).toBeGreaterThan(0);
      patterns.push(JSON.stringify(red));
    }
    expect(new Set(patterns.slice(0,5)).size).toBe(5);
    expect(patterns[5]).toBe(patterns[0]);
    await host.call('evaluate',"document.getElementById('box').style.textDecoration='none'");
    expect(await capture()).toEqual([]);
  } finally {await host.close();}
},30000);
