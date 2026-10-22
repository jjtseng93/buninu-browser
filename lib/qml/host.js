// Local QML application capabilities. No imports from this module are exposed to HTML.
import { readFileSync, watch } from 'node:fs';
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
    run(command, callback) {
      check();
      if (!Array.isArray(command) || !command.length)
        throw Error('Process.command must be a nonempty array');
      let child;
      try {
        child = spawn({
          cmd: command.map(String),
          cwd: fileURLToPath(base),
          env: environment,
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
      resources.add(stop);
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).then(([stdout, stderr, exitCode]) => {
        resources.delete(stop);
        if (!closed) callback({ stdout, stderr, exitCode });
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
