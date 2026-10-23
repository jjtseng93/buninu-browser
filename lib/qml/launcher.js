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
