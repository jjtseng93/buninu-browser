import{test,expect}from'bun:test';
import{clipTriangles}from'../lib/renderer/webgl/clip.js';
test('homogeneous clipping keeps indexed geometry inside and interpolates crossings',()=>{
 const source=new Float32Array([-.5,-.5,0,1,0,.5,-.5,0,1,1,0,.5,0,1,.5]),indices=[0,1,2];
 const inside=clipTriangles(source,indices,5);expect(inside.vertices).toBe(source);expect(inside.indices).toBe(indices);
 source[5]=2;const clipped=clipTriangles(source,indices,5);expect(clipped.indices.length).toBe(6);
 for(let i=0;i<clipped.vertices.length;i+=5){const v=clipped.vertices.subarray(i,i+5);expect(Math.abs(v[0])).toBeLessThanOrEqual(v[3]);expect(v[4]).toBeGreaterThanOrEqual(0);expect(v[4]).toBeLessThanOrEqual(1);}
 source[0]=NaN;expect(clipTriangles(source,indices,5).indices).toEqual([]);
});
