/**
 * Start one source-preparation worker before renderer sandboxing. Its return
 * value is callable for classic scripts, or accepts { type: "module", mode }.
 * It only moves string preparation off-thread; page code never executes there.
 * A failed worker stays failed so every caller can use its synchronous fallback.
 */
export async function startScriptRewriter({
  createWorker = () => new Worker(new URL("./rewrite-worker.js", import.meta.url).href),
} = {}) {
  let worker;
  try { worker = createWorker(); } catch { return null; }

  const pending = new Map();
  let nextId = 0;
  let failure = null;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function fail(error) {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    rejectReady(failure);
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", onError);
    worker.removeEventListener("messageerror", onMessageError);
    worker.removeEventListener("close", onClose);
    try { worker.terminate(); } catch {}
  }

  function onMessage({ data }) {
    if (data?.type === "ready") { resolveReady(); return; }
    const request = pending.get(data?.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error !== undefined) request.reject(new Error(data.error));
    else request.resolve(data.result);
  }
  function onError(event) { fail(new Error(String(event?.message ?? "Script rewriter failed"))); }
  function onMessageError() { fail(new Error("Script rewriter response could not be decoded")); }
  function onClose() { fail(new Error("Script rewriter closed")); }

  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  worker.addEventListener("messageerror", onMessageError);
  worker.addEventListener("close", onClose);
  try { await ready; } catch { return null; }
  // An error may follow the ready message before this continuation runs.
  if (failure) return null;
  worker.unref?.();

  const rewriteScript = (source, options) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    try { worker.postMessage({ id, source, options }); }
    catch (error) { fail(error); }
  });
  rewriteScript.close = () => fail(new Error("Script rewriter closed"));
  return rewriteScript;
}
