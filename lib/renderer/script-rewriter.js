const NativeWorker = globalThis.Worker;

/**
 * Start one source-preparation worker before renderer sandboxing. Its return
 * value is callable for classic scripts, or accepts { type: "module", mode }.
 * It only moves string preparation off-thread; page code never executes there.
 * A failed worker stays failed so every caller can use its synchronous fallback.
 */
export async function startScriptRewriter({
  createWorker = () => new NativeWorker(new URL("./rewrite-worker.js", import.meta.url).href),
  lazy = false, signal = null,
} = {}) {
  if (lazy) {
    // Only use this where filesystem access remains available after startup.
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    let starting = null;
    const rewrite = async (source, options) => {
      if (controller.signal.aborted) throw new Error("Script rewriter closed");
      const active = await (starting ??= startScriptRewriter({ createWorker, signal: controller.signal }));
      if (!active || controller.signal.aborted) throw new Error("Script rewriter unavailable");
      return active(source, options);
    };
    rewrite.close = () => {
      signal?.removeEventListener("abort", abort);
      controller.abort();
    };
    return rewrite;
  }
  if (signal?.aborted) return null;
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
    signal?.removeEventListener("abort", onAbort);
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
  function onAbort() { fail(new Error("Script rewriter closed")); }

  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  worker.addEventListener("messageerror", onMessageError);
  worker.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
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
