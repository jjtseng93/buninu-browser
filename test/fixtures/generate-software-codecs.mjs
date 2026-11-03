// Regenerate tiny synthetic codec fixtures; FFmpeg is needed only for this tool.
// Run: bun test/fixtures/generate-software-codecs.mjs
const root = new URL('./', import.meta.url).pathname;
const jobs=[
 ['software-hevc.mp4',['-f','lavfi','-i','color=c=orange:s=64x48:r=5','-frames:v','2','-c:v','libx265','-x265-params','pools=none:frame-threads=1','-preset','ultrafast','-tag:v','hvc1']],
 ['software-av1.mp4',['-f','lavfi','-i','color=c=blue:s=64x48:r=5','-frames:v','2','-c:v','libaom-av1','-cpu-used','8','-threads','1']],
 ['software-theora.ogv',['-f','lavfi','-i','color=c=green:s=64x48:r=5','-frames:v','2','-c:v','libtheora']],
 ['software-alac.m4a',['-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=0.1','-c:a','alac']],
 ['software-aac.aac',['-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=0.1','-c:a','aac','-f','adts']],
];
for(const [file,args] of jobs){const child=Bun.spawn(['ffmpeg','-hide_banner','-loglevel','error','-y',...args,root+file],{stdin:'ignore',stdout:'ignore',stderr:'pipe'});const error=await new Response(child.stderr).text();if(await child.exited)throw Error(file+': '+error);console.log(file+' '+Bun.file(root+file).size);}
