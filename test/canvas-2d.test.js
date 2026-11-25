import { beforeAll, expect, test } from "bun:test";
import CanvasKitInit from "../usr/lib/canvaskit/canvaskit.js";
import { canvasResource, canvasContext, takeCanvasBitmap, resetCanvas, setCanvasKit, disposeDocumentCanvases } from "../lib/renderer/canvas-2d.js";

let CanvasKit;

beforeAll(async () => {
  const wasmBinary = await Bun.file(new URL("../usr/lib/canvaskit/canvaskit.wasm", import.meta.url)).arrayBuffer();
  CanvasKit = await CanvasKitInit({ wasmBinary });
  setCanvasKit(CanvasKit);
});

function canvas(width = 1, height = 1) {
  return { width, height };
}

/**
 * The probe web-animations-next-lite uses to accept a CSS colour.
 * CanvasKit turns a string it cannot parse into black, so the two reads match
 * and the sample is opaque black. A string it can parse reads back the same
 * way both times.
 */
function sample(context, color) {
  context.fillStyle = "#000";
  context.fillStyle = color;
  const first = context.fillStyle;
  context.fillStyle = "#fff";
  context.fillStyle = color;
  if (first !== context.fillStyle) return null;
  context.fillRect(0, 0, 1, 1);
  const data = [...context.getImageData(0, 0, 1, 1).data];
  context.clearRect(0, 0, 1, 1);
  return data;
}

test("a colour reads back stably, and one CanvasKit cannot parse is black", () => {
  const context = canvasContext(canvas(), "2d");
  expect(context.fillStyle).toBe("#000000");
  expect(sample(context, "not-a-color")).toEqual([0, 0, 0, 255]);
  expect(sample(context, "red")).toEqual([255, 0, 0, 255]);
  // Like Chromium, an 8-bit premultiplied backing store rounds RGB at low alpha.
  expect(sample(context, "rgba(1, 2, 3, 0.5)")).toEqual([2, 2, 4, 128]);
  expect(context.getImageData(0, 0, 1, 1).data.length).toBe(4);
  expect(context.getImageData(0, 0, 1, 1).data[3]).toBe(0);
  const glNode = canvas();
  const gl2 = canvasContext(glNode, "webgl2");
  expect(gl2.getParameter(gl2.VERSION)).toContain("WebGL 2.0");
  expect(canvasContext(glNode, "webgl")).toBeNull();
  expect(canvasContext(canvas(), "webgl").getParameter(0x1F01)).toBe("CanvasKit CPU");
});

test("the same canvas keeps one context, and changing width clears it", () => {
  const node = canvas(2, 2);
  const context = canvasContext(node, "2d");
  const fill = context.fillRect;
  expect(canvasContext(node, "2d")).toBe(context);
  context.fillStyle = "blue";
  context.fillRect(0, 0, 2, 2);
  expect(context.getImageData(1, 1, 1, 1).data[2]).toBe(255);
  node.width = 1;
  resetCanvas(node);
  expect(context.fillStyle).toBe("#000000");
  expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([0, 0, 0, 0]);
  expect(context.fillRect).toBe(fill);
  // A method kept before a bitmap reset must draw into the new bitmap.
  context.fillStyle = "red";
  fill(0, 0, 1, 1);
  expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([255, 0, 0, 255]);
});

test("gradient and pattern facades hide native shaders while style identity and drawing survive", () => {
  const node = canvas(2, 2);
  const context = canvasContext(node, "2d");
  const gradient = context.createLinearGradient(0, 0, 2, 0);
  let offsetReads = 0, colorReads = 0;
  gradient.addColorStop({ gradient, valueOf() { offsetReads++; return 0; } },
    { gradient, toString() { colorReads++; return "red"; } });
  expect([offsetReads, colorReads]).toEqual([1, 1]);
  gradient.addColorStop(1, "red");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 2, 2);
  expect(context.fillStyle).toBe(gradient);
  expect([...context.getImageData(0, 0, 1, 1).data]).toEqual([255, 0, 0, 255]);
  expect(Object.keys(gradient)).toEqual(["addColorStop"]);
  for (const name of ["Td", "pe", "ie", "oe"]) expect(gradient[name]).toBeUndefined();
  let invoked = false;
  context.fillStyle = { pe() { invoked = true; throw new Error("private shader protocol"); } };
  context.fillRect(0, 0, 1, 1);
  expect(invoked).toBeFalse();
  expect(context.fillStyle).toBe(gradient);
  context.strokeStyle = gradient;
  expect(context.strokeStyle).toBe(gradient);
  context.save();
  context.fillStyle = "blue";
  context.strokeStyle = "blue";
  context.restore();
  expect(context.fillStyle).toBe(gradient);
  expect(context.strokeStyle).toBe(gradient);
  const radial = context.createRadialGradient(0, 0, 0, 1, 1, 2);
  expect(Object.keys(radial)).toEqual(["addColorStop"]);
  const pattern = context.createPattern(node, "repeat");
  expect(Object.keys(pattern)).toEqual(["setTransform"]);
  for (const name of ["Td", "qf", "pe", "ie", "oe"]) expect(pattern[name]).toBeUndefined();
  resetCanvas(node);
  expect(context.fillStyle).toBe("#000000");
});

test("discarding a document frees its connected and detached canvas pixel buffers", () => {
  const malloc = CanvasKit._malloc;
  const free = CanvasKit._free;
  const allocations = new Map();
  let pixelBytes = 0;
  CanvasKit._malloc = (size) => {
    const pointer = malloc(size);
    allocations.set(pointer, size);
    pixelBytes += size;
    return pointer;
  };
  CanvasKit._free = (pointer) => {
    pixelBytes -= allocations.get(pointer) ?? 0;
    allocations.delete(pointer);
    return free(pointer);
  };
  const document = {};
  try {
    // Ownership follows ownerDocument, even if an element was never inserted.
    const nodes = Array.from({ length: 8 }, () => ({ ownerDocument: document, width: 400, height: 300 }));
    const contexts = nodes.map(node => canvasContext(node, "2d"));
    expect(pixelBytes).toBe(8 * 400 * 300 * 4);
    for (const context of contexts) context.fillRect(0, 0, 1, 1);
    disposeDocumentCanvases(document);
    expect(pixelBytes).toBe(0);
    disposeDocumentCanvases(document);
    expect(pixelBytes).toBe(0);
    expect(() => contexts[0].fillRect(0, 0, 1, 1)).toThrow("discarded");
  } finally {
    disposeDocumentCanvases(document);
    CanvasKit._malloc = malloc;
    CanvasKit._free = free;
  }
});


test("CPU WebGL redraws moved geometry without painting outside its coverage", () => {
  const node=canvas(64,64),gl=canvasContext(node,'webgl'),program=gl.createProgram();
  for(const [type,source] of [[gl.VERTEX_SHADER,'attribute vec2 position; uniform float dx; varying vec3 color; void main(){color=vec3(1.0,0.0,0.0);gl_Position=vec4(position+vec2(dx,0.0),0.0,1.0);}'],
    [gl.FRAGMENT_SHADER,'precision highp float; varying vec3 color; void main(){gl_FragColor=vec4(color,1.0);}']]){
    const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');gl.attachShader(program,shader);
  }
  gl.linkProgram(program);gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-.75,-.5,-.25,-.5,-.5,.5]),gl.STATIC_DRAW);
  const a=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
  const dx=gl.getUniformLocation(program,'dx');
  const pixel=(x,y)=>Array.from(canvasResource(node).image.readPixels(x,y,{width:1,height:1,colorType:CanvasKit.ColorType.RGBA_8888,alphaType:CanvasKit.AlphaType.Unpremul,colorSpace:CanvasKit.ColorSpace.SRGB}));
  gl.clearColor(0,0,1,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,3);
  expect(pixel(16,32)).toEqual([255,0,0,255]);expect(pixel(48,32)).toEqual([0,0,255,255]);
  gl.uniform1f(dx,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,3);
  expect(pixel(16,32)).toEqual([0,0,255,255]);expect(pixel(48,32)).toEqual([255,0,0,255]);
  gl.uniform1f(dx,4);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,3);
  expect(pixel(48,32)).toEqual([0,0,255,255]);expect(gl.getError()).toBe(0);
});

test('CPU WebGL samples uploaded RGBA textures and preserves upload snapshots',()=>{
 const node=canvas(16,16),gl=canvasContext(node,'webgl'),p=gl.createProgram();
 for(const [kind,source] of [[gl.VERTEX_SHADER,'attribute vec2 p; varying vec2 uv; void main(){gl_Position=vec4(p,0.,1.);uv=(p+1.)*.5;}'],[gl.FRAGMENT_SHADER,'precision highp float; varying vec2 uv; uniform sampler2D image; void main(){gl_FragColor=texture2D(image,uv);}']]){
  const s=gl.createShader(kind);gl.shaderSource(s,source);gl.compileShader(s);expect(gl.getShaderInfoLog(s)).toBe('');gl.attachShader(p,s);
 }
 gl.linkProgram(p);gl.useProgram(p);gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
 gl.bindTexture(gl.TEXTURE_2D,gl.createTexture());gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
 gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,2,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([255,0,0,255,0,0,255,255]));gl.drawArrays(gl.TRIANGLES,0,6);
 const read=y=>Array.from(canvasResource(node).image.readPixels(8,y,{width:1,height:1,colorType:CanvasKit.ColorType.RGBA_8888,alphaType:CanvasKit.AlphaType.Unpremul,colorSpace:CanvasKit.ColorSpace.SRGB}));
 expect(read(2)).toEqual([0,0,255,255]);expect(read(13)).toEqual([255,0,0,255]);expect(gl.getError()).toBe(0);
});

test('cached background shading follows moving depth occluders and LEQUAL preserves coplanar copies',()=>{
 const node=canvas(32,32),gl=canvasContext(node,'webgl'),p=gl.createProgram();
 for(const [kind,source]of[[gl.VERTEX_SHADER,'attribute vec2 p;uniform float dx;uniform float z;void main(){gl_Position=vec4(p+vec2(dx,0.),z,1.);}'],[gl.FRAGMENT_SHADER,'precision highp float;uniform vec4 color;void main(){gl_FragColor=color;}']]){
  const sh=gl.createShader(kind);gl.shaderSource(sh,source);gl.compileShader(sh);expect(gl.getShaderInfoLog(sh)).toBe('');gl.attachShader(p,sh);
 }
 gl.linkProgram(p);gl.useProgram(p);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
 gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);
 const dx=gl.getUniformLocation(p,'dx'),z=gl.getUniformLocation(p,'z'),color=gl.getUniformLocation(p,'color');
 const quad=(left,right,offset,depth,rgba)=>{gl.uniform1f(dx,offset);gl.uniform1f(z,depth);gl.uniform4fv(color,rgba);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([left,-1,right,-1,left,1,left,1,right,-1,right,1]),gl.STATIC_DRAW);gl.drawArrays(gl.TRIANGLES,0,6);};
 const pixel=x=>Array.from(canvasResource(node).image.readPixels(x,16,{width:1,height:1,colorType:CanvasKit.ColorType.RGBA_8888,alphaType:CanvasKit.AlphaType.Unpremul,colorSpace:CanvasKit.ColorSpace.SRGB}));
 for(const offset of[0,1,0]){
  gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  quad(-1,0,offset,-.123456789,[1,0,0,1]);quad(-1,1,0,.3,[0,0,1,1]);
  expect(pixel(offset?24:8)).toEqual([255,0,0,255]);expect(pixel(offset?8:24)).toEqual([0,0,255,255]);
 }
 gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
 quad(-1,1,0,.123456789,[1,0,0,1]);quad(-1,1,0,.123456789,[0,1,0,1]);
 const image=canvasResource(node).image.readPixels(0,0,{width:32,height:32,colorType:CanvasKit.ColorType.RGBA_8888,alphaType:CanvasKit.AlphaType.Unpremul,colorSpace:CanvasKit.ColorSpace.SRGB});
 for(let i=0;i<image.length;i+=4)expect(Array.from(image.slice(i,i+4))).toEqual([0,255,0,255]);expect(gl.getError()).toBe(0);
});

test('texture alpha is unpremultiplied in both numeric and CanvasKit fragment paths',()=>{
 for(const native of[false,true]){
  const node=canvas(8,8),gl=canvasContext(node,'webgl'),p=gl.createProgram();
  for(const [kind,source]of[[gl.VERTEX_SHADER,'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'],[gl.FRAGMENT_SHADER,`precision highp float;uniform sampler2D image;void main(){vec4 c=texture2D(image,vec2(.5));${native?'if(c.a<0.)c.r=dFdx(c.a);':''}gl_FragColor=c;}`]]){
   const sh=gl.createShader(kind);gl.shaderSource(sh,source);gl.compileShader(sh);expect(gl.getShaderInfoLog(sh)).toBe('');gl.attachShader(p,sh);
  }
  gl.linkProgram(p);gl.useProgram(p);gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  gl.bindTexture(gl.TEXTURE_2D,gl.createTexture());gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([200,100,50,128]));
  gl.clearColor(0,0,1,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,6);
  const pixel=canvasResource(node).image.readPixels(2,2,{width:1,height:1,colorType:CanvasKit.ColorType.RGBA_8888,alphaType:CanvasKit.AlphaType.Unpremul,colorSpace:CanvasKit.ColorSpace.SRGB});
  for(let i=0;i<4;i++)expect(Math.abs(pixel[i]-[100,50,152,255][i])).toBeLessThanOrEqual(1);
 }
});

test('patterns snapshot actual image sources and survive source drawing and bitmap resets',()=>{
 const document={},source={...canvas(2,2),ownerDocument:document},target={...canvas(4,4),ownerDocument:document};
 const src=canvasContext(source,'2d'),dst=canvasContext(target,'2d');
 try{
  src.fillStyle='red';src.fillRect(0,0,2,2);
  const pattern=dst.createPattern(source,'repeat');
  src.fillStyle='blue';src.fillRect(0,0,2,2);resetCanvas(source);
  dst.fillStyle=pattern;dst.fillRect(0,0,4,4);
  expect([...dst.getImageData(3,3,1,1).data]).toEqual([255,0,0,255]);
  resetCanvas(target);dst.fillStyle=pattern;dst.fillRect(0,0,4,4);
  expect([...dst.getImageData(3,3,1,1).data]).toEqual([255,0,0,255]);
  expect(()=>dst.createPattern({},'repeat')).toThrow(TypeError);
  expect(()=>dst.createPattern(source,'invalid')).toThrow();
 }finally{disposeDocumentCanvases(document);}
});

test('pattern sampling follows the drawing context and survives save/restore and reset',()=>{
  const source=canvas(2,1),src=canvasContext(source,'2d');
  src.fillStyle='red';src.fillRect(0,0,1,1);
  src.fillStyle='blue';src.fillRect(1,0,1,1);
  const target=canvas(8,2),ctx=canvasContext(target,'2d');
  const pattern=src.createPattern(source,'repeat');
  pattern.setTransform({a:4,b:0,c:0,d:1,e:0,f:0});
  ctx.fillStyle=pattern;
  expect(ctx.imageSmoothingEnabled).toBe(true);
  expect(ctx.imageSmoothingQuality).toBe('low');
  ctx.imageSmoothingEnabled=false;
  ctx.save();ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.restore();
  expect(ctx.imageSmoothingEnabled).toBe(false);
  expect(ctx.imageSmoothingQuality).toBe('low');
  ctx.fillRect(0,0,8,1);
  expect([...ctx.getImageData(3,0,1,1).data]).toEqual([255,0,0,255]);
  ctx.imageSmoothingEnabled=true;ctx.fillRect(0,1,8,1);
  const blended=ctx.getImageData(3,1,1,1).data;
  expect(blended[0]).toBeGreaterThan(0);expect(blended[2]).toBeGreaterThan(0);
  resetCanvas(target);
  expect(ctx.imageSmoothingEnabled).toBe(true);
  expect(ctx.imageSmoothingQuality).toBe('low');
});

test('drawImage honors smoothing and zero destination width',()=>{
  const source=canvas(2,1),src=canvasContext(source,'2d');
  src.fillStyle='red';src.fillRect(0,0,1,1);src.fillStyle='blue';src.fillRect(1,0,1,1);
  const target=canvas(8,3),ctx=canvasContext(target,'2d',{resolveImage:canvasResource});
  ctx.imageSmoothingEnabled=false;ctx.drawImage(source,0,0,8,1);
  expect([...ctx.getImageData(3,0,1,1).data]).toEqual([255,0,0,255]);
  ctx.imageSmoothingEnabled=true;ctx.drawImage(source,0,1,8,1);
  const blended=ctx.getImageData(3,1,1,1).data;
  expect(blended[0]).toBeGreaterThan(0);expect(blended[2]).toBeGreaterThan(0);
  ctx.drawImage(source,0,2,0,1);
  expect([...ctx.getImageData(0,2,1,1).data]).toEqual([0,0,0,0]);
});

test('pixel-aligned pattern blits match shader fills including clips, alpha and repetition limits',()=>{
  const source=canvas(3,3),src=canvasContext(source,'2d');
  src.fillStyle='rgba(200,40,20,.5)';src.fillRect(0,0,3,3);
  src.fillStyle='blue';src.fillRect(1,1,1,1);
  for(const repetition of ['repeat','repeat-x','repeat-y','no-repeat']){
    const outputs=[];
    for(const smooth of [false,true]){
      const target=canvas(8,6),ctx=canvasContext(target,'2d');
      ctx.fillStyle='green';ctx.fillRect(0,0,8,6);
      ctx.imageSmoothingEnabled=smooth;ctx.globalAlpha=.6;
      const pattern=ctx.createPattern(source,repetition);
      pattern.setTransform({a:1,b:0,c:0,d:1,e:-1,f:1});ctx.fillStyle=pattern;
      ctx.save();ctx.beginPath();ctx.rect(1,1,6,4);ctx.clip();ctx.translate(1,-1);
      ctx.fillRect(8,7,-12,-10);ctx.restore();
      outputs.push([...ctx.getImageData(0,0,8,6).data]);
    }
    expect(outputs[0]).toEqual(outputs[1]);
  }
});

test('a failed Canvas context constructor releases its raster and restores the factory',()=>{
  const makeCanvas=CanvasKit.MakeCanvas,makeSurface=CanvasKit.MakeSurface,free=CanvasKit.Free;
  let released=0;
  CanvasKit.Free=allocation=>{released++;return free(allocation);};
  CanvasKit.MakeCanvas=(width,height)=>{CanvasKit.MakeSurface(width,height);throw Error('context construction failed');};
  try{
    expect(()=>canvasContext(canvas(4,4),'2d')).toThrow('context construction failed');
    expect(released).toBe(1);
    expect(CanvasKit.MakeSurface).toBe(makeSurface);
  }finally{CanvasKit.MakeCanvas=makeCanvas;CanvasKit.Free=free;}
});

test('drawImage ignores fill color and shaders while preserving globalAlpha and fill state',()=>{
 const document={},source={ownerDocument:document,width:2,height:1},target={ownerDocument:document,width:2,height:1};
 const src=canvasContext(source,'2d'),ctx=canvasContext(target,'2d',{resolveImage:canvasResource});
 try{
  src.fillStyle='red';src.fillRect(0,0,2,1);
  const gradient=ctx.createLinearGradient(0,0,2,0);gradient.addColorStop(0,'transparent');gradient.addColorStop(1,'blue');
  const pattern=ctx.createPattern(source,'repeat');
  for(const style of ['rgba(0,0,255,0)', 'rgba(0,0,255,.25)',gradient,pattern]){
   ctx.clearRect(0,0,2,1);ctx.fillStyle=style;const before=ctx.fillStyle;ctx.globalAlpha=1;ctx.drawImage(source,0,0);
   expect([...ctx.getImageData(0,0,1,1).data]).toEqual([255,0,0,255]);expect(ctx.fillStyle).toBe(before);
   ctx.clearRect(0,0,2,1);ctx.globalAlpha=.5;ctx.drawImage(source,0,0,2,1);
   expect([...ctx.getImageData(0,0,1,1).data]).toEqual([255,0,0,128]);
   ctx.save();ctx.fillStyle='green';ctx.restore();ctx.clearRect(0,0,2,1);ctx.drawImage(source,0,0);
   expect([...ctx.getImageData(0,0,1,1).data]).toEqual([255,0,0,128]);
  }
 }finally{disposeDocumentCanvases(document)}
});

test('image paints keep blend state across restore without constructing fill-pattern shaders',()=>{
 const document={},source={ownerDocument:document,width:2,height:1},target={ownerDocument:document,width:2,height:1};
 const src=canvasContext(source,'2d'),ctx=canvasContext(target,'2d',{resolveImage:canvasResource});
 const make=CanvasKit.Image.prototype.makeShaderOptions;let shaders=0;
 try{
  src.fillStyle='red';src.fillRect(0,0,2,1);ctx.fillStyle=ctx.createPattern(source,'repeat');
  CanvasKit.Image.prototype.makeShaderOptions=function(...args){shaders++;return make.apply(this,args)};
  for(let i=0;i<3;i++){ctx.save();ctx.globalAlpha=.5;ctx.globalCompositeOperation='copy';ctx.drawImage(source,0,0);ctx.restore();}
  expect(shaders).toBe(0);
  expect([...ctx.getImageData(0,0,1,1).data]).toEqual([255,0,0,128]);
  ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';ctx.drawImage(source,0,0);
  expect([...ctx.getImageData(0,0,1,1).data]).toEqual([255,0,0,255]);
 }finally{CanvasKit.Image.prototype.makeShaderOptions=make;disposeDocumentCanvases(document)}
});

test('roundRect draws rounded corners, mirrors negative dimensions and rejects invalid radii',()=>{
 const context=canvasContext(canvas(40,40),'2d');
 expect('roundRect' in context).toBe(true);
 context.fillStyle='red';context.beginPath();context.roundRect(2,2,30,30,8);context.fill();
 expect(context.getImageData(2,2,1,1).data[3]).toBe(0);
 expect([...context.getImageData(17,17,1,1).data]).toEqual([255,0,0,255]);
 expect(context.getImageData(17,3,1,1).data[3]).toBeGreaterThan(200);
 context.clearRect(0,0,40,40);context.beginPath();context.roundRect(32,2,-30,30,[{x:8,y:12},0,0,0]);context.fill();
 expect(context.getImageData(31,2,1,1).data[3]).toBe(0);
 expect(context.getImageData(2,2,1,1).data[3]).toBeGreaterThan(200);
 expect(()=>context.roundRect(0,0,20,20,-1)).toThrow(RangeError);
 expect(()=>context.roundRect(0,0,20,20,[])).toThrow(RangeError);
 expect(()=>context.roundRect(0,0,20,20,[1,2,3,4,5])).toThrow(RangeError);
 context.clearRect(0,0,40,40);context.beginPath();context.roundRect(2,2,10,10,50);context.fill();
 expect(context.getImageData(7,7,1,1).data[3]).toBeGreaterThan(200);
});

test('cached radial rectangles preserve transforms, clip, alpha and mutable stops',()=>{
 for(const scale of [1,1.5]){
  const a=canvas(40,40),b=canvas(40,40),ca=canvasContext(a,'2d'),cb=canvasContext(b,'2d');
  const gradients=[];
  for(const c of [ca,cb]){
   c.translate(.25,.5);c.scale(scale,scale);
   c.beginPath();c.rect(1,2,20,18);c.clip();
   const g=c.createRadialGradient(9,10,0,9,10,20);
   g.addColorStop(0,'red');g.addColorStop(1,'transparent');c.fillStyle=g;gradients.push(g);
  }
  for(let i=0;i<3;i++){
   if(i===2)for(const g of gradients)g.addColorStop(.5,'blue');
   for(const c of [ca,cb]){c.clearRect(-5,-5,60,60);c.globalAlpha=.4;}
   ca.fillRect(.5,1.25,22,20);
   cb.beginPath();cb.rect(.5,1.25,22,20);cb.fill();
   const x=ca.getImageData(0,0,40,40).data,y=cb.getImageData(0,0,40,40).data;
   for(let j=0;j<x.length;j+=4){
    expect(Math.abs(x[j+3]-y[j+3])).toBeLessThanOrEqual(1);
    for(let k=0;k<3;k++)expect(Math.abs(x[j+k]*x[j+3]/255-y[j+k]*y[j+3]/255)).toBeLessThanOrEqual(2);
   }
  }
  for(const node of [a,b]){node.width=1;resetCanvas(node);}
 }
});

test('vertical gradient strips match full shading under scaling and clipping',()=>{
 for(const scale of [1,1.5]){
  const nodes=[canvas(36,36),canvas(36,36)],contexts=nodes.map(n=>canvasContext(n,'2d'));
  for(const c of contexts){
   c.scale(scale,scale);c.beginPath();c.rect(2,3,18,17);c.clip();
   const g=c.createLinearGradient(0,0,0,24);g.addColorStop(0,'red');g.addColorStop(.4,'rgba(0,255,0,.4)');g.addColorStop(1,'blue');c.fillStyle=g;c.globalAlpha=.6;
  }
  contexts[0].fillRect(0,0,24,24);contexts[1].beginPath();contexts[1].rect(0,0,24,24);contexts[1].fill();
  const [x,y]=contexts.map(c=>c.getImageData(0,0,36,36).data);
  for(let j=0;j<x.length;j+=4){
   expect(Math.abs(x[j+3]-y[j+3])).toBeLessThanOrEqual(1);
   for(let k=0;k<3;k++)expect(Math.abs(x[j+k]*x[j+3]/255-y[j+k]*y[j+3]/255)).toBeLessThanOrEqual(2);
  }
  for(const n of nodes){n.width=1;resetCanvas(n);}
 }
});

test('WebGL2 instanced strips use the bound vertex array and explicit shader locations', () => {
  const node=canvas(8,4), gl=canvasContext(node,'webgl2');
  const program=gl.createProgram();
  for (const [stage,source] of [
    [gl.VERTEX_SHADER, '#version 300 es\nlayout(location=3) in vec2 quad; layout(location=0) in float column; flat out int tile; void main(){ tile=int(column); gl_Position=vec4(quad.x+column-1.,quad.y,0.,1.); }'],
    [gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; flat in int tile; uniform sampler2D tiles[2]; out vec4 color; void main(){ if(tile==0){color=texture(tiles[0],vec2(.5));}else{color=texture(tiles[1],vec2(.5));} }'],
  ]) {
    const shader=gl.createShader(stage);
    gl.shaderSource(shader,source);gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');
    gl.attachShader(program,shader);
  }
  gl.linkProgram(program);gl.useProgram(program);
  expect(gl.getAttribLocation(program,'quad')).toBe(3);
  const vao=gl.createVertexArray();
  gl.bindVertexArray(vao);
  for(const [slot,size,values,divisor] of [[3,2,[0,-1,1,-1,0,1,1,1],0],[0,1,[0,1],1]]) {
    gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(slot);gl.vertexAttribPointer(slot,size,gl.FLOAT,false,0,0);
    gl.vertexAttribDivisor(slot,divisor);
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint8Array([0,1,2,3]),gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  expect(gl.getParameter(gl.VERTEX_ARRAY_BINDING)).toBeNull();
  gl.bindVertexArray(vao);
  const colors=[[255,0,0,255],[0,255,0,255]];
  for(const [unit,rgba] of colors.entries()){
    gl.activeTexture(gl.TEXTURE0+unit);
    gl.bindTexture(gl.TEXTURE_2D,gl.createTexture());
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(rgba));
  }
  gl.uniform1iv(gl.getUniformLocation(program,'tiles'),new Int32Array([0,1]));
  gl.drawElementsInstanced(gl.TRIANGLE_STRIP,4,gl.UNSIGNED_BYTE,0,2);
  const image=canvasResource(node).image;
  for(const [i,color] of colors.entries()){
    const rgba=image.readPixels(2+i*4,2,{width:1,height:1,colorType:CanvasKit.ColorType.RGBA_8888,alphaType:CanvasKit.AlphaType.Unpremul,colorSpace:CanvasKit.ColorSpace.SRGB});
    expect([...rgba]).toEqual(color);
  }
  expect(gl.getError()).toBe(gl.NO_ERROR);
});

test('WebGL2 framebuffer clears and reads use attachment dimensions and bottom-left scissor coordinates', () => {
  const gl=canvasContext(canvas(3,3),'webgl2');
  gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
  const target=gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER,target);
  const tex=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,tex);gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,2,2);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
  expect(gl.checkFramebufferStatus(gl.FRAMEBUFFER)).toBe(gl.FRAMEBUFFER_COMPLETE);
  gl.enable(gl.SCISSOR_TEST);gl.scissor(0,0,1,1);gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
  const pixels=new Uint8Array(16);gl.readPixels(0,0,2,2,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  expect([...pixels]).toEqual([255,0,0,255,0,0,0,0,0,0,0,0,0,0,0,0]);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);
  gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  expect([...pixels.subarray(0,4)]).toEqual([0,255,0,255]);
  expect(gl.getError()).toBe(gl.NO_ERROR);
});

test('WebGL2 writes each fragment output to its selected attachment and blits to the canvas', () => {
  const gl=canvasContext(canvas(2,2),'webgl2');
  const f=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,f);
  const slots=[gl.COLOR_ATTACHMENT0,gl.COLOR_ATTACHMENT0+1];
  for(const slot of slots){
    const tex=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,2,2);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,slot,gl.TEXTURE_2D,tex,0);
  }
  gl.drawBuffers(slots);
  const program=gl.createProgram();
  for(const [stage,source] of [
    [gl.VERTEX_SHADER,'#version 300 es\nvoid main(){gl_Position=vec4(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.,0.,1.);}'],
    [gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float;layout(location=0) out vec4 a;layout(location=1) out vec4 b;void main(){if(gl_FragCoord.x>1.)discard;a=vec4(1.,0.,0.,1.);b=vec4(0.,0.,1.,1.);}'],
  ]){
    const s=gl.createShader(stage);gl.shaderSource(s,source);gl.compileShader(s);
    expect(gl.getShaderInfoLog(s)).toBe('');gl.attachShader(program,s);
  }
  gl.linkProgram(program);gl.useProgram(program);gl.drawArrays(gl.TRIANGLES,0,3);
  const pixel=new Uint8Array(8);
  for(const [i,slot] of slots.entries()){
    gl.readBuffer(slot);gl.readPixels(0,0,2,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    expect([...pixel]).toEqual([i?0:255,0,i?255:0,255,0,0,0,0]);
  }
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);
  gl.blitFramebuffer(0,0,2,2,2,0,0,2,gl.COLOR_BUFFER_BIT,gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);
  gl.readPixels(0,0,2,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
  expect([...pixel]).toEqual([0,0,0,0,0,0,255,255]);
  expect(gl.getError()).toBe(gl.NO_ERROR);
});

test('WebGL2 stores dynamic uniform array reads in an unclamped float attachment', () => {
  const gl = canvasContext(canvas(2, 1), 'webgl2');
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  const target = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 2, 1);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);

  const program = gl.createProgram();
  for (const [stage, source] of [
    [gl.VERTEX_SHADER, 'void main(){gl_Position=vec4(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.,0.,1.);}'],
    [gl.FRAGMENT_SHADER, 'precision highp float; uniform vec4 colors[2]; out vec4 pixel; void main(){pixel=colors[int(gl_FragCoord.x)];}'],
  ]) {
    const shader = gl.createShader(stage);
    gl.shaderSource(shader, '#version 300 es\n' + source);
    gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  const colors = new Float32Array([2, -.5, .25, 0, 4, 3, .125, 1]);
  gl.uniform4fv(gl.getUniformLocation(program, 'colors[0]'), colors);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const pixels = new Float32Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, pixels);
  expect(pixels).toEqual(colors);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.blitFramebuffer(0, 0, 2, 1, 0, 0, 2, 1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  const display = new Uint8Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.UNSIGNED_BYTE, display);
  expect([...display]).toEqual([255, 0, 64, 0, 255, 255, 32, 255]);
  expect(gl.getError()).toBe(gl.NO_ERROR);
});

test('WebGL2 samples cleared depth textures and clips raster work at tile boundaries', () => {
  const gl = canvasContext(canvas(260, 258), 'webgl2');
  const depthTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, depthTexture);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, 2, 2, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTexture, 0);
  gl.clearDepth(.25);
  gl.clear(gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.SCISSOR_TEST);gl.scissor(0,1,2,1);
  gl.clearDepth(.75);gl.clear(gl.DEPTH_BUFFER_BIT);
  gl.disable(gl.SCISSOR_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const program = gl.createProgram();
  for (const [stage, source] of [
    [gl.VERTEX_SHADER, 'void main(){gl_Position=vec4(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.,0.,1.);}'],
    [gl.FRAGMENT_SHADER, 'precision highp float;uniform sampler2D depthMap;out vec4 color;void main(){vec4 d=texture(depthMap,vec2(.5,gl_FragCoord.y/258.));color=vec4(d.r,gl_FragCoord.x/260.,d.g,d.a);}'],
  ]) {
    const shader = gl.createShader(stage);
    gl.shaderSource(shader, '#version 300 es\n' + source);
    gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const row = new Uint8Array(260 * 4);
  for (const y of [0, 127, 128, 257]) {
    gl.readPixels(0, y, 260, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
    const weight=Math.max(0,Math.min(1,2*(y+.5)/258-.5));
    for (const x of [0, 127, 128, 255, 256, 259]) {
      expect([...row.slice(x * 4, x * 4 + 4)]).toEqual([Math.round((.25+.5*weight)*255), Math.round((x + .5) / 260 * 255), 0, 255]);
    }
  }
  expect(gl.getError()).toBe(gl.NO_ERROR);
});

test('deferred draws sample the previous framebuffer contents before it is cleared again',()=>{
 const gl=canvasContext(canvas(1,2),'webgl2'),texture=gl.createTexture();
 gl.bindTexture(gl.TEXTURE_2D,texture);
 gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,1,2);
 gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
 const fb=gl.createFramebuffer();
 gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
 gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
 gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
 gl.enable(gl.SCISSOR_TEST);gl.scissor(0,1,1,1);
 gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.disable(gl.SCISSOR_TEST);
 gl.bindFramebuffer(gl.FRAMEBUFFER,null);
 const program=gl.createProgram();
 for(const [type,source] of [
  [gl.VERTEX_SHADER,'void main(){gl_Position=vec4(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.,0.,1.);}'],
  [gl.FRAGMENT_SHADER,'precision highp float;uniform sampler2D image;out vec4 color;void main(){color=texture(image,vec2(.5,gl_FragCoord.y*.5));}'],
 ]){
  const stage=gl.createShader(type);gl.shaderSource(stage,'#version 300 es\n'+source);
  gl.compileShader(stage);expect(gl.getShaderInfoLog(stage)).toBe('');gl.attachShader(program,stage);
 }
 gl.linkProgram(program);gl.useProgram(program);gl.drawArrays(gl.TRIANGLES,0,3);
 gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,fb);
 gl.clearColor(0,0,1,1);gl.clear(gl.COLOR_BUFFER_BIT);
 const pixels=new Uint8Array(8);gl.readPixels(0,0,1,2,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
 expect([...pixels]).toEqual([255,0,0,255,0,255,0,255]);
 expect(gl.getError()).toBe(gl.NO_ERROR);
});

test('derivative helper lanes start with independent fragment globals', () => {
  const gl = canvasContext(canvas(2, 2), 'webgl2');
  const program = gl.createProgram();
  for (const [stage, source] of [
    [gl.VERTEX_SHADER, 'void main(){gl_Position=vec4(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.,0.,1.);}'],
    [gl.FRAGMENT_SHADER, `precision highp float;
      float sum=.125;
      float accumulate(){sum+=.125;return dFdx(gl_FragCoord.x);}
      out vec4 color;
      void main(){float dx=accumulate();color=vec4(sum,dx,0.,1.);}`],
  ]) {
    const shader = gl.createShader(stage);
    gl.shaderSource(shader, '#version 300 es\n' + source);
    gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const pixels = new Uint8Array(16);
  gl.readPixels(0, 0, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  for (let i = 0; i < pixels.length; i += 4) expect([...pixels.slice(i, i + 4)]).toEqual([64, 255, 0, 255]);
});

test('derivative helpers interpolate the same primitive across silhouettes and shared edges', () => {
  const gl = canvasContext(canvas(3, 3), 'webgl2');
  // The two triangles have the same slope and markedly different offsets.
  // The helper next to an edge must extrapolate its own triangle's value.
  const vertices = new Float32Array([
    -1,-1,0, 1,-1,1, -1,1,0,
    -1,1,10, 1,-1,11, 1,1,11,
  ]);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  for (const helper of [false, true]) {
    const program = gl.createProgram();
    for (const [stage, source] of [
      [gl.VERTEX_SHADER, 'layout(location=0) in vec3 vertex;out float v;void main(){v=vertex.z;gl_Position=vec4(vertex.xy,0.,1.);}'],
      [gl.FRAGMENT_SHADER, 'precision highp float;in float v;out vec4 color;' +
        (helper ? 'float slope(){return dFdx(v);}' : '') +
        'void main(){color=vec4(' + (helper ? 'slope()' : 'dFdx(v)') + ',abs(dFdy(v)),0.,1.);}'],
    ]) {
      const shader = gl.createShader(stage);
      gl.shaderSource(shader, '#version 300 es\n' + source);
      gl.compileShader(shader);
      expect(gl.getShaderInfoLog(shader)).toBe('');
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const pixels = new Uint8Array(36);
    gl.readPixels(0, 0, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let i = 0; i < pixels.length; i += 4) expect([...pixels.slice(i, i + 4)]).toEqual([85, 0, 0, 255]);
  }
});

test('WebGL boolean arguments reach integer uniforms in fragment shaders', () => {
  const gl = canvasContext(canvas(1, 1), 'webgl2');
  const program = gl.createProgram();
  for (const [stage, source] of [
    [gl.VERTEX_SHADER, 'void main(){gl_Position=vec4(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.,0.,1.);}'],
    [gl.FRAGMENT_SHADER, 'precision highp float;uniform bool visible;uniform int level;out vec4 c;void main(){float n=0.;for(int i=0;i<2;i++){n+=.5;}c=vec4(visible?n:0.,level==2?n:0.,0.,1.);}'],
  ]) {
    const shader = gl.createShader(stage);
    gl.shaderSource(shader, '#version 300 es\n' + source);
    gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, 'level'), 2.9);
  const pixel = new Uint8Array(4);
  for (const visible of [true, false]) {
    gl.uniform1i(gl.getUniformLocation(program, 'visible'), visible);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    expect([...pixel]).toEqual([visible ? 255 : 0, 255, 0, 255]);
  }
});

test('a derivative inside a conditional material call obtains both helper operands', () => {
  const gl = canvasContext(canvas(1, 2), 'webgl2');
  const program = gl.createProgram();
  for (const [stage, source] of [
    [gl.VERTEX_SHADER, 'void main(){gl_Position=vec4(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.,0.,1.);}'],
    [gl.FRAGMENT_SHADER, `precision highp float;
      float slope(float x){return dFdy(x);}
      out vec4 c;
      void main(){
        float y=0.;
        if(gl_FragCoord.y>1.) y=slope(gl_FragCoord.y);
        c=vec4(0.,y,0.,1.);
      }`],
  ]) {
    const shader = gl.createShader(stage);
    gl.shaderSource(shader, '#version 300 es\n' + source);
    gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const pixels = new Uint8Array(8);
  gl.readPixels(0, 0, 1, 2, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  expect([...pixels]).toEqual([0, 0, 0, 255, 0, 255, 0, 255]);
});

test('depth testing passes fragments on buffers without a depth attachment', () => {
  const gl = canvasContext(canvas(1, 1), 'webgl2', {depth: false});
  expect(gl.getContextAttributes().depth).toBe(false);
  const program=gl.createProgram();
  for(const [stage,source] of [
    [gl.VERTEX_SHADER,'void main(){gl_Position=vec4(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.,0.,1.);}'],
    [gl.FRAGMENT_SHADER,'precision mediump float;uniform float green;out vec4 c;void main(){c=vec4(1.-green,green,0.,1.);}'],
  ]){
    const shader=gl.createShader(stage);
    gl.shaderSource(shader,'#version 300 es\n'+source);
    gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');
    gl.attachShader(program,shader);
  }
  gl.linkProgram(program);gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  const green=gl.getUniformLocation(program,'green');
  const fb=gl.createFramebuffer(),tex=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
  for(const target of [null,fb]){
    gl.bindFramebuffer(gl.FRAMEBUFFER,target);
    if(target)gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
    gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    for(const value of [0,1]){
      gl.uniform1f(green,value);
      gl.drawArrays(gl.TRIANGLES,0,3);
    }
    const pixel=new Uint8Array(4);
    gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    expect([...pixel]).toEqual([0,255,0,255]);
  }
  expect(gl.getError()).toBe(gl.NO_ERROR);
});

test('a discarded front fragment leaves a later draw visible through its hole', () => {
  const gl=canvasContext(canvas(2,1),'webgl2');
  const program=gl.createProgram();
  for(const [stage,source] of [
    [gl.VERTEX_SHADER,'uniform float z;void main(){gl_Position=vec4(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.,z,1.);}'],
    [gl.FRAGMENT_SHADER,'precision mediump float;uniform float z;out vec4 c;void main(){if(z<0.&&gl_FragCoord.x<1.)discard;c=vec4(z<0.?1.:0.,z>0.?1.:0.,0.,1.);}'],
  ]){
    const shader=gl.createShader(stage);
    gl.shaderSource(shader,'#version 300 es\n'+source);
    gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');
    gl.attachShader(program,shader);
  }
  gl.linkProgram(program);gl.useProgram(program);gl.enable(gl.DEPTH_TEST);
  const z=gl.getUniformLocation(program,'z');
  for(const distance of [-.5,.5]){
    gl.uniform1f(z,distance);gl.drawArrays(gl.TRIANGLES,0,3);
  }
  const pixels=new Uint8Array(8);
  gl.readPixels(0,0,2,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  expect([...pixels]).toEqual([0,255,0,255,255,0,0,255]);
});

test('a color-masked draw updates depth and subsequent draws respect the comparison function', () => {
  const gl = canvasContext(canvas(1, 1), 'webgl2');
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, 'uniform float z; void main(){gl_Position=vec4(gl_VertexID==1?3.:-1.,gl_VertexID==2?3.:-1.,z,1.);}'],
    [gl.FRAGMENT_SHADER, 'precision mediump float; out vec4 c; void main(){c=vec4(1.);}'],
  ]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, '#version 300 es\n' + source);
    gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.enable(gl.DEPTH_TEST);
  const z = gl.getUniformLocation(program, 'z');
  gl.colorMask(false, false, false, false);
  gl.uniform1f(z, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.colorMask(true, true, true, true);
  gl.depthMask(false);
  for (const [comparison, position, visible] of [
    [gl.GREATER, -.5, false], [gl.GREATER, .5, true],
    [gl.EQUAL, 0, true], [gl.NOTEQUAL, 0, false],
    [gl.GEQUAL, 0, true], [gl.NEVER, -.5, false],
  ]) {
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.depthFunc(comparison);
    gl.uniform1f(z, position);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    expect([...pixel]).toEqual(Array(4).fill(visible ? 255 : 0));
  }
  expect(gl.getError()).toBe(gl.NO_ERROR);
});

test('blended layers within one draw accumulate once per pixel across shared edges', () => {
  const gl=canvasContext(canvas(2,2),'webgl2'),program=gl.createProgram();
  for(const [stage,source] of [
    [gl.VERTEX_SHADER,'in vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'],
    [gl.FRAGMENT_SHADER,'precision mediump float;out vec4 c;void main(){c=vec4(.25,0.,0.,.25);}'],
  ]){
    const shader=gl.createShader(stage);
    gl.shaderSource(shader,'#version 300 es\n'+source);gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');
    gl.attachShader(program,shader);
  }
  gl.linkProgram(program);gl.useProgram(program);
  const quad=[-1,-1,1,-1,-1,1,-1,1,1,-1,1,1];
  gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([...quad,...quad]),gl.STATIC_DRAW);
  const p=gl.getAttribLocation(program,'p');
  gl.enableVertexAttribArray(p);gl.vertexAttribPointer(p,2,gl.FLOAT,false,0,0);
  gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);
  gl.drawArrays(gl.TRIANGLES,0,12);
  const pixels=new Uint8Array(16);
  gl.readPixels(0,0,2,2,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  for(let i=0;i<16;i+=4)expect([...pixels.slice(i,i+4)]).toEqual([128,0,0,128]);
});

test('scanline bounds preserve sample-center coverage for thin and horizontal-edged triangles',()=>{
 const size=64,gl=canvasContext(canvas(size,size),'webgl2'),program=gl.createProgram();
 for(const [type,source] of [
  [gl.VERTEX_SHADER,'in vec2 position;void main(){gl_Position=vec4(position/32.-1.,0.,1.);}'],
  [gl.FRAGMENT_SHADER,'precision highp float;out vec4 color;void main(){color=vec4(1.);}'],
 ]){
  const shader=gl.createShader(type);gl.shaderSource(shader,'#version 300 es\n'+source);
  gl.compileShader(shader);expect(gl.getShaderInfoLog(shader)).toBe('');gl.attachShader(program,shader);
 }
 gl.linkProgram(program);gl.useProgram(program);
 const location=gl.getAttribLocation(program,'position');
 gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());gl.enableVertexAttribArray(location);
 gl.vertexAttribPointer(location,2,gl.FLOAT,false,0,0);
 const edge=(a,b,x,y)=>(b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0]);
 for(const points of [
  [[2.5,4.5],[57.5,4.5],[42.5,62.5]],
  [[2.5,55.5],[32.5,7.5],[59.5,55.5]],
  [[1.5,1.5],[61.5,56.5],[62.5,59.5]],
 ]){
  const pixels=new Uint8Array(size*size*4),expected=new Uint8Array(size*size*4);
  for(const order of [points,[...points].reverse()]){
   gl.clear(gl.COLOR_BUFFER_BIT);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(order.flat()),gl.STATIC_DRAW);
   gl.drawArrays(gl.TRIANGLES,0,3);gl.readPixels(0,0,size,size,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
   for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const inside=points.every((a,i)=>{
     const b=points[(i+1)%3],e=edge(a,b,x+.5,y+.5);
     return e>0||e===0&&(b[1]<a[1]||b[1]===a[1]&&b[0]<a[0]);
    });
    if(inside)expected.fill(255,(y*size+x)*4,(y*size+x+1)*4);
   }
   expect(pixels).toEqual(expected);
  }
 }
});

test('queued indexed draws keep their submitted range across subdata writes and primitive restart', () => {
  const gl = canvasContext(canvas(4, 2), 'webgl2');
  const program = gl.createProgram();
  for (const [stage, source] of [
    [gl.VERTEX_SHADER, 'layout(location=0) in vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'],
    [gl.FRAGMENT_SHADER, 'precision highp float;uniform vec4 ink;out vec4 color;void main(){color=ink;}'],
  ]) {
    const shader = gl.createShader(stage);
    gl.shaderSource(shader, '#version 300 es\n'+source);
    gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 0,-1, -1,1, 0,1, 1,-1, 1,1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  const elements = new Uint16Array([65535, 0,1,2, 65535, 2,1,3]);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, elements, gl.DYNAMIC_DRAW);
  const ink = gl.getUniformLocation(program, 'ink');
  gl.uniform4f(ink, 1,0,0,1);
  gl.drawElements(gl.TRIANGLES, 7, gl.UNSIGNED_SHORT, 2);
  gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 2, new Uint16Array([1,4,3, 65535, 3,4,5]));
  gl.uniform4f(ink, 0,1,0,1);
  gl.drawElements(gl.TRIANGLES, 7, gl.UNSIGNED_SHORT, 2);
  const pixels = new Uint8Array(4*4*2);
  gl.readPixels(0,0,4,2,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  const row = [255,0,0,255, 255,0,0,255, 0,255,0,255, 0,255,0,255];
  expect([...pixels]).toEqual([...row, ...row]);
  expect(gl.getError()).toBe(gl.NO_ERROR);
});

test('an instanced interleaved matrix honors its offset, padding and divisor', () => {
  const gl = canvasContext(canvas(4, 1), 'webgl2');
  const program = gl.createProgram();
  for (const [stage,source] of [
    [gl.VERTEX_SHADER, 'layout(location=0) in mat2 m; out vec2 xy; void main(){xy=m*vec2(1.,2.);float x=float(gl_InstanceID)/2.-1.;gl_Position=vec4(x+(gl_VertexID==1?1.:0.),gl_VertexID==2?3.:-1.,0.,1.);}'],
    [gl.FRAGMENT_SHADER, 'precision highp float;in vec2 xy;out vec4 c;void main(){c=vec4(xy,0.,1.);}'],
  ]) {
    const shader=gl.createShader(stage);
    gl.shaderSource(shader,'#version 300 es\n'+source);gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');
    gl.attachShader(program,shader);
  }
  gl.linkProgram(program);gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([9,1,0,0,0,9, 9,0,0,0,.5,9]),gl.STATIC_DRAW);
  for(let col=0;col<2;col++){
    gl.enableVertexAttribArray(col);
    gl.vertexAttribPointer(col,2,gl.FLOAT,false,24,4+8*col);
    gl.vertexAttribDivisor(col,2);
  }
  gl.drawArraysInstanced(gl.TRIANGLES,0,3,4);
  const pixels=new Uint8Array(4*4);
  gl.readPixels(0,0,4,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  expect([...pixels]).toEqual([255,0,0,255, 255,0,0,255, 0,255,0,255, 0,255,0,255]);
  expect(gl.getError()).toBe(gl.NO_ERROR);
});

test('replaying a tiled WebGL draw keeps all tiles after a clear', () => {
  const gl=canvasContext(canvas(300,300),'webgl'),program=gl.createProgram();
  for(const [stage,source] of [
    [gl.VERTEX_SHADER,'attribute vec2 p; varying float x; void main(){x=p.x;gl_Position=vec4(p,0.,1.);}'],
    [gl.FRAGMENT_SHADER,'precision highp float; varying float x; void main(){gl_FragColor=vec4(step(0.,dFdx(x)),0.,0.,1.);}'],
  ]){
    const shader=gl.createShader(stage);gl.shaderSource(shader,source);gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');gl.attachShader(program,shader);
  }
  gl.linkProgram(program);gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  const slot=gl.getAttribLocation(program,'p');
  gl.enableVertexAttribArray(slot);gl.vertexAttribPointer(slot,2,gl.FLOAT,false,0,0);
  const pixel=new Uint8Array(4);
  for(let frame=0;frame<2;frame++){
    gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES,0,3);
    for(const [x,y] of [[3,3],[150,150],[296,296]]){
      gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      expect([...pixel]).toEqual([255,0,0,255]);
    }
  }
});

test('blended derivative fragments keep overlapping layers and helper lanes across discard', () => {
  const gl=canvasContext(canvas(2,2),'webgl2'),program=gl.createProgram();
  for(const [stage,source] of [
    [gl.VERTEX_SHADER,'in vec2 p;out float u;void main(){u=p.x;gl_Position=vec4(p,0.,1.);}'],
    [gl.FRAGMENT_SHADER,'precision highp float;in float u;out vec4 c;void main(){if(u<0.)discard;c=vec4(.25*dFdx(u),0.,0.,.25);}'],
  ]){
    const shader=gl.createShader(stage);
    gl.shaderSource(shader,'#version 300 es\n'+source);gl.compileShader(shader);
    expect(gl.getShaderInfoLog(shader)).toBe('');
    gl.attachShader(program,shader);
  }
  gl.linkProgram(program);gl.useProgram(program);
  const triangle=[-1,-1,3,-1,-1,3];
  gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([...triangle,...triangle]),gl.STATIC_DRAW);
  const p=gl.getAttribLocation(program,'p');
  gl.enableVertexAttribArray(p);gl.vertexAttribPointer(p,2,gl.FLOAT,false,0,0);
  gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE);
  gl.drawArrays(gl.TRIANGLES,0,6);
  const pixels=new Uint8Array(16);
  gl.readPixels(0,0,2,2,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  expect([...pixels]).toEqual([0,0,0,0,128,0,0,128,0,0,0,0,128,0,0,128]);
});

test('floating point clears preserve scissor edges and masked channels', () => {
  const gl=canvasContext(canvas(7,5),'webgl2'),texture=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,7,5,0,gl.RGBA,gl.FLOAT,null);
  gl.bindFramebuffer(gl.FRAMEBUFFER,gl.createFramebuffer());
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
  gl.clearColor(.25,.5,.75,1);gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.SCISSOR_TEST);gl.scissor(1,1,5,3);
  gl.clearColor(1,.75,.5,.25);gl.clear(gl.COLOR_BUFFER_BIT);
  gl.scissor(0,2,7,1);gl.colorMask(false,true,false,false);
  gl.clearColor(0,.125,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
  const rgba=new Float32Array(7*5*4);
  gl.readPixels(0,0,7,5,gl.RGBA,gl.FLOAT,rgba);
  for(let y=0;y<5;y++)for(let x=0;x<7;x++){
    const expected=x>=1&&x<6&&y>=1&&y<4?[1,.75,.5,.25]:[.25,.5,.75,1];
    if(y===2)expected[1]=.125;
    const offset=(y*7+x)*4;
    expect(Array.from(rgba.subarray(offset,offset+4))).toEqual(expected);
  }
  expect(gl.getError()).toBe(gl.NO_ERROR);
});

test('transferring a WebGL canvas replaces the default bitmap and preserves bound framebuffer contents', () => {
  const node=canvas(2,2), gl=canvasContext(node,'webgl2');
  const color=() => {
    const pixel=new Uint8Array(4);
    gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    return [...pixel];
  };
  gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
  const f=gl.createFramebuffer(), rb=gl.createRenderbuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER,f);
  gl.bindRenderbuffer(gl.RENDERBUFFER,rb);
  gl.renderbufferStorage(gl.RENDERBUFFER,gl.RGBA8,2,2);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.RENDERBUFFER,rb);
  gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
  const transfer=takeCanvasBitmap(node);
  try {
    const rgba=transfer.image.readPixels(0,0,{width:1,height:1,colorType:CanvasKit.ColorType.RGBA_8888,
      alphaType:CanvasKit.AlphaType.Unpremul,colorSpace:CanvasKit.ColorSpace.SRGB});
    expect([...rgba]).toEqual([255,0,0,255]);
    expect(gl.getParameter(gl.FRAMEBUFFER_BINDING)).toBe(f);
    expect(color()).toEqual([0,255,0,255]);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    expect(color()).toEqual([0,0,0,0]);
    gl.enable(gl.SCISSOR_TEST);gl.scissor(1,1,1,1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    expect(color()).toEqual([0,0,0,0]);
    expect(gl.getError()).toBe(gl.NO_ERROR);
  } finally { transfer.image.delete(); }
});
