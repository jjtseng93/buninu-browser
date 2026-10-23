import { statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseArgs(args, env = process.env) {
  let path = env.QS_CONFIG_PATH || '',
    config = env.QS_CONFIG_NAME || 'default';
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => {
      if (!args[i + 1] || args[i + 1].startsWith('-'))
        throw Error(`${arg} needs a value`);
      return args[++i];
    };
    if (arg === '-h' || arg === '--help') help = true;
    else if (arg === '-p' || arg === '--path') path = next();
    else if (arg.startsWith('--path=')) path = arg.slice(7);
    else if (arg === '-c' || arg === '--config') {
      config = next();
      path = '';
    } else throw Error(`Unsupported Quickshell option: ${arg}`);
  }
  if (help) return { help: true };
  if (!path) {
    if (!/^[\w.-]+$/.test(config) || config === '..')
      throw Error('Invalid configuration name');
    const base = env.XDG_CONFIG_HOME || (env.HOME && join(env.HOME, '.config'));
    if (!base) throw Error('Set --path, XDG_CONFIG_HOME or HOME');
    path = join(
      base,
      'quickshell',
      ...(config === 'default' ? [] : [config]),
      'shell.qml',
    );
  }
  path = resolve(path);
  if (statSync(path).isDirectory()) path = join(path, 'shell.qml');
  if (!statSync(path).isFile()) throw Error(`Not a QML file: ${path}`);
  return { path };
}

export async function main(args) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(
      `Usage: qs -p FILE_OR_DIRECTORY\n       qs -c CONFIG\n\nExperimental Buninu QML/Wayland frontend, not the native Quickshell runtime.\nUses WAYLAND_DISPLAY, XDG_RUNTIME_DIR and QML_IMPORT_PATH.\n-p, --path    QML file or directory containing shell.qml\n-c, --config  Name under $XDG_CONFIG_HOME/quickshell\n-h, --help    Show this help\n\nOnly supported QML features run. Native Quickshell IPC, Qt plugins and\nmultiple native windows are not implemented. Unknown arguments fail explicitly.`,
    );
    return;
  }
  const { launch } = await import('../../frontends/wayland/index.js');
  const app = await launch({
    url: pathToFileURL(options.path).href,
    width: 900,
    height: 600,
  });
  const stop = () => app.close();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, stop);
  try {
    await app.done;
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
      process.off(signal, stop);
    app.close();
  }
}

// Package entry adapters share QS configuration resolution with the standalone qs.
export function backendArgs(args, env = process.env) {
  const separator = args.indexOf('--');
  const options = parseArgs(separator < 0 ? args : args.slice(0, separator), env);
  if (options.help) return options;
  return { args: [pathToFileURL(options.path).href, ...(separator < 0 ? [] : args.slice(separator + 1))] };
}

export function backendUsage(backend) {
  return `Usage: qs${backend} [-p FILE_OR_DIRECTORY | -c CONFIG] [-- BACKEND_ARGS...]
       buninu-browser --quickshell-${backend} [-p FILE_OR_DIRECTORY | -c CONFIG] [-- BACKEND_ARGS...]

Experimental Buninu QML runtime using the ${backend} backend, not native Quickshell.
-p, --path    QML file or directory containing shell.qml
-c, --config  Name under $XDG_CONFIG_HOME/quickshell
-h, --help    Show this help
Uses QS_CONFIG_PATH, QS_CONFIG_NAME and QML_IMPORT_PATH.
Without -p/-c, uses the same default configuration as standalone qs.
Arguments after -- are forwarded unchanged to ${backend}.
For casty, another -- separates Casty options from browser engine options.
Only supported QML features run; native Quickshell IPC and Qt plugins are not implemented.`;
}

// Independent executables and the package routes use the same backend adapter.
export async function runBackend(backend, args = Bun.argv.slice(2)) {
  try {
    if (!['wayland', 'headless', 'casty'].includes(backend))
      throw Error(`Unknown Quickshell backend: ${backend}`);
    const forwarded = backendArgs(args);
    if (forwarded.help) {
      console.log(backendUsage(backend));
      return;
    }
    const engine = resolve(import.meta.dir, '../../buninu-browser.js');
    let cmd;
    if (backend === 'casty') {
      const { castyCommand } = await import('../../index.js');
      cmd = castyCommand(forwarded.args);
    } else {
      cmd = backend === 'wayland'
        ? [process.execPath, resolve(import.meta.dir, '../../frontends/wayland/index.js'), '--window-size=900,600', ...forwarded.args]
        : [process.execPath, engine, ...forwarded.args];
    }
    const child = Bun.spawn({
      cmd,
      env: backend === 'casty' ? { ...process.env, CASTY_BROWSER: engine } : process.env,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => {
      const handler = () => child.kill(signal);
      process.on(signal, handler);
      return [signal, handler];
    });
    try {
      process.exitCode = (await child.exited) ?? 1;
    } finally {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    }
  } catch (error) {
    console.error(`buninu qs${backend}: ${error.message}`);
    process.exitCode = 1;
  }
}
