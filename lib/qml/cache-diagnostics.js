// JSC writes directly to fd 2. The controller correlates its lines with the
// synchronous require markers, then sends the observed result back over IPC.
const pending = new Map();
export function awaitCacheDiagnostic(id, callback) {
  pending.set(id, callback);
  return () => pending.delete(id);
}
export function receiveCacheDiagnostic(message) {
  const callback = pending.get(message.id);
  pending.delete(message.id);
  callback?.({ hits: message.hits, misses: message.misses });
}
export function createCacheDiagnosticParser(report) {
  let pendingText = '', active = null;
  return text => {
    pendingText += text;
    let end;
    while ((end = pendingText.indexOf('\n')) >= 0) {
      const line = pendingText.slice(0, end).trim(); pendingText = pendingText.slice(end + 1);
      const begin = /^\[QMLC BEGIN ([a-f0-9-]+)\]$/.exec(line);
      const finish = /^\[QMLC END ([a-f0-9-]+)\]$/.exec(line);
      if (begin) active = {id:begin[1],hits:0,misses:0};
      else if (finish && active?.id === finish[1]) { report(active); active = null; }
      else if (active && line === '[Disk Cache] Cache hit for sourceCode') active.hits++;
      else if (active && line === '[Disk Cache] Cache miss for sourceCode') active.misses++;
    }
    if (pendingText.length > 65536) {pendingText='';active=null;}
  };
}
