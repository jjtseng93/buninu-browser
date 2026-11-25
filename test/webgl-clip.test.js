import{test,expect}from'bun:test';
import{clipTriangles}from'../lib/renderer/webgl/clip.js';
test('homogeneous clipping keeps indexed geometry inside and interpolates crossings',()=>{
 const source=new Float32Array([-.5,-.5,0,1,0,.5,-.5,0,1,1,0,.5,0,1,.5]),indices=[0,1,2];
 const inside=clipTriangles(source,indices,5);expect(inside.vertices).toBe(source);expect(inside.indices).toBe(indices);
 source[5]=2;const clipped=clipTriangles(source,indices,5);expect(clipped.indices.length).toBe(6);
 for(let i=0;i<clipped.vertices.length;i+=5){const v=clipped.vertices.subarray(i,i+5);expect(Math.abs(v[0])).toBeLessThanOrEqual(v[3]);expect(v[4]).toBeGreaterThanOrEqual(0);expect(v[4]).toBeLessThanOrEqual(1);}
 source[0]=NaN;expect(clipTriangles(source,indices,5).indices).toEqual([]);
});

test('clipping keeps flat inputs from the original final vertex',()=>{
 const source=new Float32Array([-.7,-.7,0,1,1, .7,-.7,0,1,2, 0,2,0,1,3]);
 const clipped=clipTriangles(source,[0,1,2],5,[4]);
 expect(clipped.indices.length).toBe(6);
 for(const index of clipped.indices)expect(clipped.vertices[index*5+4]).toBe(3);
});

test('a non-finite varying does not remove a primitive with finite clip coordinates',()=>{
 const source=new Float32Array([-.5,-.5,0,1,NaN, .5,-.5,0,1,0, 0,.5,0,1,0]);
 const indices=[0,1,2];
 expect(clipTriangles(source,indices,5).indices).toBe(indices);
});

test('a polygon crossing several clip planes keeps interpolated values when scratch is reused', () => {
 const source=new Float32Array([
  -4,-3,-2,1,-4, 5,0,2,1,5, 0,4,0,1,0,
  -.5,-.5,0,1,-.5, .5,-.5,0,1,.5, 0,.5,0,1,0,
 ]);
 const clipped=clipTriangles(source,[0,1,2, 3,4,5, 2,1,0],5);
 expect(clipped.indices.length).toBeGreaterThan(9);
 for(const id of clipped.indices){
  const [x,y,z,w,attribute]=clipped.vertices.subarray(id*5,id*5+5);
  for(const component of [x,y,z])expect(Math.abs(component)).toBeLessThanOrEqual(w+1e-6);
  expect(attribute).toBe(x);
 }
});
