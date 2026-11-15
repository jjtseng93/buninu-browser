// Host-only helpers for the manual real-playback harness. No page instrumentation.
import {existsSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';

export function parseArguments(args, harnessRoot) {
  const options = {browserRoot:harnessRoot, castyRoot:resolve(harnessRoot, '../casty'), file:false, out:null, help:false, networkLabel:'unspecified'};
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--file') options.file = true;
    else if (arg === '--browser-root' || arg === '--casty-root' || arg === '--out' || arg === '--network-label') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      const key = {'--browser-root':'browserRoot','--casty-root':'castyRoot','--out':'out','--network-label':'networkLabel'}[arg];
      if (seen.has(key) || (key === 'out' && options.out)) throw new Error(`Duplicate option: ${arg}`);
      seen.add(key);
      options[key] = key === 'networkLabel' ? value : resolve(value);
    } else if (!arg.startsWith('-') && !options.out) options.out = resolve(arg);
    else throw new Error(`Unknown or duplicate argument: ${arg}`);
  }
  return options;
}

export async function fileFingerprint(path) {
  if (!existsSync(path)) return {missing:true};
  const hash = new Bun.CryptoHasher('sha256');
  let bytes = 0;
  for await (const chunk of Bun.file(path).stream()) {hash.update(chunk);bytes += chunk.byteLength;}
  return {sha256:hash.digest('hex'),bytes};
}

// Include every runtime extension and asset, including fonts, CSS, images and
// installed dependencies. Only known non-runtime top-level trees are excluded.
const excludedRoots = new Set(['.git','test','tests','docs','patches','tools','LICENSES']);
export async function treeFingerprint(root) {
  const entries = [];
  const visit = async (directory, prefix, ancestors) => {
    const real = realpathSync(directory);
    if (ancestors.has(real)) throw new Error('Runtime tree contains a symlink cycle');
    const next = new Set([...ancestors, real]);
    for (const entry of readdirSync(directory, {withFileTypes:true}).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if ((!prefix && excludedRoots.has(entry.name)) || entry.name === '.git') continue;
      const path = join(directory,entry.name), name = prefix + entry.name;
      const stat = entry.isSymbolicLink() ? statSync(path) : entry;
      if (stat.isDirectory()) await visit(path,name+'/',next);
      else if (stat.isFile() && !/\.(?:md|log)$/i.test(name) && !/(?:^|\/)LICENSE(?:[.-]|$)/.test(name)) {
        entries.push([name,await fileFingerprint(path)]);
      }
    }
  };
  await visit(root,'',new Set());
  return {sha256:new Bun.CryptoHasher('sha256').update(JSON.stringify(entries)).digest('hex'),files:entries.length};
}

export function environmentFingerprint(environment) {
  // Values (including proxy credentials or config URLs) are never serialized.
  // Normalize only the wrapper path, which necessarily differs every round.
  const env = {...environment,CASTY_BROWSER:'<round-browser-wrapper>'};
  return new Bun.CryptoHasher('sha256')
    .update(JSON.stringify(Object.keys(env).sort().map(name => [name,env[name]]))).digest('hex');
}

export async function inputFingerprint({browserRoot,castyRoot,harnessRoot,environment}) {
  const home = environment.HOME || homedir();
  const configPaths = [join(home,'.casty','config.json'),join(home,'.bunfig.toml')];
  if (environment.XDG_CONFIG_HOME) configPaths.push(join(environment.XDG_CONFIG_HOME,'bunfig.toml'));
  const configuration = [];
  for (const path of configPaths) configuration.push(await fileFingerprint(path));
  return {
    browser:await treeFingerprint(browserRoot),casty:await treeFingerprint(castyRoot),
    harness:await fileFingerprint(join(harnessRoot,'test/manual-youtube-stability.js')),
    support:await fileFingerprint(join(harnessRoot,'test/manual-youtube-stability-support.js')),
    kittyPeer:await fileFingerprint(join(harnessRoot,'test/manual-casty-home-startup.js')),
    runtime:await fileFingerprint(process.execPath),inheritedEnvironment:environmentFingerprint(environment),configuration,
  };
}

export function sameFingerprint(a,b) {return JSON.stringify(a) === JSON.stringify(b);}
