import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createPageRenderer, loadGraphics } from "../../lib/renderer/page-renderer.js";
import { supportsFrameCheckpoint } from "../../lib/renderer/animation-frames.js";
await import("../../vendor/ses/dist/ses.mjs");
await loadGraphics();
lockdown({ errorTaming: "safe", overrideTaming: "severe", consoleTaming: "unsafe",
  localeTaming: "unsafe", stackFiltering: "concise", reporting: "none" });
const errors = [], renderer = await createPageRenderer({ reportError: error => errors.push(String(error)) });
const load = async path => {
  await renderer.loadDocument({ url: "https://frames.test/" + path, contentType: "text/html", source: "<p>Animation frames</p>" });
  await renderer.whenLoaded();
};
try {
  renderer.setScripting("ses"); renderer.resize(320, 220, 1); await load("first");
  const result = await renderer.evaluate(`
    new Promise(resolve => {
      const events=[], times=[]; let cancelled, sameBatch;
      const record=(name,time)=>{events.push(name);if(time!==undefined)times.push([name,time]);};
      addEventListener('error',event=>{if(event.message.includes('RAF_PROBE_THROW'))event.preventDefault();});
      requestAnimationFrame(function first(time){
        record('first',time);record(this===window?'this-window':'this-other');
        requestAnimationFrame(time=>record('nested',time));
        Promise.resolve().then(()=>{
          record('promise-one');requestAnimationFrame(time=>record('nested-microtask',time));
        }).then(()=>{record('promise-two');cancelAnimationFrame(cancelled);});
        queueMicrotask(()=>record('queue-microtask'));
        setTimeout(()=>record('timer'),0);
        const end=performance.now()+5;while(performance.now()<end){}
      });
      cancelled=requestAnimationFrame(time=>record('cancelled-from-microtask',time));
      requestAnimationFrame(time=>{record('third',time);cancelAnimationFrame(sameBatch);});
      sameBatch=requestAnimationFrame(time=>record('cancelled-from-callback',time));
      const early=requestAnimationFrame(()=>record('cancelled-early'));cancelAnimationFrame(early);
      requestAnimationFrame(time=>{record('throws',time);throw new Error('RAF_PROBE_THROW');});
      requestAnimationFrame(time=>{record('after-throw',time);requestAnimationFrame(time=>{
        record('finish',time);resolve({events,times,groups:new Set(times.map(entry=>entry[1])).size});
      });});
    })
  `);
  assert.deepEqual(result.events, ["first", "this-window", "promise-one", "queue-microtask", "promise-two", "third", "throws", "after-throw", "timer", "nested", "nested-microtask", "finish"]);
  if (supportsFrameCheckpoint()) {
    assert.equal(result.groups, 2);
    assert.ok(result.times.slice(0, 4).every(entry => entry[1] === result.times[0][1]));
    assert.ok(result.times.slice(4).every(entry => entry[1] === result.times[4][1]));
    assert.ok(result.times[4][1] > result.times[0][1]);
  }
  assert.equal(errors.length, 1); assert.ok(errors[0].includes("RAF_PROBE_THROW")); errors.length = 0;
  await renderer.evaluate(`requestAnimationFrame(() => { throw new Error("old frame"); })`);
  await load("second");
  assert.equal(await renderer.evaluate(`new Promise(resolve => requestAnimationFrame(time => resolve(typeof time)))`), "number");
  await delay(25); assert.deepEqual(errors, []);
  await renderer.evaluate(`requestAnimationFrame(() => { throw new Error("disposed frame"); })`);
  renderer.dispose(); await delay(25); assert.deepEqual(errors, []);
  console.log("animation frame ordering and lifecycle passed");
} finally { renderer.dispose(); }
