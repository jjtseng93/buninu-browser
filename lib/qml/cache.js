import {readFileSync,writeFileSync,renameSync,statSync,mkdtempSync,rmSync,writeSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {awaitCacheDiagnostic} from './cache-diagnostics.js';
const require=createRequire(import.meta.url),spawnSync=Bun.spawnSync.bind(Bun),bun=process.execPath;
const builder=fileURLToPath(new URL('./cache-build.js',import.meta.url));
const hash=text=>new Bun.CryptoHasher('sha256').update(text).digest('hex');
let engine;
function engineVersion(){
  return engine??=hash(['document.js','parser.js','loader.js','builtins.js','runtime.js','cache.js','cache-build.js'].map(f=>readFileSync(new URL(f,import.meta.url))).map(b=>hash(b)).join(':'));
}
export function dependencyStamp(path){
  try{const s=statSync(path);return [s.size,s.mtimeMs,s.ctimeMs,s.ino].join(':');}
  catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return null;throw e;}
}
export function createQmlCache(mode) {
  const enabled=['js','bytecode'].includes(mode),entries=[],disposers=new Set();
  let dead=false;
  const log=message=>{try{writeSync(2,'[QML cache] '+message+'\n');}catch{}};
  const state=()=>({mode:enabled?mode:'off',hits:entries.filter(e=>e.hit).length,
    misses:entries.filter(e=>!e.hit).length,rebuilds:entries.filter(e=>e.rebuilt).length,
    writeFailures:entries.filter(e=>e.writeError).length,
    loadTimeMs:entries.reduce((n,e)=>n+e.loadTimeMs,0),
    bytecode:{available:entries.filter(e=>e.bytecodeAvailable).length,
      confirmedHits:entries.some(e=>e.bytecodeHits!==null)?entries.reduce((n,e)=>n+(e.bytecodeHits??0),0):null,
      confirmedMisses:entries.some(e=>e.bytecodeMisses!==null)?entries.reduce((n,e)=>n+(e.bytecodeMisses??0),0):null},
    entries:entries.map(e=>({...e}))});
  return {
    snapshot:state,
    dispose(){dead=true;for(const dispose of disposers)dispose();disposers.clear();},
    factory(href,context,compile){
      if(!enabled)return new Function('mount','properties','return '+compile(()=>{}));
      const start=performance.now(),path=fileURLToPath(href)+'.cjs',metaPath=path+'.meta.json';
      const key=JSON.stringify({engine:engineVersion(),context,bun:Bun.revision,platform:process.platform,arch:process.arch});
      const entry={url:href,hit:false,reason:'missing',rebuilt:false,loadTimeMs:0,bytecodeAvailable:false,bytecodeHits:null,bytecodeMisses:null};
      entries.push(entry);
      let meta,program,factory,valid=false;
      try {
        meta=JSON.parse(readFileSync(metaPath,'utf8'));
        if(meta.key!==key)entry.reason='compiler or context changed';
        else if(!Array.isArray(meta.dependencies)||meta.dependencies.some(([p,s])=>dependencyStamp(p)!==s))entry.reason='dependency changed';
        else if(meta.digest!==hash(readFileSync(path)))entry.reason='compiled JavaScript changed';
        else if(mode==='bytecode'&&(!meta.bytecode||dependencyStamp(path+'.jsc')!==meta.bytecode))entry.reason='bytecode missing or changed';
        else valid=true;
      }catch(e){entry.reason=e.code==='ENOENT'?'missing':'unreadable or invalid cache';}
      if(!valid){
        const dependencies=new Map();
        const track=p=>dependencies.set(p,dependencyStamp(p));track(fileURLToPath(href));
        program=compile(track);
        let dir;
        try {
          // Same directory, ordinary files, and publish the manifest last.
          dir=mkdtempSync(join(dirname(path),'.qml-cache-'));
          const input=join(dir,'input.cjs');
          writeFileSync(input,'module.exports=function(mount,properties){return '+program+'};\n');
          let output=input;
          if(mode==='bytecode'){
            const result=spawnSync([bun,builder,input,dir],{stdout:'pipe',stderr:'pipe'});
            if(result.exitCode!==0)throw Error(Buffer.from(result.stderr).toString());
            output=join(dir,'factory.cjs');
          }
          meta={key,dependencies:[...dependencies],digest:hash(readFileSync(output)),bytecode:null};
          renameSync(output,path);
          if(mode==='bytecode')renameSync(join(dir,'factory.cjs.jsc'),path+'.jsc');
          meta.bytecode=mode==='bytecode'?dependencyStamp(path+'.jsc'):null;
          writeFileSync(join(dir,'meta.json'),JSON.stringify(meta));renameSync(join(dir,'meta.json'),metaPath);
          entry.rebuilt=true;valid=true;
        }catch(e){entry.writeError=String(e.message);log('write failed '+href+': '+entry.writeError);}
        finally{if(dir)try{rmSync(dir,{recursive:true,force:true});}catch{}}
      }else {entry.hit=true;entry.reason="valid";}
      if(valid){
        entry.bytecodeAvailable=dependencyStamp(path+'.jsc')!==null;
        const id=crypto.randomUUID();
        const cancel=awaitCacheDiagnostic(id,result=>{
          disposers.delete(cancel);
          if(dead)return;
          // Multiple JSC compilations cannot safely be attributed to this one module.
          if(result.hits+result.misses===1){entry.bytecodeHits=result.hits;entry.bytecodeMisses=result.misses;}
          log('bytecode '+href+': '+(entry.bytecodeHits===null?'unconfirmed':`${result.hits} hit, ${result.misses} miss`));
        });
        disposers.add(cancel);
        try{
          writeSync(2,`[QMLC BEGIN ${id}]\n`);
          delete require.cache[require.resolve(path)];
          factory=require(path);
          if(typeof factory!=='function')throw Error('Cached module did not export a factory');
        }catch(e){try{unlinkSync(metaPath);}catch{} entry.hit=false;entry.reason='module load failed';log(entry.reason+' '+href+': '+e.message);}
        finally{delete require.cache[path];writeSync(2,`[QMLC END ${id}]\n`);}
      }
      if(typeof factory!=='function')factory=new Function('mount','properties','return '+(program??compile(()=>{})));
      entry.loadTimeMs=performance.now()-start;
      log(`${entry.hit?'hit':'miss'} ${href}: ${entry.loadTimeMs.toFixed(1)}ms (${entry.reason})`);
      return factory;
    },
  };
}
