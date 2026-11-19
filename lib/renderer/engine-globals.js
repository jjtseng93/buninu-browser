/**
 * The engine's own globals in host JS mode.
 *
 * Host JS mode shows a page on the renderer's own global object, so the
 * page's APIs (fetch, setTimeout, Headers, TextDecoder...) replace the ones
 * engine code expects. Engine code calling the page's fetch for a data: URL,
 * for example, re-enters the page fetch forever. The host realm preserves
 * the originals here before installing the page's; engine code reads them
 * through engineGlobal(). In the sandboxed (SES) path nothing is preserved
 * and engineGlobal() returns the ordinary global, unchanged.
 */
const preserved = Object.create(null);

/** Keeps the engine's value of each name, once, before a host realm replaces it. */
export function preserveEngineGlobals(names) {
  for (const name of names) {
    if (!(name in preserved)) preserved[name] = globalThis[name];
  }
}

/** The engine's `name`: preserved in host JS mode, otherwise the current global. */
export function engineGlobal(name) {
  return name in preserved ? preserved[name] : globalThis[name];
}
