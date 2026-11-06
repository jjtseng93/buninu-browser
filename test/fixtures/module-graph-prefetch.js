import '../../vendor/ses/dist/ses.mjs';
import { strict as assert } from 'node:assert';
import { createPageRenderer } from '../../lib/renderer/page-renderer.js';
import { prepareModuleSource } from '../../lib/renderer/module-preparation.js';

const base = 'https://module.test/';
const sources = new Map(), requests = [], messages = [], errors = [], navigations = [];
const consoleWaiters = new Map(), preparations = [];
const releases = [];
const response = (url, source) => ({
  ok: true, url, contentType: 'text/javascript', body: new TextEncoder().encode(source),
});
const renderer = await createPageRenderer({
  reportError: error => errors.push(String(error)),
  requestNavigation: url => navigations.push(url),
  consoleMessage(_level, text) {
    messages.push(String(text));
    consoleWaiters.get(String(text))?.resolve();
  },
  rewriteScript(source, options) {
    preparations.push(source);
    return Promise.resolve(prepareModuleSource(source, options.mode));
  },
  fetchResource(url) {
    requests.push(url);
    const source = sources.get(url);
    if (typeof source === 'function') return source(url);
    if (typeof source === 'string') return Promise.resolve(response(url, source));
    throw Error(`Unexpected resource: ${url}`);
  },
});
lockdown({
  errorTaming: 'safe', overrideTaming: 'severe', consoleTaming: 'unsafe',
  localeTaming: 'unsafe', stackFiltering: 'concise', reporting: 'none',
});

function add(path, source) { sources.set(new URL(path, base).href, source); }
function hold(path, source) {
  const pending = Promise.withResolvers(), started = Promise.withResolvers();
  const release = () => pending.resolve(response(new URL(path, base).href, source));
  add(path, () => { started.resolve(); return pending.promise; });
  releases.push(release);
  return { started: started.promise, release };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`${label} did not settle`)), 5000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
async function load(path) {
  await renderer.loadDocument({
    url: base,
    source: `<!doctype html><title>Module graph</title><script type="module" src="/${path}"></script>`,
  });
}
const reset = () => { requests.length = messages.length = errors.length = preparations.length = 0; };

try {
  renderer.resize(100, 100, 1);
  renderer.setScripting('ses');

  // Grandchildren of a ready parent must start before an unrelated sibling
  // finishes. Compilation/fetch can overlap; no module body can run yet.
  add('root.js', "import { value } from './fast.js'; import './slow.js'; console.log('root:' + value);");
  add('fast.js', "import { value } from './grandchild.js'; console.log('fast'); export { value };");
  const slow = hold('slow.js', "console.log('slow');");
  const grandchild = hold('grandchild.js', "console.log('grandchild'); export const value = 42;");
  await load('root.js');
  const ready = renderer.whenLoaded();
  await bounded(grandchild.started, 'Grandchild discovery before slow sibling');
  assert.deepEqual(messages, [], 'fetching the graph must not execute any module early');
  grandchild.release();
  slow.release();
  await bounded(ready, 'Graph execution');
  assert.deepEqual(messages, ['grandchild', 'fast', 'slow', 'root:42']);
  assert.equal(new Set(requests).size, requests.length, 'each graph URL is fetched once');
  assert.deepEqual(errors, []);

  // Cycles retain the existing dependency-first order. A top-level await in
  // the graph still blocks the importer without blocking fetch discovery.
  reset();
  const waiting = Promise.withResolvers();
  consoleWaiters.set('TLA_WAIT', waiting);
  add('cycle-root.js', "import { a } from './cycle-a.js'; import { b } from './cycle-b.js'; import './tla.js'; console.log('cycle-root:' + a + b);");
  add('cycle-a.js', "import { b, readA } from './cycle-b.js'; export let a = 'a'; console.log('cycle-a:' + readA() + b);");
  add('cycle-b.js', "import { a } from './cycle-a.js'; export const b = 'b'; export function readA() { return a; } console.log('cycle-b');");
  add('tla.js', "console.log('TLA_WAIT'); await new Promise(resolve => { window.releaseModule = resolve; }); console.log('TLA_DONE');");
  await load('cycle-root.js');
  const cycleReady = renderer.whenLoaded();
  await bounded(waiting.promise, 'Cyclic graph reaching top-level await');
  assert.deepEqual(messages, ['cycle-b', 'cycle-a:ab', 'TLA_WAIT']);
  await renderer.evaluate('releaseModule()');
  await bounded(cycleReady, 'Top-level await release');
  assert.deepEqual(messages, ['cycle-b', 'cycle-a:ab', 'TLA_WAIT', 'TLA_DONE', 'cycle-root:ab']);
  assert.equal(new Set(requests).size, requests.length, 'cycle/shared imports do not refetch');
  assert.deepEqual(errors, []);

  // A grandchild can fail before the loader joins that level. Its rejection
  // must be observed immediately and reported normally once the graph joins.
  reset();
  add('failure-root.js', "import './failure-fast.js'; import './failure-slow.js'; console.log('failure-root');");
  add('failure-fast.js', "import './missing.js'; console.log('failure-fast');");
  const failed = Promise.withResolvers();
  add('missing.js', url => {
    failed.resolve();
    return Promise.resolve({ ...response(url, ''), ok: false, status: 404 });
  });
  const failureSlow = hold('failure-slow.js', "console.log('failure-slow');");
  await load('failure-root.js');
  const failureReady = renderer.whenLoaded();
  await bounded(failed.promise, 'Early grandchild fetch failure');
  await Bun.sleep(0);
  assert.deepEqual(messages, []);
  failureSlow.release();
  await bounded(failureReady, 'Failed graph completion');
  assert.deepEqual(messages, [], 'fetch failure prevents all graph bodies from executing');
  assert(errors.some(error => error.includes('missing.js') && error.includes('404')));

  // Invalid parent syntax must not turn into a speculative child request.
  reset();
  add('parse-root.js', "import './parse-invalid.js'; console.log('parse-root');");
  add('parse-invalid.js', "import './must-not-fetch.js'; export const = 1;");
  await load('parse-root.js');
  await bounded(renderer.whenLoaded(), 'Parse failure');
  assert(!requests.some(url => url.endsWith('/must-not-fetch.js')));
  assert.deepEqual(messages, []);
  assert(errors.length > 0);

  // Replacing the document cancels both an old sibling and the newly eager
  // grandchild. Late bytes must not be rewritten or executed in either realm.
  reset();
  add('old-root.js', "import './old-fast.js'; import './old-slow.js'; console.log('old-root');");
  add('old-fast.js', "import './old-grandchild.js'; console.log('old-fast');");
  const oldSlow = hold('old-slow.js', "location.href = 'https://stale.test/sibling';");
  const oldGrandchild = hold('old-grandchild.js', "location.href = 'https://stale.test/grandchild';");
  await load('old-root.js');
  const oldReady = renderer.whenLoaded();
  await bounded(oldGrandchild.started, 'Eager grandchild before disposal');
  await renderer.loadDocument({ url: `${base}replacement`, source: '<!doctype html><p>Replacement</p>' });
  await bounded(oldReady, 'Disposed graph');
  const preparedBeforeRelease = preparations.length;
  oldSlow.release();
  oldGrandchild.release();
  await Bun.sleep(20);
  assert.equal(preparations.length, preparedBeforeRelease);
  assert.deepEqual(messages, []);
  assert.deepEqual(navigations, []);
  assert.deepEqual(errors, []);

  process.stdout.write('module graph prefetch passed\n');
} finally {
  renderer.dispose();
  for (const release of releases) release();
}
