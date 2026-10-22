// Manual, opt-in Wayland demo. Never starts the Flea backend or host services.
import {launch} from '../frontends/wayland/index.js';
import {themeScript,wrapEscapeHint} from './fixtures/qml/flea/harness.js';
const source=await Bun.file(new URL('./fixtures/qml/flea/EscapeHint.qml',import.meta.url)).text();
const app=await launch({width:640,height:400});
try {
  app.browser.context.addInitScript(themeScript);
  await app.browser.context.navigate('data:text/x-qml,'+encodeURIComponent(wrapEscapeHint(source)));
  console.log('Flea EscapeHint: upstream object, test-supplied Theme (not full Flea).');
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,app.close);
  await app.done;
}finally{app.close();}
