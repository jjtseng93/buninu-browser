import { expect, test } from "bun:test";
import { loadGraphics } from "../lib/renderer/page-renderer.js";
import { RasterReadback } from "../lib/paint/raster-readback.js";

test("raster readback reuses native scratch while published shared frames stay immutable", async () => {
  const { CanvasKit: kit } = await loadGraphics();
  const malloc = kit._malloc, free = kit._free;
  const pointers = new Set();
  let allocations = 0, releases = 0;
  kit._malloc = size => { const pointer = malloc(size); pointers.add(pointer); allocations++; return pointer; };
  kit._free = pointer => { if (pointers.delete(pointer)) releases++; free(pointer); };
  const surface = kit.MakeSurface(4, 4);
  const capture = new RasterReadback(kit, { shared: true });
  const read = (size = 4) => {
    const image = surface.makeImageSnapshot();
    try { return capture.read(image, size, size); } finally { image.delete(); }
  };
  try {
    surface.getCanvas().clear(kit.Color(255, 0, 0, 0.5));
    const first = read();
    const afterFirst = allocations;
    expect(first.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect([...first.subarray(0, 4)]).toEqual([255, 0, 0, 128]);
    surface.getCanvas().clear(kit.Color(0, 0, 255, 1));
    const second = read();
    expect(allocations).toBe(afterFirst);
    expect([...second.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
    expect([...first.subarray(0, 4)]).toEqual([255, 0, 0, 128]);
    expect(read(2)).toHaveLength(16);
    expect(allocations).toBe(afterFirst);
    // Structured cloning shares pixels without another allocation or copy.
    const clone = structuredClone(first);
    expect(clone.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect([...clone]).toEqual([...first]);
  } finally {
    capture.dispose(); capture.dispose(); surface.dispose();
    kit._malloc = malloc; kit._free = free;
  }
  expect(releases).toBe(allocations);
});

test('partial raster readback patches an immutable previous frame and rejects invalid regions',async()=>{
 const {CanvasKit:kit}=await loadGraphics();const surface=kit.MakeSurface(8,6);
 const capture=new RasterReadback(kit,{shared:true});
 const read=options=>{const image=surface.makeImageSnapshot();try{return capture.read(image,8,6,options)}finally{image.delete()}};
 try{
  surface.getCanvas().clear(kit.Color(255,0,0,1));const first=read(),saved=first.slice();
  const paint=new kit.Paint();try{paint.setColor(kit.Color(0,0,255,0.5));paint.setBlendMode(kit.BlendMode.Src);surface.getCanvas().drawRect(kit.XYWHRect(2,1,3,2),paint)}finally{paint.delete()}
  const full=read(),partial=read({previous:first,region:{x:2,y:1,width:3,height:2}});
  expect(partial).toEqual(full);expect(first).toEqual(saved);expect(partial.buffer).not.toBe(first.buffer);
  for(const region of [{x:-1,y:0,width:2,height:2},{x:0,y:0,width:0,height:2},{x:7,y:0,width:2,height:2},{x:0.5,y:0,width:2,height:2}])
   expect(read({previous:first,region})).toEqual(full);
 }finally{capture.dispose();surface.dispose()}
});
