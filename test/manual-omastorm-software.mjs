// Explicit experiment: copy the application and remove only its GPU policy.
// Does not alter the checkout, fake GraphicsInfo, or bypass shader/pixel checks.
import {mkdtemp,cp,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
const root=resolve(process.argv[2]||'../omastorm');
const directory=await mkdtemp(resolve(tmpdir(),'omastorm-software-'));
await cp(root+'/ui',directory+'/ui',{recursive:true});
const replacements=[
 ['TextureCheck.qml', /        if \(GraphicsInfo\.api === GraphicsInfo\.Software\) \{\n            fail\("Radar requires GPU rendering \(OpenGL\/Vulkan\)\."\);\n            return;\n        \}\n/],
 ['RadarMap.qml', /        Component\.onCompleted: if \(GraphicsInfo\.api === GraphicsInfo\.Software\) map\.graphicsError = "Radar requires GPU rendering \(OpenGL\/Vulkan\)\."\n/],
];
for(const [file,pattern] of replacements){
 const path=directory+'/ui/'+file,source=await readFile(path,'utf8');
 if(!pattern.test(source))throw Error('Upstream policy changed; review '+file+' before modifying it');
 await writeFile(path,source.replace(pattern,''));
}
console.log('Software test copy: '+directory);
console.log('Original engine must already be running in XDG_RUNTIME_DIR/omastorm.');
if(process.argv.includes('--prepare-only'))process.exit(0);
const child=Bun.spawn([process.execPath,new URL('../lib/qml/qswayland',import.meta.url).pathname,'-p',directory+'/ui/shell.qml'],{
 env:{...process.env,OMASTORM_ROOT:root},stdin:'inherit',stdout:'inherit',stderr:'inherit',
});
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));
process.exitCode=await child.exited;
