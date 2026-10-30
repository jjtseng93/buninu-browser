import { beforeAll, expect, test } from "bun:test";
import CanvasKitInit from "../usr/lib/canvaskit/canvaskit.js";
import { canvasResource, canvasContext, resetCanvas, setCanvasKit, disposeDocumentCanvases } from "../lib/renderer/canvas-2d.js";

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
  expect(sample(context, "rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3, 128]);
  expect(context.getImageData(0, 0, 1, 1).data.length).toBe(4);
  expect(context.getImageData(0, 0, 1, 1).data[3]).toBe(0);
  expect(canvasContext(canvas(), "webgl2")).toBeNull();
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
  const pattern = context.createPattern({}, "repeat");
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
  for(const [kind,source]of[[gl.VERTEX_SHADER,'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'],[gl.FRAGMENT_SHADER,`precision highp float;uniform sampler2D image;void main(){vec4 c=texture2D(image,vec2(.5));${native?'for(int i=0;i<1;i++){c.r+=0.;}':''}gl_FragColor=c;}`]]){
   const sh=gl.createShader(kind);gl.shaderSource(sh,source);gl.compileShader(sh);expect(gl.getShaderInfoLog(sh)).toBe('');gl.attachShader(p,sh);
  }
  gl.linkProgram(p);gl.useProgram(p);gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  gl.bindTexture(gl.TEXTURE_2D,gl.createTexture());gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([200,100,50,128]));
  gl.clearColor(0,0,1,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,6);
  const pixel=canvasResource(node).image.readPixels(2,2,{width:1,height:1,colorType:CanvasKit.ColorType.RGBA_8888,alphaType:CanvasKit.AlphaType.Unpremul,colorSpace:CanvasKit.ColorSpace.SRGB});
  for(let i=0;i<4;i++)expect(Math.abs(pixel[i]-[100,50,152,255][i])).toBeLessThanOrEqual(1);
 }
});
