/**
 * Prepares classic scripts for the page realm off the renderer's main
 * thread: the rewrites parse the whole script (YouTube's bundles are
 * megabytes), which would otherwise block page tasks, animation frames and
 * media for seconds while the scripts are still downloading in parallel.
 *
 * Messages: { id, source } → { id, result: { code, parsed, strict } } or
 * { id, error }. The worker only transforms strings; page code never runs here.
 */
import { PreparedScriptCache } from "./prepared-script-cache.js";

const preparedScripts = new PreparedScriptCache({ maxBytes: 16 * 1024 * 1024, maxEntries: 64 });

self.addEventListener("message", ({ data }) => {
  const { id, source } = data ?? {};
  try {
    self.postMessage({ id, result: preparedScripts.prepare(String(source)) });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
});

self.postMessage({ type: "ready" });
