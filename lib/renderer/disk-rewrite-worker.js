import { prepareClassicScript } from "./prepared-script-cache.js";
import { prepareDiskCached, scriptCacheDirectory, scriptCacheVersion } from "./script-disk-cache.js";

const directory = scriptCacheDirectory();
const version = scriptCacheVersion();
self.onmessage = ({data:{id, source}}) => {
  const started = performance.now();
  let replied = false;
  function reply(prepared, hit) {
    self.postMessage({id, result:{prepared, hit, ms:Math.round(performance.now() - started)}});
    replied = true;
  }
  try {
    const prepared = prepareDiskCached(source, directory, version, text => {
      const result = prepareClassicScript(text);
      // The page can start evaluating while this worker compresses and
      // atomically publishes the entry. Later requests still run in order.
      reply(result, false);
      return result;
    });
    if (!replied) reply(prepared, true);
  } catch (error) {
    if (!replied) self.postMessage({id, error:String(error?.message ?? error)});
  }
};
self.postMessage({type:"ready"});
