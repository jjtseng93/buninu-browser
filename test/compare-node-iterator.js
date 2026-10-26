// Manual black-box reference check (no Chromium source code copied):
// bun test/compare-node-iterator.js /usr/local/bin/chromium-headless-shell
// Optional --snapshot writes Chromium's raw results for the regression test.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RendererHost } from '../lib/renderer/host.js';
import { nodeIteratorCases } from './fixtures/node-iterator-cases.js';

const binary = process.argv[2] || Bun.which('chromium-headless-shell');
if (!binary) throw new Error('Pass the Chromium Headless Shell executable as the first argument');
const dir = await mkdtemp(join(tmpdir(), 'node-iterator-'));
const host = new RendererHost({timeout:20000,fetch:async()=>new Response('')});
let child;
try {
  const expression = `JSON.stringify((${nodeIteratorCases})())`;
  const path = join(dir, 'cases.html');
  await Bun.write(path, `<body><script>document.body.textContent=${expression}</script>`);
  child = Bun.spawn([binary,'--no-sandbox','--disable-gpu','--dump-dom',pathToFileURL(path).href],
    {stdout:'pipe',stderr:'ignore'});
  const html = await new Response(child.stdout).text();
  if (await child.exited) throw new Error('Chromium failed');
  const body = html.match(/<body>(.*?)<\/body>/s)?.[1];
  const chromium = JSON.parse(body?.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&'));
  await host.call('loadDocument',{url:'https://iterator.test/',source:'<body></body>',contentType:'text/html',status:200});
  await host.call('whenLoaded');
  const browser = JSON.parse(await host.call('evaluate',expression));
  let differences = 0;
  for (let i = 0; i < chromium.length; i++) {
    if (!Bun.deepEquals(browser[i], chromium[i])) { differences++;console.log({browser:browser[i],chromium:chromium[i]}); }
  }
  console.log(`${chromium.length} cases; ${differences} differences (see node-iterator.test.js for documented DOM-spec exceptions)`);
  if (process.argv.includes('--snapshot')) {
    await Bun.write(new URL('./fixtures/node-iterator-chromium.json',import.meta.url),
      '[\n'+chromium.map(row=>'  '+JSON.stringify(row)).join(',\n')+'\n]\n');
  }
} finally {
  child?.kill();
  host.close();
  await rm(dir,{recursive:true,force:true});
}
