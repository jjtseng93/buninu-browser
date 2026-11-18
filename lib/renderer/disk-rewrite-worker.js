import { prepareClassicScript } from "./prepared-script-cache.js";
import { prepareDiskCached, scriptCacheDirectory, scriptCacheVersion } from "./script-disk-cache.js";

const directory = scriptCacheDirectory();
const version = scriptCacheVersion();
self.onmessage = ({data:{id, source}}) => {
  try {
    let hit = true;
    const started = performance.now();
    const prepared = prepareDiskCached(source, directory, version, text => {
      hit = false;
      return prepareClassicScript(text);
    });
    self.postMessage({id, result:{prepared, hit, ms:Math.round(performance.now() - started)}});
  } catch (error) {
    self.postMessage({id, error:String(error?.message ?? error)});
  }
};
self.postMessage({type:"ready"});
