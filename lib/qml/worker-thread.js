// Local WorkerScript application code executes on its own Bun worker thread.
// Qt.include uses one script global scope; it is not the QML import resolver.
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
let current = workerData.url,
  bytes = 0,
  depth = 0;
const context = createContext({
  console,
  WorkerScript: {
    onMessage: null,
    sendMessage: (message) =>
      parentPort.postMessage({ kind: 'message', message }),
  },
});
const run = (url) => {
  if (new URL(url).protocol !== 'file:')
    throw Error('WorkerScript imports must be local files');
  if (++depth > 48) throw Error('WorkerScript include depth exceeded');
  const previous = current;
  current = url;
  try {
    const source = readFileSync(new URL(url), 'utf8');
    bytes += Buffer.byteLength(source);
    if (bytes > 4 * 1024 * 1024)
      throw Error('WorkerScript source limit exceeded');
    // Like Qt.include in a WorkerScript, directives supply no import aliases.
    const code = source.replace(
      /^\s*\.(?:pragma\s+library|import\s+[^\n]+)\s*$/gm,
      '',
    );
    new Script(code, { filename: url }).runInContext(context);
  } finally {
    current = previous;
    depth--;
  }
};
context.Qt = {
  include: (relative, callback) => {
    let result;
    try {
      run(new URL(relative, current).href);
      result = { status: 0 };
    } catch (exception) {
      result = { status: 3, exception };
    }
    callback?.(result);
    return result;
  },
};
try {
  run(current);
  parentPort.postMessage({ kind: 'ready' });
  parentPort.on('message', (message) => {
    try {
      context.WorkerScript.onMessage?.(message);
    } catch (error) {
      parentPort.postMessage({
        kind: 'error',
        error: String(error.stack || error),
      });
    }
  });
} catch (error) {
  parentPort.postMessage({
    kind: 'error',
    error: String(error.stack || error),
  });
}
