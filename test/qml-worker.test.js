import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBrowser } from '../lib/headless-shell.js';
async function run(files, source, verify) {
  const dir = mkdtempSync('/tmp/qml-worker-');
  let browser;
  try {
    for (const [name, text] of Object.entries({ ...files, 'main.qml': source }))
      await Bun.write(join(dir, name), text);
    browser = await createBrowser({ spareRenderer: false });
    await browser.context.navigate(
      Bun.pathToFileURL(join(dir, 'main.qml')).href,
    );
    const read = () =>
      browser.context.evaluate('document.getElementById("result").textContent');
    let text;
    for (let i = 0; i < 200; i++) {
      text = await read();
      if (text !== 'waiting') break;
      await Bun.sleep(20);
    }
    await verify(text, browser);
  } finally {
    browser?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
test('WorkerScript includes shared script scope, clones messages and keeps independent worker state', async () => {
  await run(
    {
      'worker.js':
        'Qt.include("helper.js");var count=0;WorkerScript.onMessage=function(m){m.answer=twice(m.n)+ ++count;WorkerScript.sendMessage(m);};',
      'helper.js': '.pragma library\nfunction twice(n){return n*2;}',
    },
    `import QtQuick
Text {id:result;text:"waiting";property var input:({n:4});property var replies:[]
 WorkerScript {id:a;source:"worker.js";onMessage:function(m){result.replies=result.replies.concat([m.answer]);if(result.replies.length===2)result.text=JSON.stringify(result.replies)+":"+result.input.answer}}
 WorkerScript {id:b;source:"worker.js";onMessage:function(m){result.replies=result.replies.concat([m.answer]);if(result.replies.length===2)result.text=JSON.stringify(result.replies)+":"+result.input.answer}}
 Component.onCompleted:{a.sendMessage(input);b.sendMessage(input)}
}`,
    (text) => expect(text).toBe('[9,9]:undefined'),
  );
}, 30000);
test.skipIf(!process.env.BUNINU_FLEA_ROOT)(
  'unchanged Flea MarkdownWorker parses headings and paragraphs in a real worker',
  async () => {
    const url = Bun.pathToFileURL(
      resolve(process.env.BUNINU_FLEA_ROOT, 'ui/MarkdownWorker.js'),
    ).href;
    await run(
      {},
      `import QtQuick
Text {id:result;text:"waiting"
 WorkerScript {id:worker;source:${JSON.stringify(url)};onMessage:function(m){result.text=JSON.stringify(m)}}
 Component.onCompleted:worker.sendMessage({seq:12,source:"# Hello\\n\\nA **bold** paragraph.",dir:"/tmp",chrome:"#000000",ink:"#ffffff"})
}`,
      (text) => {
        const result = JSON.parse(text);
        expect(result.error).toBe('');
        expect(result.seq).toBe(12);
        expect(result.blocks.length).toBeGreaterThan(1);
        expect(JSON.stringify(result.blocks)).toContain('Hello');
        expect(JSON.stringify(result.blocks)).toContain('bold');
      },
    );
  },
  30000,
);
