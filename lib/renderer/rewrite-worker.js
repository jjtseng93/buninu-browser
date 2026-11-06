/**
 * Prepares classic scripts and modules for the page realm off the renderer's main
 * thread: the rewrites parse the whole script (YouTube's bundles are
 * megabytes), which would otherwise block page tasks, animation frames and
 * media for seconds while the scripts are still downloading in parallel.
 *
 * Messages: { id, source, options? } → { id, result } or { id, error }.
 * Classic results are { code, parsed, strict }; options.type === "module"
 * uses options.mode (SES/host) and returns { code, requests }. The worker only
 * transforms strings; page code never runs here and no imports resolve here.
 */
import { PreparedScriptCache } from "./prepared-script-cache.js";
import { prepareModuleSource } from "./module-preparation.js";

const preparedScripts = new PreparedScriptCache({ maxBytes: 16 * 1024 * 1024, maxEntries: 64 });

self.addEventListener("message", ({ data }) => {
  const { id, source, options } = data ?? {};
  try {
    const result = options?.type === "module"
      ? prepareModuleSource(String(source), options.mode)
      : preparedScripts.prepare(String(source));
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
});

self.postMessage({ type: "ready" });
