import {test,expect} from 'bun:test';
import {startupFrame,attachStartup} from '../frontends/wayland/startup-frame.js';

test('startup frame is opaque BGRA with bounded text, including tiny windows',()=>{
 for(const [w,h] of [[1,1],[20,20],[320,100]]) {
  const frame=Buffer.concat(startupFrame(w,h,'file:///tmp/測試.qml'));
  expect(frame.length).toBe(w*h*4);
  for(let i=3;i<frame.length;i+=4)if(frame[i]!==255)throw Error('nonopaque pixel');
  expect([...frame.subarray(0,4)]).toEqual([27,28,32,255]);
 }
 expect(Buffer.concat(startupFrame(320,100,'a.qml')).equals(Buffer.concat(startupFrame(320,100,'b.qml')))).toBe(false);
 expect(()=>startupFrame(0,100,'a')).toThrow();
});
test('placeholder paints once per size, retries unavailable buffers, and stops permanently',()=>{
 let n=0;const metrics=[];
 const window={width:320,height:100,available:false,present(){n++;return true}};
 const startup=attachStartup(window,'a.qml',t=>metrics.push(t));
 startup.draw();expect(n).toBe(0);
 window.available=true;startup.draw();startup.draw();expect(n).toBe(1);
 window.width=400;startup.draw();expect(n).toBe(2);
 expect(metrics[1].width).toBe(400);
 startup.stop();window.width=500;startup.draw();expect(n).toBe(2);
});
