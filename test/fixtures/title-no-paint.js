import {strict as assert} from 'node:assert';
import {createPageRenderer} from '../../lib/renderer/page-renderer.js';
const traces=[];
const r=await createPageRenderer({trace:s=>traces.push(s)});
try{
 r.setScripting('host');
 await r.loadDocument({url:'https://title.test/',contentType:'text/html',source:`<title>Initial</title><p>Before</p><script>globalThis.changeTitle=value=>{document.title=value;document.querySelector('p').textContent='Changed '+value};</script>`});
 await r.whenLoaded();
 assert.equal(r.title(),'Initial');
 // Host scripting allows the fixture to mutate the DOM without evaluate()'s
 // explicit refresh. No onFrame callback: pending work stays pending.
 for(const title of ['Updated','']){
  globalThis.changeTitle(title);
  traces.length=0;
  assert.equal(r.title(),title);
  assert.equal(traces.length,0,'title reads must not rebuild or rasterize');
  await r.screenshot();
  assert.ok(traces.some(s=>s.includes('restyle and relayout')),'DOM mutations remain pending until rendering is requested');
 }
}finally{delete globalThis.changeTitle;r.dispose()}
