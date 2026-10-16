#!/usr/bin/env bun
// End-to-end bounded DOM/canvas/image churn, navigation and CDP capture soak.
// Usage: bun tools/browser-soak.js buninu /tmp/browser-soak 900
import { join, resolve } from 'node:path';
import { launch } from './browser-lab.js';
import { encodeImage } from '../lib/paint/frame.js';
import { processMemory } from './process-memory.js';

const [engine = 'buninu', directory = '/tmp/browser-soak', seconds = '600'] = process.argv.slice(2);
const duration = Math.max(1, Number(seconds)) * 1000;
const dir = resolve(directory);
const rgba = new Uint8Array(32 * 32 * 4);
for (let i = 0; i < rgba.length; i += 4) rgba.set([30, 120, 210, 255], i);
const png = await encodeImage(rgba, 32, 32);
let requests = 0;
const server = Bun.serve({ port: 0, fetch(request) {
  requests++;
  const url = new URL(request.url);
  if (url.pathname === '/pixel.png') return new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=3600' } });
  return new Response(`<!doctype html><meta charset="utf-8"><title>Browser soak ${url.search}</title>
    <style>body{margin:0;font:16px sans-serif;background:#fafafa}header{position:sticky;top:0;background:#135;color:white;padding:12px;z-index:2}main{padding:12px}.card{display:flex;gap:12px;align-items:center;padding:8px;border-bottom:1px solid #ddd}canvas{display:block}button{font:inherit}</style>
    <header>Navigation ${url.search} · <span id="counter">0</span> <button id="toggle">Toggle</button></header>
    <main><canvas id="paint" width="800" height="120"></canvas><section id="cards">${Array.from({length:160}, (_,i)=>`<div class="card"><img src="/pixel.png" width="32" height="32"><span>Row ${i}: Browser rendering, memory and input exercise 中文 🙂</span></div>`).join('')}</section></main>
    <script>
      let tick=0; const paint=document.getElementById('paint'); const context=paint.getContext('2d');
      const counter=document.getElementById('counter'); const cards=document.getElementById('cards');
      document.getElementById('toggle').onclick=()=>document.body.style.background=tick%2?'#def':'#fed';
      setInterval(()=>{tick++;counter.textContent=String(tick);context.fillStyle=tick%2?'#69c':'#c96';context.fillRect((tick*11)%760,20,40,80);
        if(tick%10===0){const card=cards.firstElementChild;card.querySelector('span').textContent='Recycled row '+tick;cards.appendChild(card);}
        if(tick%20===0){for(let i=0;i<8;i++){const c=document.createElement('canvas');c.width=800;c.height=600;c.getContext('2d').fillRect(0,0,800,600);}}
      },100);
    </script>`, { headers: { 'content-type': 'text/html' } });
} });

let browser;
const samples = [];
const errors = [];
const started = performance.now();
let navigations = 0;
try {
  browser = await launch(engine, dir);
  const writer = Bun.file(join(dir, 'samples.jsonl')).writer();
  const { cdp } = browser;
  let nextNavigation = 0;
  while (performance.now() - started < duration) {
    const elapsed = performance.now() - started;
    if (elapsed >= nextNavigation) {
      const host = Math.floor(navigations / 4) % 2 ? 'localhost' : '127.0.0.1';
      await cdp.send('Page.navigate', { url: `http://${host}:${server.port}/page?n=${navigations++}` });
      nextNavigation = elapsed + 15000;
      await Bun.sleep(300);
    }
    try {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 500, deltaY: samples.length % 20 < 10 ? 180 : -180, deltaX: 0 });
      const before = performance.now();
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
      const captureMs = performance.now() - before;
      const counter = await cdp.evaluate(`document.getElementById('counter')?.textContent`);
      const processes = await processMemory(browser.proc.pid);
      const sample = { elapsedMs: Math.round(elapsed), navigation: navigations, counter, captureMs, encodedLength: data.length, rssMiB: processes ? processes.reduce((sum,p)=>sum+p.rssKiB,0)/1024 : null, processes };
      samples.push(sample);writer.write(JSON.stringify(sample)+'\n');writer.flush();
      if (samples.length % 30 === 0) await Bun.write(join(dir, 'latest.png'), Buffer.from(data, 'base64'));
      if (samples.length % 60 === 0) console.log(JSON.stringify(sample));
    } catch (error) { errors.push({ elapsedMs: Math.round(elapsed), error: error.message }); }
    await Bun.sleep(1000);
  }
  await writer.end();
} finally {
  await browser?.stop();server.stop(true);
  const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
  const report = { engine, elapsedMs: performance.now()-started, navigations, requests, samples: samples.length, errors,
    peakRssMiB: Math.max(0,...samples.map(s=>s.rssMiB)), firstMinuteRssMiB: mean(samples.filter(s=>s.elapsedMs>=60000&&s.elapsedMs<120000).map(s=>s.rssMiB)),
    lastMinuteRssMiB: mean(samples.filter(s=>s.elapsedMs>duration-60000).map(s=>s.rssMiB)), captureMeanMs: mean(samples.map(s=>s.captureMs)) };
  await Bun.write(join(dir, 'report.json'), JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
