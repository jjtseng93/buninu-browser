// Isolated host realm, real MP3 decoder, in-memory audio device (no loudspeaker).
import assert from 'node:assert/strict';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
import wasmpeg from '../../vendor/wasmpeg/src/js/index.js';
const sleep=Bun.sleep,fixture=new URL('./tone.mp3',import.meta.url);
await wasmpeg.load();
const bytes=new Uint8Array(await Bun.file(fixture).arrayBuffer());
let listener,closed=0;const chunks=[];
const renderer=await createPageRenderer({videoDecoder:wasmpeg,
 fetchResource:async()=>({ok:true,body:bytes,contentType:'audio/mpeg'}),
 audio:{open(options,fn){listener=fn;return 1},write(id,pcm){chunks.push(Buffer.from(pcm))},finish(){},close(){closed++;return Promise.resolve(0)}},
});
try{
 renderer.setScripting('host');
 await renderer.loadDocument({url:'file:///tmp/qml-media-audio.qml',contentType:'text/x-qml',source:`import QtQuick
import QtMultimedia
Item {width:100;height:100
 AudioOutput {id:out;volume:1}
 MediaPlayer {id:player;source:${JSON.stringify(fixture.href)};audioOutput:out}
 Button {id:play;onClicked:player.play()}
 Button {id:mute;onClicked:out.muted=true}
 Button {id:pause;onClicked:player.pause()}
}`});
 await renderer.whenLoaded();
 await sleep(100);
 await renderer.evaluate("document.getElementById('play').click()");
 for(let i=0;i<100&&!listener;i++)await sleep(20);
 assert.ok(listener,'real MP3 opens the existing audio output');
 listener({event:'request',bytes:2048});
 assert.ok(chunks.length>0);
 assert.ok(chunks.at(-1).some(x=>x!==0),'decoded MP3 produces nonzero PCM');
 await renderer.evaluate("document.getElementById('mute').click()");
 await sleep(20);
 listener({event:'request',bytes:2048});
 assert.ok(chunks.at(-1).every(x=>x===0),'mute clears the output chunk');
 await renderer.evaluate("document.getElementById('pause').click()");
 assert.ok(closed>0,'pause closes the audio output');
 process.stdout.write('QML real MP3 PCM playback passed\n');
}finally{renderer.dispose()}
