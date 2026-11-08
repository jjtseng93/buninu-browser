import { expect, test } from 'bun:test';
import { DocumentFonts } from '../lib/renderer/font-loading.js';
import { loadGraphics } from '../lib/renderer/page-renderer.js';
const face = (family, source, extra = {}) => ({ family, sources: [{ url: source }], weight: [400, 400], style: 'normal', ...extra });
const run = (text, family, extra = {}) => ({ text, style: { fontFamily: [family], ...extra } });
const bytes = await Bun.file(new URL('../usr/share/fonts/DejaVuSansMono.ttf', import.meta.url)).bytes();
async function make(fetch) {
 const { CanvasKit, builtinTypefaces, fontCollection } = await loadGraphics();
 return new DocumentFonts({CanvasKit, builtins: builtinTypefaces, defaultCollection: fontCollection, fetch});
}
test('prepared text retains the installed index and accepts live text, weight, style and Unicode changes', async () => {
 const requests = []; const fonts = await make(async ({url}) => { requests.push(url); return {status:200,body:bytes}; });
 let installed = 0; const original = fonts.setFaces; fonts.setFaces = function(faces){installed++;return original.call(this,faces)};
 const regular = face('Prepared','https://font.test/regular', {unicodeRanges:[[0,127]]});
 const bold = face('Prepared','https://font.test/bold', {weight:[700,700]});
 const italic = face('Prepared','https://font.test/italic', {style:'italic'});
 const cjk = face('Prepared','https://font.test/cjk', {unicodeRanges:[[0x4e00,0x9fff]]});
 try {
  fonts.setFaces([regular,bold,italic,cjk]);
  fonts.updateText([run('Hello','Prepared')]); await fonts.ready();
  const regularAlias=fonts.resolve('prepared',400,'normal',65)[0];
  for(let i=0;i<10;i++)fonts.updateText([run('Hello '+i,'Prepared')]);
  expect(requests).toEqual(['https://font.test/regular']);
  fonts.updateText([run('中文','Prepared'),run('bold','Prepared',{fontWeight:700}),run('italic','Prepared',{fontStyle:'italic'})]);
  await fonts.ready();
  expect(new Set(requests)).toEqual(new Set(['https://font.test/regular','https://font.test/cjk','https://font.test/bold','https://font.test/italic']));
  expect(fonts.resolve('Prepared',400,'normal',65)[0]).toBe(regularAlias);
  expect(fonts.resolve('Prepared',400,'normal',0x4e2d)).toHaveLength(3);
  expect(installed).toBe(1);
 } finally { fonts.dispose(); }
});
test('setFaces refreshes prepared indexes on add, remove and mutable descriptor edits',async()=>{
 const requests=[];const fonts=await make(async({url})=>{requests.push(url);return {status:200,body:bytes}});
 const faces=[face('Original','https://font.test/first')];
 try {
  fonts.setFaces(faces);fonts.updateText([run('a','Original')]);await fonts.ready();
  const first=fonts.resolve('Original')[0];
  faces[0].family='Renamed';faces[0].sources=[{url:'https://font.test/second'}];
  fonts.setFaces(faces);fonts.updateText([run('a','Renamed')]);await fonts.ready();
  expect(fonts.resolve('Original')).toEqual([]);expect(fonts.resolve('Renamed')[0]).not.toBe(first);
  faces.push(face('Added','https://font.test/third'));fonts.setFaces(faces);fonts.updateText([run('a','Added')]);await fonts.ready();
  expect(fonts.resolve('Added')).toHaveLength(1);
  fonts.setFaces([]);fonts.updateText([run('a','Added')]);expect(fonts.resolve('Added')).toEqual([]);
  expect(requests).toEqual(['https://font.test/first','https://font.test/second','https://font.test/third']);
 } finally {fonts.dispose()}
});
test('public update still reindexes the same mutated face array',async()=>{
 const requests=[];const fonts=await make(async({url})=>{requests.push(url);return {status:200,body:bytes}});
 const faces=[face('One','https://font.test/one')];
 try {
  fonts.update(faces,[run('a','One')]);await fonts.ready();
  faces[0].family='Two';faces[0].sources=[{url:'https://font.test/two'}];
  fonts.update(faces,[run('a','Two')]);await fonts.ready();
  expect(fonts.resolve('One')).toEqual([]);expect(fonts.resolve('Two')).toHaveLength(1);expect(requests).toHaveLength(2);
 } finally {fonts.dispose()}
});
test('asynchronous alias completion remains live and removed faces stay absent',async()=>{
 let finish;let requested=0;const fonts=await make(()=>{requested++;return new Promise(r=>finish=r)});
 const old=face('Delayed','https://font.test/delayed');
 try {
  fonts.setFaces([old]);fonts.updateText([run('a','Delayed')]);
  expect(fonts.resolve('Delayed')).toEqual([]);
  fonts.updateText([run('b','Delayed')]);expect(requested).toBe(1);
  fonts.setFaces([]);finish({status:200,body:bytes});await fonts.ready();
  expect(fonts.resolve('Delayed')).toEqual([]);
  fonts.setFaces([structuredClone(old)]);fonts.updateText([run('c','Delayed')]);
  expect(fonts.resolve('Delayed')).toHaveLength(1);expect(requested).toBe(1);
 } finally {fonts.dispose()}
});
test('disposed prepared indexes do not fetch, and separate document generations do not reuse aliases',async()=>{
 let firstAbort=0,secondFetch=0;
 const first=await make(()=>{let reject;const p=new Promise((_,r)=>reject=r);p.abort=()=>{firstAbort++;reject(Error('closed'))};return p});
 const second=await make(async()=>{secondFetch++;return {status:200,body:bytes}});
 const faces=[face('Generation','https://font.test/shared-url')];
 first.setFaces(faces);first.updateText([run('a','Generation')]);first.dispose();await first.ready();first.updateText([run('b','Generation')]);
 expect(firstAbort).toBe(1);expect(first.resolve('Generation')).toEqual([]);
 try {second.setFaces(faces);second.updateText([run('a','Generation')]);await second.ready();expect(secondFetch).toBe(1);expect(second.resolve('Generation')).toHaveLength(1)}finally{second.dispose()}
});

for (const mode of ['layout','canvas']) test(`prepared renderer font index follows ${mode} mutations`, async()=>{
 const child=Bun.spawn([process.execPath,new URL('./fixtures/font-index-invalidation.js',import.meta.url).pathname,mode],{stdout:'pipe',stderr:'pipe'});
 const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect({code,error}).toEqual({code:0,error:''});
 const {output}=JSON.parse(out),at=label=>output.find(item=>item.label===label);
 if(mode==='layout'){
  expect(at('initial').geometry[0].box.width).toBeGreaterThan(at('media on').geometry[0].box.width*2);
  expect(at('media off').geometry[0].box.width).toBe(at('style mutations').geometry[0].box.width);
  expect(at('base URL change').requests).toContain('https://font.test/two/mono.ttf');
  expect(at('added stylesheet').requests).toContain('https://font.test/two/sans-added.ttf');
  expect(at('added stylesheet').geometry[0].box.width).toBeLessThan(at('removed stylesheet').geometry[0].box.width/2);
  expect(at('remove all faces').geometry[0].box.width).toBeLessThan(at('restore faces').geometry[0].box.width/2);
  expect(at('new document generation').requests).toContain('https://font.test/three/mono.ttf');
 }else{
  expect(at('first').width).toBeGreaterThan(at('second').width*2);
  expect(at('first again').width).toBe(at('first').width);
  expect(at('face source edited').width).toBe(at('second').width);
  expect(at('first again').requests).toEqual(at('second').requests);
 }
},15000);
