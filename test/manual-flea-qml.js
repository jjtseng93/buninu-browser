// Manual, opt-in Wayland demo. Uses real QML imports, not injected JS globals.
import {launch} from '../frontends/wayland/index.js';
const url=new URL('./fixtures/qml/flea/demo.qml',import.meta.url).href;
const app=await launch({url,width:640,height:400});
try {
  console.log('Flea EscapeHint: real component imports and a local test Theme.qml singleton (not full Flea).');
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,app.close);
  await app.done;
}finally{app.close();}
