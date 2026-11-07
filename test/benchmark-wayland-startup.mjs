// Run with the native Bun used by the frontend; reports raster/allocation, not compositor display latency.
import {startupFrame} from '../frontends/wayland/startup-frame.js';
for(const [w,h] of [[704,406],[800,600],[1920,1080],[3840,2160]]){
 const times=[];for(let i=0;i<10;i++){const t=performance.now();const frame=startupFrame(w,h,'file:///data/data/com.termux/files/home/flea-qml/ui/boot/shell.qml');times.push(performance.now()-t);if(frame.reduce((n,b)=>n+b.length,0)!==w*h*4)throw Error('size');}
 console.log(JSON.stringify({w,h,min:Math.min(...times),max:Math.max(...times),mean:times.reduce((a,b)=>a+b)/times.length,times}));
}
