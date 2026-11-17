import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createQmlCache} from '../lib/qml/cache.js';
import {configureQmlCache} from '../lib/qml/cache-options.js';
import {createCacheDiagnosticParser} from '../lib/qml/cache-diagnostics.js';

test('cache CLI levels are explicit and enable native diagnostics',()=>{
 const env={};configureQmlCache([],env);expect(env).toEqual({});
 configureQmlCache(['--cache'],env);expect(env.BUNINU_QML_CACHE).toBe('js');
 configureQmlCache(['--cache=bytecode'],env);expect(env).toEqual({BUNINU_QML_CACHE:'bytecode',BUN_JSC_verboseDiskCache:'1'});
 expect(()=>configureQmlCache(['--cache=bad'],env)).toThrow();
});
test('JSC diagnostic attribution handles split chunks and unrelated cache messages',()=>{
 const seen=[],feed=createCacheDiagnosticParser(x=>seen.push(x));
 const text='[Disk Cache] Cache hit for sourceCode\n[QMLC BEGIN abc-123]\n[Disk Cache] Cache hit for sourceCode\n[QMLC END abc-123]\n[Disk Cache] Cache miss for sourceCode\n';
 for(const ch of text)feed(ch);
 expect(seen).toEqual([{id:'abc-123',hits:1,misses:0}]);
});
for(const mode of ['js','bytecode'])test(`${mode} component cache invalidates sources and dependencies and survives write failure`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'qml-cache-')),cache=createQmlCache(mode);
 try{
 const file=join(dir,'Card.qml'),dep=join(dir,'Theme.qml'),missing=join(dir,'qmldir'),url=Bun.pathToFileURL(file).href;
 writeFileSync(file,'initial');writeFileSync(dep,'theme');let compiled=0;
 const compile=track=>{compiled++;track(dep);track(missing);return '({answer:42,version:'+compiled+'})';};
 expect(cache.factory(url,{},compile)().answer).toBe(42);
 expect(existsSync(file+'.cjs')).toBe(true);
 if(mode==='bytecode')expect(existsSync(file+'.cjs.jsc')).toBe(true);
 expect(cache.factory(url,{},compile)().answer).toBe(42);expect(compiled).toBe(1);expect(cache.snapshot().hits).toBe(1);
 writeFileSync(dep,'changed theme');expect(cache.factory(url,{},compile)().version).toBe(2);expect(compiled).toBe(2);
 writeFileSync(missing,'new module');cache.factory(url,{},compile);expect(compiled).toBe(3);
 writeFileSync(file,'new source');cache.factory(url,{},compile);expect(compiled).toBe(4);
 cache.factory(url,{context:'other'},compile);expect(compiled).toBe(5);
 writeFileSync(file+'.cjs','corrupt');expect(cache.factory(url,{},compile)().answer).toBe(42);
 // A path occupied by a directory cannot be replaced by a compiled module,
 // even when this test runs with root privileges.
 const blocked=join(dir,'Blocked.qml');writeFileSync(blocked,'Item {}');mkdirSync(blocked+'.cjs');
 expect(cache.factory(Bun.pathToFileURL(blocked).href,{},compile)().answer).toBe(42);
 expect(cache.snapshot().writeFailures).toBe(1);
 }finally{cache.dispose();rmSync(dir,{recursive:true,force:true});}
},15000);
test('JS rebuild does not bless stale bytecode when switching levels',()=>{
 const dir=mkdtempSync(join(tmpdir(),'qml-cache-level-')),js=createQmlCache('js'),bc=createQmlCache('bytecode');
 try{
  const file=join(dir,'Card.qml'),url=Bun.pathToFileURL(file).href;writeFileSync(file,'one');
  bc.factory(url,{},()=>'(1)');writeFileSync(file,'changed source');
  expect(js.factory(url,{},()=>'(2)')()).toBe(2);
  expect(JSON.parse(readFileSync(file+'.cjs.meta.json','utf8')).bytecode).toBe(null);
  expect(bc.factory(url,{},()=>'(2)')()).toBe(2);
  expect(bc.snapshot().entries.at(-1).rebuilt).toBe(true);
 }finally{js.dispose();bc.dispose();rmSync(dir,{recursive:true,force:true});}
});
