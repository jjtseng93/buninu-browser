// MSE attachment and sourceopen do not require a playback decoder.
import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';

const renderer=await createPageRenderer({});
try {
  renderer.resize(200,120,1);renderer.setScripting('host');
  await renderer.loadDocument({url:'https://attachment.test/',contentType:'text/html',source:'<video id=v></video>'});
  await renderer.whenLoaded();
  await renderer.evaluate(`globalThis.source=new MediaSource();globalThis.opened=0;
    source.addEventListener('sourceopen',()=>opened++);
    document.getElementById('v').src=URL.createObjectURL(source);`);
  assert.equal(await renderer.evaluate('source.readyState'),'open');
  for(let n=0;n<100 && !await renderer.evaluate('opened');n++)await Bun.sleep(5);
  assert.equal(await renderer.evaluate('opened'),1);
  process.stdout.write('Decoder-less MediaSource attachment passed\n');
} finally {renderer.dispose();}
