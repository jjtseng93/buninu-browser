// Host scripting installs browser globals, so each scenario runs separately.
import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';

const scenario = process.argv[2];
const frames = [], errors = [], videos = [];
let finishScript;
const pendingScript = new Promise(resolve => { finishScript = resolve; });
const renderer = await createPageRenderer({
  renderMinInterval: 180,
  onFrame: ({tile}) => frames.push(tile),
  onVideo: message => videos.push(message),
  reportError: error => errors.push(String(error)),
  fetchResource: async url => {
    if (url.endsWith('slow.js')) await pendingScript;
    return {ok:true, url, body:new Uint8Array([32]), contentType:url.endsWith('.js') ? 'text/javascript' : 'video/mp4'};
  },
  videoDecoder: {
    probe: async () => ({duration:10, video:{width:20, height:12}}),
    decode: async () => ({width:20, height:12, fps:30,
      nextFrame(w,h) { return new Uint8Array(w*h*4).fill(255); }, seek() {}, close() {}}),
  },
});

try {
  renderer.resize(64,36,1);
  renderer.setScripting('host');
  frames.length = 0;
  const loading = scenario.startsWith('loading');
  const media = scenario === 'video';
  await renderer.loadDocument({url:'https://prepaint.test/', contentType:'text/html',
    source:'<style>body{margin:0}#marker{height:500px;background:red}video{display:block;width:20px;height:12px}</style>'
      + (media ? '<video id=v src="clip.mp4"></video>' : '') + '<div id=marker></div>'
      + (loading ? '<script src="slow.js"></script>' : '')});

  if (loading) {
    await Bun.sleep(400);
    assert(frames.length > 0);
    assert(frames.every(tile => tile.height === 36), 'pending scripts must not expand an already visible tile');
    if (scenario === 'loading-scroll') {
      renderer.applyCompositorScroll(0,140);
      await Bun.sleep(90);
      assert(frames.some(tile => tile.y <= 140 && tile.y+tile.height >= 176),
        'scrolling beyond the old tile must still paint while loading');
    }
    finishScript();
    await renderer.whenLoaded();
    // The script has no visual effect: refresh need not call render. The
    // deferred prepaint still needs to wake and expand the unchanged tile.
    await Bun.sleep(550);
    assert(frames.some(tile => tile.height > 36), 'prepaint resumes after a no-op load settles');
  } else {
    await renderer.whenLoaded();
    if (media) {
      await renderer.evaluate('document.getElementById("v").play()');
      await Bun.sleep(400);
      assert(videos.some(message => message.type === 'video-open'));
      assert(frames.some(tile => tile.height > 36 && tile.videoLayer),
        'independent video playback alone must not block idle prepaint');
    } else {
      await renderer.evaluate('setTimeout(()=>document.documentElement.setAttribute("data-bookkeeping","changed"),1)');
      await Bun.sleep(80);
      assert(frames.every(tile => tile.height === 36), 'pending frame takes priority over speculative raster');
      await Bun.sleep(550);
      assert(frames.some(tile => tile.height > 36), 'prepaint resumes after a queued no-op frame');
    }
  }
  assert.deepEqual(errors, []);
  process.stdout.write(`prepaint ${scenario} passed\n`);
} finally {
  finishScript();
  renderer.dispose();
}
