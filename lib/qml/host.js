import { Worker } from 'node:worker_threads';
import { loadQmlGraphSync } from './loader.js';
import { createQmlDocument } from './document.js';
// Local QML application capabilities. No imports from this module are exposed to HTML.
import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
  watch,
} from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const spawn = Bun.spawn.bind(Bun);
const environment = { ...process.env };
const active = new Set();
let installed = false;
export function createQmlHost(url) {
  if (new URL(url).protocol !== 'file:')
    throw Error('QML host requires a local document');
  if (!installed) {
    installed = true;
    process.on('exit', () => {
      for (const host of active) host.dispose();
    });
    process.on('SIGTERM', () => {
      for (const host of active) host.dispose();
      process.exit(0);
    });
  }
  let closed = false;
  const resources = new Set(),
    base = new URL('.', url);
  const check = () => {
    if (closed) throw Error('QML host is closed');
  };
  const path = (value) =>
    String(value).startsWith('file:')
      ? fileURLToPath(value)
      : resolve(fileURLToPath(base), String(value));
  const host = {
    worker(url, onMessage, onReady, onError) {
      check();
      if (new URL(url).protocol !== 'file:')
        throw Error('WorkerScript requires a local source');
      const worker = new Worker(
        new URL('./worker-thread.js', import.meta.url),
        { workerData: { url } },
      );
      let stopped = false;
      worker.on('message', (data) => {
        if (stopped) return;
        if (data.kind === 'ready') onReady();
        else if (data.kind === 'message') onMessage(data.message);
        else if (data.kind === 'error') onError(data.error);
      });
      worker.on('error', (error) => {
        if (!stopped) onError(String(error.stack || error));
      });
      const stop = () => {
        if (stopped) return;
        stopped = true;
        resources.delete(stop);
        void worker.terminate();
      };
      resources.add(stop);
      stop.send = (message) => {
        if (stopped) throw Error('WorkerScript has stopped');
        worker.postMessage(message);
      };
      return stop;
    },
    markdown: (source) => {
      check();
      return Bun.markdown.html(String(source));
    },
    shellDir: fileURLToPath(base).replace(/\/$/, ''),
    processId: process.pid,
    compile(href, externalSingletons = []) {
      check();
      if (new URL(href).protocol !== 'file:')
        throw Error('Synchronous application components must be local files');
      const source = readFileSync(fileURLToPath(href), 'utf8');
      const fetchResource = (url) => {
        if (new URL(url).protocol !== 'file:')
          throw Error('Local component imports must be local files');
        try {
          return { status: 200, body: readFileSync(fileURLToPath(url)) };
        } catch (e) {
          if (e.code === 'ENOENT' || e.code === 'ENOTDIR')
            return { status: 404 };
          throw e;
        }
      };
      const graph = loadQmlGraphSync(source, href, fetchResource, {
        importRoots: host.importRoots,
      });
      const { document } = createQmlDocument(source, href, {
        graph,
        component: true,
        externalSingletons,
      });
      const program = document.querySelector('script')?.textContent;
      if (!program)
        throw Error(
          document.querySelector('p')?.textContent ||
            'Component compilation failed',
        );
      return program;
    },
    env(name) {
      check();
      return environment[String(name)] ?? null;
    },
    hyprEvents(callback) {
      const signature = environment.HYPRLAND_INSTANCE_SIGNATURE;
      if (!signature) return () => {};
      const socketPath = resolve(
        environment.XDG_RUNTIME_DIR || '/tmp',
        'hypr',
        signature,
        '.socket2.sock',
      );
      let socket,
        buffer = '',
        stopped = false;
      const stop = () => {
        stopped = true;
        socket?.end();
        resources.delete(stop);
      };
      resources.add(stop);
      Bun.connect({
        unix: socketPath,
        socket: {
          open(s) {
            socket = s;
            if (stopped) s.end();
          },
          data(s, bytes) {
            buffer += new TextDecoder().decode(bytes);
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              const at = line.indexOf('>>');
              if (at >= 0 && !closed)
                callback({ name: line.slice(0, at), data: line.slice(at + 2) });
            }
          },
          error() {},
          close() {
            resources.delete(stop);
          },
        },
      }).catch(() => resources.delete(stop));
      return stop;
    },
    importRoots: (environment.QML_IMPORT_PATH || '')
      .split(delimiter)
      .filter(Boolean)
      .map((p) => pathToFileURL(resolve(p) + '/').href),
    write(name, data, atomic = true) {
      check();
      const target = path(name);
      let temporary;
      try {
        if (atomic) {
          let mode = 0o600;
          try {
            mode = statSync(target).mode & 0o777;
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          temporary =
            target + '.qml-write-' + process.pid + '-' + crypto.randomUUID();
          writeFileSync(temporary, data, { flag: 'wx', mode });
          renameSync(temporary, target);
          temporary = null;
        } else writeFileSync(target, data);
        return { error: null };
      } catch (error) {
        return { error: error.code || String(error) };
      } finally {
        if (temporary)
          try {
            unlinkSync(temporary);
          } catch {}
      }
    },
    read(name) {
      check();
      try {
        return { text: readFileSync(path(name), 'utf8'), error: null };
      } catch (e) {
        return { text: '', error: e.code || String(e) };
      }
    },
    watch(name, callback) {
      check();
      const target = path(name);
      let watcher;
      try {
        watcher = watch(target, () => {
          if (!closed) callback();
        });
      } catch {
        return () => {};
      }
      const stop = () => {
        watcher.close();
        resources.delete(stop);
      };
      resources.add(stop);
      return stop;
    },
    run(command, callback, options = {}) {
      check();
      if (!Array.isArray(command) || !command.length)
        throw Error('Process.command must be a nonempty array');
      let child;
      try {
        child = spawn({
          cmd: command.map(String),
          cwd: options.cwd ? path(options.cwd) : fileURLToPath(base),
          env: {
            ...(options.clearEnvironment ? {} : environment),
            ...(options.environment || {}),
          },
          stdin: options.stdin ? 'pipe' : 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        });
      } catch (error) {
        queueMicrotask(() => {
          if (!closed)
            callback({
              exitCode: 127,
              stdout: '',
              stderr: String(error),
              error: String(error),
            });
        });
        return () => {};
      }
      const stop = () => {
        child.kill();
        resources.delete(stop);
      };
      stop.write = (text) => {
        if (!options.stdin) throw Error('Process stdin is disabled');
        child.stdin.write(String(text));
        child.stdin.flush();
      };
      stop.closeWriteChannel = () => {
        if (options.stdin) child.stdin.end();
      };
      stop.signal = (signal) => child.kill(Number(signal));
      stop.processId = child.pid;
      resources.add(stop);
      const read = async (stream, onData) => {
        let text = '';
        const decoder = new TextDecoder();
        for await (const bytes of stream) {
          const chunk = decoder.decode(bytes, { stream: true });
          text += chunk;
          if (!closed) onData?.(chunk, bytes);
        }
        const tail = decoder.decode();
        text += tail;
        if (tail && !closed) onData?.(tail);
        return text;
      };
      Promise.all([
        read(child.stdout, options.stdout),
        read(child.stderr, options.stderr),
        child.exited,
      ])
        .then(([stdout, stderr, exitCode]) => {
          resources.delete(stop);
          if (!closed) callback({ stdout, stderr, exitCode });
        })
        .catch((error) => {
          resources.delete(stop);
          if (!closed)
            callback({
              exitCode: 1,
              stdout: '',
              stderr: String(error),
              error: String(error),
            });
        });
      return stop;
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const stop of [...resources]) stop();
      resources.clear();
      active.delete(host);
    },
  };
  active.add(host);
  return host;
}
