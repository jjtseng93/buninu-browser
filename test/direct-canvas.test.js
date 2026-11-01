import {expect,test} from 'bun:test';
test('direct full-tile Canvas composition matches Skia and safely returns to full painting',async()=>{
 const p=Bun.spawn([process.execPath,new URL('./fixtures/direct-canvas.js',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
 const [exit,stderr]=await Promise.all([p.exited,new Response(p.stderr).text()]);
 expect({exit,stderr}).toEqual({exit:0,stderr:''});
},15000);

test('direct pixel blending handles RGBA, premultiplied alpha and unaligned allocations',async()=>{
 const {compositeCanvasOverOpaque}=await import('../lib/paint/direct-canvas.ts');
 const source=Uint8Array.of(50,0,0,128,99,88,77,255,0,0,0,0);
 const aligned=source.slice(),storage=new Uint8Array(source.length+2).fill(9),unaligned=storage.subarray(1,-1);
 unaligned.set(source);
 for(const pixels of [aligned,unaligned])compositeCanvasOverOpaque(pixels,[10,20,30,255]);
 expect([...aligned]).toEqual([55,10,15,255,99,88,77,255,10,20,30,255]);
 expect([...unaligned]).toEqual([...aligned]);
 expect(storage[0]).toBe(9);expect(storage.at(-1)).toBe(9);
});
