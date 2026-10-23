// Opt-in integration: unmodified packaged QML and the real installed Flea binary.
import { test, expect } from 'bun:test';
import { join } from 'node:path';
import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createBrowser } from '../lib/headless-shell.js';
import { fleaSandbox } from './helpers/flea-sandbox.js';
const root = process.env.BUNINU_FLEA_ROOT,
  omarchy = process.env.BUNINU_OMARCHY_ROOT,
  binary = process.env.FLEA_BIN;
test.skipIf(!root || !omarchy || !binary)(
  'measure real Flea directory navigation and raw capture',
  async () => {
    const sandbox = fleaSandbox(root, omarchy),
      oldPath = process.env.FLEA_PATH;
    const home = sandbox.values.HOME,
      folder = join(home, 'Documents');
    mkdirSync(folder);
    writeFileSync(join(home, 'hello.txt'), 'hello');
    writeFileSync(join(folder, 'inside.txt'), 'inside');
    process.env.FLEA_PATH = home;
    let browser;
    try {
      browser = await createBrowser({
        spareRenderer: false,
        rendererTimeout: 30000,
      });
      await browser.context.addInitScript(
        `globalThis.qmlErrors=[];addEventListener('error',e=>qmlErrors.push(String(e.error?.stack||e.message)));const original=console.error;console.error=(...args)=>{qmlErrors.push(args.map(String).join(' '));original(...args);};`,
      );
      if (process.env.BUNINU_QML_TIMING_TRACE)
        await browser.context.addInitScript(`
        globalThis.qmlTiming=[];
        const stamp=(kind,detail)=>qmlTiming.push({at:Date.now(),kind,detail});
        stamp('init',!!globalThis.__qmlHost);
        const microtask=globalThis.queueMicrotask;
        globalThis.queueMicrotask=fn=>microtask(()=>{const start=Date.now();try{return fn();}finally{const ms=Date.now()-start;if(ms>10)stamp('microtask',{ms,fn:String(fn).slice(0,180)});}});
        const timeout=globalThis.setTimeout;
        globalThis.setTimeout=(fn,delay,...args)=>timeout(()=>{const start=Date.now();try{return fn(...args);}finally{const ms=Date.now()-start;if(ms>10)stamp('timer',{ms,delay,fn:String(fn).slice(0,180)});}},delay);

        if(globalThis.__qmlHost){
          const host=globalThis.__qmlHost,run=host.run;
          for(const name of ['compile','read','write']){
            const original=host[name];if(!original)continue;
            host[name]=(...args)=>{const start=Date.now();try{return original(...args);}finally{const ms=Date.now()-start;if(ms>10)stamp('host-'+name,{ms,path:args[0]});}};
          }

          host.run=(command,callback,options={})=>{
            const traced={...options};
            for(const channel of ['stdout','stderr']) if(options[channel]) traced[channel]=chunk=>{
              stamp(channel,String(chunk).slice(0,500));
              const start=Date.now();try{return options[channel](chunk);}finally{stamp(channel+'-handled',Date.now()-start);}
            };
            const child=run.call(host,command,callback,traced),write=child.write;
            if(write)child.write=text=>{stamp('stdin',String(text).slice(0,500));return write(text);};
            return child;
          };
        }
        addEventListener('keydown',e=>stamp('keydown',e.key),true);
      `);
      await browser.context.navigate(
        Bun.pathToFileURL(join(sandbox.flea, 'ui/boot/shell.qml')).href,
      );
      const text = () => browser.context.evaluate('document.body.innerText');
      const until = async (predicate) => {
        for (let n = 0; n < 150; n++) {
          if (await predicate()) return;
          await Bun.sleep(40);
        }
        throw Error('Flea did not settle: ' + (await text()));
      };
      await until(async () => (await text()).includes('hello.txt'));
      const results = [];
      for (let i = 0; i < 6; i++) {
        const entering = i % 2 === 0,
          key = entering ? 'ArrowRight' : 'ArrowLeft';
        const start = performance.now();
        await browser.context.press(key, { code: key });
        const dispatch = performance.now();
        for (let n = 0; n < 300; n++) {
          const content = await text();
          if (
            entering
              ? content.includes('inside.txt') && !content.includes('hello.txt')
              : content.includes('hello.txt') && !content.includes('inside.txt')
          )
            break;
          if (n === 299) throw Error('Navigation timed out: ' + key);
          await Bun.sleep(10);
        }
        const ready = performance.now();
        const frame = JSON.parse(
          await browser.context.screenshot({ format: 'bgra' }),
        );
        if (frame.path) unlinkSync(frame.path);
        const painted = performance.now();
        results.push({
          key,
          dispatchMs: dispatch - start,
          contentMs: ready - start,
          captureMs: painted - ready,
          totalMs: painted - start,
        });
        await Bun.sleep(250);
      }
      const fsTimes = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        for (const dir of [home, folder])
          for (const name of readdirSync(dir)) statSync(join(dir, name));
        fsTimes.push(performance.now() - start);
      }
      const trace = process.env.BUNINU_QML_TIMING_TRACE
        ? JSON.parse(
            await browser.context.evaluate('JSON.stringify(qmlTiming)'),
          )
        : [];
      const report = {
        viewport: '800x600',
        results,
        fsReadBothDirsMs: fsTimes,
        trace,
      };
      await Bun.write(
        '/tmp/flea-navigation-timing.json',
        JSON.stringify(report, null, 2),
      );
      console.log(JSON.stringify(report));
      // Wait through the upstream prebuild driver's first idle tick too.
      await Bun.sleep(1500);
      expect(await browser.context.evaluate('JSON.stringify(qmlErrors)')).toBe(
        '[]',
      );
    } finally {
      browser?.close();
      if (oldPath === undefined) delete process.env.FLEA_PATH;
      else process.env.FLEA_PATH = oldPath;
      sandbox.close();
    }
  },
  60000,
);
