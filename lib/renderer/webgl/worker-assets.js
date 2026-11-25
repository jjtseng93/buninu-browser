// The sandboxed renderer starts the worker from a blob. Resolve only this
// fixed module and CanvasKit binary in the host, on first WebGL2 use.
let source;

async function bundle(){
  const entry=new URL('./render-worker.js',import.meta.url);
  const build=await Bun.build({entrypoints:[Bun.fileURLToPath(entry)],target:'bun',format:'esm',write:false});
  if(!build.success)throw Error(build.logs.join('\n'));
  return build.outputs[0].text();
}

export async function webGLWorkerAssets(){
  source??=bundle().catch(error=>{source=undefined;throw error;});
  const [script,wasm]=await Promise.all([
    source,Bun.file(new URL('../../../usr/lib/canvaskit/canvaskit.wasm',import.meta.url)).bytes()
  ]);
  return {source:script,wasm};
}
