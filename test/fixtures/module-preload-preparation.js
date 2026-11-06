import '../../vendor/ses/dist/ses.mjs';
import { strict as assert } from 'node:assert';
import { createPageRenderer } from '../../lib/renderer/page-renderer.js';
import { prepareModuleSource } from '../../lib/renderer/module-preparation.js';

const rootSource = "console.log('ROOT_EXECUTED'); document.title = 'Prepared root ran';";
const unusedSource = "console.log('UNUSED_EXECUTED'); export const unused = 1;";
const styles = Promise.withResolvers();
const preparedRoot = Promise.withResolvers();
const fetches = [], preparations = [], messages = [], errors = [];
let stylesReleased = false;
const resource = (url, source, contentType = 'text/javascript') => ({
  ok: true, url, contentType, body: new TextEncoder().encode(source),
});

const renderer = await createPageRenderer({
  reportError: error => errors.push(String(error)),
  consoleMessage: (_level, text) => messages.push(String(text)),
  rewriteScript(source, options) {
    preparations.push({ source, options, stylesReleased });
    const result = prepareModuleSource(source, options.mode);
    if (source === rootSource) preparedRoot.resolve();
    return Promise.resolve(result);
  },
  fetchResource(url) {
    fetches.push(url);
    if (url.endsWith('/held.css')) return styles.promise;
    if (url.endsWith('/root.js')) return Promise.resolve(resource(url, rootSource));
    if (url.endsWith('/unused.js')) return Promise.resolve(resource(url, unusedSource));
    throw Error(`Unexpected resource: ${url}`);
  },
});
lockdown({
  errorTaming: 'safe', overrideTaming: 'severe', consoleTaming: 'unsafe',
  localeTaming: 'unsafe', stackFiltering: 'concise', reporting: 'none',
});

// A regression that postpones preparation until after CSS must fail rather
// than deadlock this fixture. This deadline belongs only to the test.
async function bounded(promise, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`${description} did not finish`)), 5000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

try {
  renderer.resize(100, 100, 1);
  renderer.setScripting('ses');
  const loading = renderer.loadDocument({
    url: 'https://module.test/preload',
    source: `<!doctype html><title>Not executed yet</title>
      <link rel="stylesheet" href="/held.css">
      <link rel="modulepreload" href="/unused.js">
      <script type="module" src="/root.js"></script><p>Module preload</p>`,
  });
  await bounded(preparedRoot.promise, 'Root preparation while CSS is pending');
  // Let the cache's completion reaction run so this also exercises reuse of
  // an already prepared result, not only joining an outstanding worker call.
  await Promise.resolve();
  assert.deepEqual(preparations, [{
    source: rootSource, options: { type: 'module', mode: 'ses' }, stylesReleased: false,
  }]);
  assert.deepEqual(messages, [], 'preparing a source must not execute it before CSS');
  assert.equal(fetches.filter(url => url.endsWith('/unused.js')).length, 1,
    'modulepreload-only resources should still be fetched');

  stylesReleased = true;
  styles.resolve(resource('https://module.test/held.css', 'p { color: red; }', 'text/css'));
  await bounded(loading, 'First paint');
  await bounded(renderer.whenLoaded(), 'Module execution');
  assert.equal(preparations.length, 1, 'the realm must consume the root result without preparing it again');
  assert.equal(fetches.filter(url => url.endsWith('/root.js')).length, 1);
  assert.deepEqual(messages, ['ROOT_EXECUTED']);
  assert.equal(renderer.title(), 'Prepared root ran');
  assert.deepEqual(errors, []);
  process.stdout.write('module preload preparation passed\n');
} finally {
  // Release a held fetch even after an assertion fails; disposal then prevents
  // any late completion from reviving the old document.
  styles.resolve(resource('https://module.test/held.css', '', 'text/css'));
  renderer.dispose();
}
