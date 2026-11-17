// Measure file:// QML startup through the real headless CLI and CDP capture.
// Run with the same Bun/environment as normal use; proot timings include its I/O cost.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { CDP } from '../tools/browser-lab.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('bun test/manual-flea-startup.js [--flea=../flea-qml] [--runs=3] [--output=/tmp/results]\nMeasures a fresh headless process at 900x600, using three temporary folders and isolated XDG state/config/data/cache for each run.\nSaves JSON timings, first-folder PNGs and stderr logs. This excludes Casty/terminal display latency.');
  process.exit(0);
}
const option = (key, fallback) => args.find(a => a.startsWith(key + '='))?.slice(key.length + 1) ?? fallback;
const runs = Number(option('--runs', '3'));
if (!Number.isInteger(runs) || runs < 1 || runs > 100) throw Error('--runs must be an integer from 1 to 100');
const root = resolve(import.meta.dir, '..');
const flea = resolve(option('--flea', join(root, '../flea-qml')));
const entry = join(flea, 'ui/boot/shell.qml');
if (!await Bun.file(entry).exists()) throw Error('Missing Flea entry: ' + entry);
const output = resolve(option('--output', join(tmpdir(), 'flea-startup-' + Date.now())));
mkdirSync(output, { recursive: true });
const fixture = mkdtempSync(join(tmpdir(), 'flea-startup-folders-'));
const names = ['startup-alpha', 'startup-beta', 'startup-gamma'];
for (const name of names) mkdirSync(join(fixture, name));
const results = [];
const profiles = [];
try {
  for (let round = 1; round <= runs; round++) {
    const profile = mkdtempSync(join(tmpdir(), 'flea-startup-profile-'));
    profiles.push(profile);
    const isolated = Object.fromEntries(['STATE', 'CONFIG', 'DATA', 'CACHE'].map(kind =>
      [`XDG_${kind}_HOME`, join(profile, kind.toLowerCase())]));
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    let stderr = '', cdp;
    const child = Bun.spawn([process.execPath, join(root, 'index.js'), '--headless',
      '--remote-debugging-port=0', '--window-size=900,600', Bun.pathToFileURL(entry).href], {
      cwd: root, env: { ...process.env, ...isolated, FLEA_PATH: fixture, BUNINU_LOG: join(output, `run-${round}.log`) },
      stdout: 'ignore', stderr: 'pipe',
    });
    const drain = (async () => { for await (const chunk of child.stderr) stderr += Buffer.from(chunk).toString(); })();
    try {
      let endpoint;
      // This is a diagnostic watchdog, not a browser startup deadline.
      while (!(endpoint = stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1])) {
        if (child.exitCode !== null || elapsed() > 120000) throw Error('No CDP endpoint; see stderr log');
        await Bun.sleep(20);
      }
      const endpointMs = elapsed();
      cdp = new CDP(endpoint);
      await cdp.ready;
      const { targetInfos } = await cdp.send('Target.getTargets');
      const target = targetInfos.find(t => t.type === 'page');
      if (!target) throw Error('No initial page target');
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      cdp.sessionId = sessionId;
      let previousSampleMs = elapsed(), detectedMs;
      while (elapsed() < 120000) {
        const sampleStarted = elapsed();
        try {
          const text = await cdp.evaluate('document.body?.innerText ?? ""', 120000);
          if (names.every(name => text.includes(name)) && text.includes('📁')) {
            detectedMs = elapsed();
            break;
          }
        } catch (error) {
          // The initial blank can disappear between evaluation and its reply.
          if (!String(error).includes('Renderer closed')) throw error;
        }
        previousSampleMs = sampleStarted;
        await Bun.sleep(100);
      }
      if (detectedMs === undefined) throw Error('Folder icons did not appear within the diagnostic watchdog');
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, 120000);
      const capturedMs = elapsed();
      await Bun.write(join(output, `run-${round}.png`), Buffer.from(data, 'base64'));
      const result = { round, endpointMs, previousSampleMs, detectedMs, capturedMs };
      results.push(result);
      console.log(JSON.stringify(result));
    } finally {
      cdp?.close();
      child.kill();
      await child.exited;
      await drain;
      await Bun.write(join(output, `run-${round}.stderr.log`), stderr);
    }
  }
} finally {
  for (const profile of profiles) rmSync(profile, { recursive: true, force: true });
  rmSync(fixture, { recursive: true, force: true });
  await Bun.write(join(output, 'results.json'), JSON.stringify({
    bun: Bun.version, bunRevision: Bun.revision, executable: process.execPath,
    platform: process.platform, arch: process.arch, entry,
    viewport: { width: 900, height: 600 }, samplingIntervalMs: 100,
    profile: 'fresh isolated XDG state/config/data/cache per run',
    scope: 'headless CLI to folder detection and CDP screenshot; excludes terminal presentation', results,
  }, null, 2));
  console.log('Results: ' + output);
}
