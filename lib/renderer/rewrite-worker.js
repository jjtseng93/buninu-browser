/**
 * Prepares classic scripts for the page realm off the renderer's main
 * thread: the rewrites parse the whole script (YouTube's bundles are
 * megabytes), which would otherwise block page tasks, animation frames and
 * media for seconds while the scripts are still downloading in parallel.
 *
 * Messages: { id, source } → { id, result: { code, parsed, strict } } or
 * { id, error }. The worker only transforms strings; page code never runs here.
 */
import { escapeSesHtmlComments, rewriteClassicScriptSource } from "./script-rewrite.js";

self.addEventListener("message", ({ data }) => {
  const { id, source } = data ?? {};
  try {
    const classic = rewriteClassicScriptSource(String(source));
    self.postMessage({ id, result: { code: escapeSesHtmlComments(classic.code), parsed: classic.parsed, strict: classic.strict } });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
});

self.postMessage({ type: "ready" });
