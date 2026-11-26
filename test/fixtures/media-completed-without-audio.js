import assert from 'node:assert/strict';
const root=new URL('../../',import.meta.url);
const { createPageRenderer }=await import(new URL('lib/renderer/page-renderer.js',root));
const { createWebMStream }=await import(new URL('lib/media/webm-stream.js',root));
const { default:wasmpeg }=await import(new URL('vendor/wasmpeg/src/js/index.js',root));
await wasmpeg.load();
const file=(name)=>Bun.file(new URL('test/fixtures/'+name,root)).bytes();
const webm=await file('mse-audio-chirp.webm');
const blocks=createWebMStream().append(webm);
const first=blocks.findIndex(e=>e.id===0x1f43b675);
if(first<=0)throw Error('missing WebM media fixture');
const init=new Uint8Array(Bun.concatArrayBuffers(blocks.slice(0, first).map(e=>e.bytes)));
const video=await file('video.mp4');
const payload=b=>JSON.stringify(Buffer.from(b).toString('base64'));
for(const kind of ['videoOnly','audioInitOnly','fullAudio']) {
  const errors=[],trace=[],opens=[];
  const timers=[];
  const renderer=await createPageRenderer({videoDecoder:wasmpeg,reportError:e=>errors.push(String(e)),trace:m=>trace.push(m.replace(/blob:[^ ]+/, 'blob:local')),
    audio:{open(o,listener){const stream={listener,seconds:0,written:0,o};opens.push(stream);timers.push(setInterval(()=>{
      if(!stream.listener)return;stream.listener({event:'request',bytes:3840});
      stream.seconds=Math.min(stream.seconds+.04,stream.written/(2*o.rate*o.channels));
      stream.listener({event:'timing',seconds:stream.seconds,sentSeconds:stream.written/(2*o.rate*o.channels)});
    },40));return opens.length},write(id,bytes){opens[id-1].written+=bytes.length},close(id){opens[id-1].listener=null;return 0},finish(id){opens[id-1].listener?.({event:'ended'});opens[id-1].listener=null}}});
  try {
    renderer.resize(320,180,1);renderer.setScripting('host');
    await renderer.loadDocument({url:'https://mse-test.test/',contentType:'text/html',source:'<video id="clip"></video>'});
    const sound = kind === 'audioInitOnly' ? init : webm;
    const hasSeparateAudio = kind !== 'videoOnly';
    await renderer.evaluate('(async function(){'+
     'const video=document.getElementById("clip"), source=new MediaSource(); const ready=new Promise(r=>source.addEventListener("sourceopen",r,{once:true})); video.src=URL.createObjectURL(source);await ready;'+
     'const add=async(type,b64)=>{const sb=source.addSourceBuffer(type);const end=new Promise(r=>sb.addEventListener("updateend",r,{once:true}));sb.appendBuffer(Uint8Array.from(atob(b64), c=>c.charCodeAt(0)));await end};'+
     'await add("video/mp4",'+payload(video)+');'+
     (hasSeparateAudio?'await add(\'audio/webm; codecs="opus"\','+payload(sound)+');':'')+
     'source.duration=6.061;source.endOfStream();void video.play();return true})()');
    await Bun.sleep(650);
    const view=await renderer.evaluate('JSON.stringify((function(){var v=document.querySelector("video");return [v.currentTime,v.duration,v.paused,v.ended,v.readyState,v.networkState,v.buffered.length?v.buffered.end(0):0,v.videoWidth,v.getVideoPlaybackQuality().totalVideoFrames,v.error?.code]})())');
    assert(JSON.parse(view)[0] > 0, JSON.stringify({kind,view,errors,trace}));
    assert.equal(opens.length, kind === 'fullAudio' ? 1 : 0);
  } finally {
    renderer.dispose(); for(const timer of timers)clearInterval(timer);
  }
}

process.stdout.write(JSON.stringify({pass:true})+'\n');
