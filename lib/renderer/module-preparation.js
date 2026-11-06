import { transformModule } from "./module-transform.js";
import { rewriteModuleSource } from "./script-rewrite.js";

/** Pure source preparation shared by the worker and synchronous fallback. */
export function prepareModuleSource(source, mode) {
  if (mode !== "ses" && mode !== "host") throw new TypeError(`Unknown module realm mode: ${mode}`);
  return transformModule(mode === "ses" ? rewriteModuleSource(source) : source);
}

/**
 * Keep import-map resolution, graph state and compilation in the current realm.
 * Worker failures (including syntax errors) repeat the original preparation
 * locally, preserving the parser's exception type and source location.
 */
export async function prepareModuleOffThread(source, mode, rewriteScript) {
  if (rewriteScript) {
    try {
      const result = await rewriteScript(source, { type: "module", mode });
      if (typeof result?.code === "string" && Array.isArray(result.requests)
        && result.requests.every(entry => typeof entry?.specifier === "string"
          && (entry.type === null || typeof entry.type === "string"))) return result;
    } catch {}
  }
  return prepareModuleSource(source, mode);
}
