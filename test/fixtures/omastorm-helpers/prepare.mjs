// Explicit app experiment, never a browser/renderer special case.
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function prepare(root) {
 const replacements=[
  ['TextureCheck.qml', /        if \(GraphicsInfo\.api === GraphicsInfo\.Software\) \{\n            fail\("Radar requires GPU rendering \(OpenGL\/Vulkan\)\."\);\n            return;\n        \}\n/],
  ['RadarMap.qml', /        Component\.onCompleted: if \(GraphicsInfo\.api === GraphicsInfo\.Software\) map\.graphicsError = "Radar requires GPU rendering \(OpenGL\/Vulkan\)\."\n/],
 ];
 // Validate both before changing either. Keep originals for inspection.
 const sources=await Promise.all(replacements.map(async([name,pattern])=>{
  const path=resolve(root,'ui',name),source=await readFile(path,'utf8');
  if(!pattern.test(source))throw Error('Upstream software policy changed; review '+name);
  return {path,source,pattern};
 }));
 for(const {path,source,pattern} of sources){await copyFile(path,path+'.upstream');await writeFile(path,source.replace(pattern,''));}
}
if(import.meta.main)await prepare(resolve(process.argv[2]||'/opt/omastorm'));
