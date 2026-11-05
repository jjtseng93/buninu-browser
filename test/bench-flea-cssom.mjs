// Finite, opt-in performance probe. Imports unchanged Flea QML and profiles the
// production renderer; no connection to an existing compositor is made.
// bun test/bench-flea-cssom.mjs --scenario=spinner --snapshot=/tmp/flea-cssom-before
// bun test/bench-flea-cssom.mjs --scenario=spinner --output=/tmp/flea-cssom-after.json
// bun test/bench-flea-cssom.mjs --scenario=app --binary=/path/to/flea
// To compare a candidate, first copy (cp, never hardlink) these files beneath
// a snapshot directory, preserving their lib/... relative paths:
// lib/renderer/bindings.js, lib/happy-dom/css-declaration-mutations.js,
// lib/happy-dom/css-border-pending.js. --snapshot substitutes only those files.
// CPU time is aggregate process/thread CPU, not wall time or FPS. Serialization
// time is nested within style-write time; do not add those costs. Repeat runs
// in AB/BA order, since backend activity, scheduling and GC can vary.
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {RendererHost} from '../lib/renderer/host.js';
import {fleaSandbox} from './helpers/flea-sandbox.js';

const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const repo = realpathSync(resolve(import.meta.dir, '..'));
const flea = resolve(option('flea', process.env.BUNINU_FLEA_ROOT || '../flea-qml'));
const omarchy = resolve(option('omarchy', process.env.BUNINU_OMARCHY_ROOT || '../omarchy-qml-reference'));
const snapshot = option('snapshot', '');
const scenario = option('scenario', 'app');
const warmup = Number(option('warmup', '3000')), duration = Number(option('duration', '5000'));
const output = option('output', `/tmp/flea-cssom-${snapshot ? 'before' : 'after'}-${scenario}.json`);
if (!['app', 'spinner'].includes(scenario) || !Number.isFinite(warmup) || !Number.isFinite(duration) || warmup < 0 || duration <= 0)
  throw Error('Use --scenario=app|spinner and finite --warmup/--duration milliseconds');
if (!existsSync(join(flea, 'ui/boot/shell.qml'))) throw Error(`Missing Flea QML: ${flea}`);
const binary = option('binary', process.env.FLEA_BIN || Bun.which('flea') || '');
if (scenario === 'app' && (!binary || !existsSync(binary))) throw Error('Flea app requires --binary=/path/to/flea, FLEA_BIN, or flea on PATH');

const temporary = mkdtempSync('/tmp/flea-cssom-bench-');
const entry = join(temporary, 'renderer.mjs');
// Snapshot substitution only affects this child process. The original paths
// remain resolution bases for relative imports; files are copied, never linked.
writeFileSync(entry, `
import {plugin} from 'bun';
import {readFileSync,realpathSync} from 'node:fs';
import {relative,join} from 'node:path';
const repo=${JSON.stringify(repo)}, snapshot=${JSON.stringify(snapshot ? resolve(snapshot) : '')}, baselineModules=[];
if(snapshot) plugin({name:'flea-cssom-baseline',setup(build){
  build.onLoad({filter:/(?:bindings|css-declaration-mutations|css-border-pending)\\.js$/},args=>{
    const path=relative(repo,realpathSync(args.path));
    const selected=['lib/renderer/bindings.js','lib/happy-dom/css-declaration-mutations.js','lib/happy-dom/css-border-pending.js'].includes(path);
    if(selected)baselineModules.push(path);
    return {contents:readFileSync(selected?join(snapshot,path):args.path,'utf8'),loader:'js'};
  });
}});
await import(join(repo,'lib/happy-dom/parser.js'));
await import(join(repo,'lib/renderer/bindings.js'));
const {default:Manager}=await import(join(repo,'vendor/happy-dom/packages/happy-dom/src/css/declaration/property-manager/CSSPropertyManager.ts'));
const {default:Parser}=await import(join(repo,'vendor/happy-dom/packages/happy-dom/src/css/declaration/utilities/CSSTextParser.ts'));
const {default:Declaration}=await import(join(repo,'vendor/happy-dom/packages/happy-dom/src/css/declaration/CSSStyleDeclaration.ts'));
const {default:Element}=await import(join(repo,'vendor/happy-dom/packages/happy-dom/src/nodes/element/Element.ts'));
const now=()=>Bun.nanoseconds()/1e6, cpu=process.cpuUsage.bind(process), memory=process.memoryUsage.bind(process);
let stats, begun, cpuStart, depth=0;
function reset(){stats={styleWrites:0,styleWriteMs:0,serializations:0,serializeMs:0,clones:0,wholeDeclarationParses:0,svgDashUpdates:0};begun=now();cpuStart=cpu();}
reset();
const attribute=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(name,...args){if(name==='stroke-dashoffset')stats.svgDashUpdates++;return attribute.call(this,name,...args)};
const stringify=Manager.prototype.toString;
Manager.prototype.toString=function(...args){stats.serializations++;const outer=depth++===0,start=outer?now():0;try{return stringify.apply(this,args)}finally{depth--;if(outer)stats.serializeMs+=now()-start}};
const clone=Manager.prototype.clone;
Manager.prototype.clone=function(...args){stats.clones++;return clone.apply(this,args)};
const parse=Parser.parse;
Parser.parse=function(...args){stats.wholeDeclarationParses++;return parse.apply(this,args)};
for(const name of ['setProperty','removeProperty']){
 const original=Declaration.prototype[name];
 Declaration.prototype[name]=function(...args){stats.styleWrites++;const start=now();try{return original.apply(this,args)}finally{stats.styleWriteMs+=now()-start}};
}
globalThis.__fleaCSSOMBench={reset,snapshot(){const used=cpu(cpuStart);return {...stats,wallMs:now()-begun,cpuUserMs:used.user/1000,cpuSystemMs:used.system/1000,rssBytes:memory().rss,baselineModules}}};
await import(join(repo,'lib/renderer/main.js'));
`);

let sandbox, host, frames = 0, deadline, rendererPid;
const savedBinary = process.env.FLEA_BIN, savedPath = process.env.FLEA_PATH, savedImports = process.env.QML_IMPORT_PATH;
if (binary && existsSync(binary)) process.env.FLEA_BIN = binary;
const interrupted = () => {host?.close(); process.exitCode = 1};
process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
const report = {scenario, flea, binary: binary || null, snapshot: snapshot || null,
  warmupMs: warmup, requestedSteadyMs: duration, runtime:{bun:Bun.version,revision:Bun.revision,platform:process.platform,arch:process.arch}};
try {
  sandbox = fleaSandbox(flea, omarchy);
  const home = sandbox.values.HOME;
  mkdirSync(join(home, 'Documents')); writeFileSync(join(home, 'hello.txt'), 'Flea CSSOM benchmark\n');
  process.env.FLEA_PATH = home;
  // Use the packaged module search root when the checkout ships Omarchy QML.
  if (existsSync(join(flea, 'ui/qs/Commons/qmldir'))) process.env.QML_IMPORT_PATH = join(flea, 'ui');
  const file = scenario === 'app' ? join(flea, 'ui/boot/shell.qml') : join(temporary, 'spinner.qml');
  if (scenario === 'spinner') writeFileSync(file, `import QtQuick\nimport ${JSON.stringify(join(flea,'ui'))} as Flea\nRectangle { width:900; height:600; color:"#101315"\n Flea.Spinner { x:40; y:40; width:48; height:48; color:"#c0c0c0" }\n}`);
  const begin = performance.now();
  host = new RendererHost({entry,args:['--buninu-qml-host'],compositor:true,timeout:45000,onFrame(){frames++}});
  deadline = setTimeout(() => {host.close();process.exitCode=1}, 90000).unref();
  await host.start(); rendererPid = host.pid; report.rendererStartupMs = performance.now() - begin;
  await host.call('resize',900,600,1);
  await host.call('loadDocument',{url:Bun.pathToFileURL(file).href,contentType:'text/x-qml',source:await Bun.file(file).text()});
  await host.call('whenLoaded');
  report.loadMs = performance.now() - begin;
  report.startup = await host.call('evaluate','__fleaCSSOMBench.snapshot()');
  report.textAtLoad = await host.call('evaluate','document.body.innerText.slice(0,300)');
  if (snapshot && report.startup.baselineModules.length !== 3) throw Error('Baseline module substitution failed: '+JSON.stringify(report.startup.baselineModules));
  if (scenario === 'app' && existsSync(binary)) {
    const until = performance.now() + 30000;
    while (!(await host.call('evaluate','document.body.innerText.includes("hello.txt")'))) {
      if (performance.now() > until) throw Error('Flea backend did not finish its initial directory listing');
      await Bun.sleep(200);
    }
  }
  report.backendReadyMs = performance.now() - begin;
  await Bun.sleep(warmup);
  // Verify real pixels once, outside the timed interval. The probe does not
  // subscribe to screenshots repeatedly, so it measures CSSOM/rendering work
  // without adding an artificial image encoder workload.
  const screenshot = await host.composite('screenshot',{format:'png'});
  if (!screenshot) throw Error('Renderer did not produce a screenshot');
  report.screenshot = output.replace(/\.json$/, '') + '.png';
  await Bun.write(report.screenshot,Buffer.from(screenshot,'base64'));
  report.textAtSteady = await host.call('evaluate','document.body.innerText.slice(0,300)');
  await host.call('evaluate','__fleaCSSOMBench.reset()'); frames = 0;
  await Bun.sleep(duration);
  report.steady = await host.call('evaluate','__fleaCSSOMBench.snapshot()');
  // These are compositor notifications, not presentation FPS: a consumer may
  // subscribe only while capturing. No periodic screenshot load is added here.
  report.steady.compositorNotifications = frames;
  report.steady.serializeCpuSharePercent = 100 * report.steady.serializeMs / (report.steady.cpuUserMs + report.steady.cpuSystemMs);
  report.errors = await host.call('consoleMessages');
  report.textAfter = await host.call('evaluate','document.body.innerText.slice(0,300)');
  report.domElements = await host.call('evaluate','document.querySelectorAll("*").length');
  await Bun.write(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {
  clearTimeout(deadline);
  await host?.close();
  // close() currently sends SIGTERM synchronously; wait for the actual child
  // exit before removing the QML backend's HOME or generated renderer entry.
  if (rendererPid) for (let i=0;i<100;i++) {
    try {process.kill(rendererPid,0)} catch {break}
    await Bun.sleep(20);
  }
  sandbox?.close();
  if(savedBinary===undefined)delete process.env.FLEA_BIN;else process.env.FLEA_BIN=savedBinary;
  if(savedPath===undefined)delete process.env.FLEA_PATH;else process.env.FLEA_PATH=savedPath;
  if(savedImports===undefined)delete process.env.QML_IMPORT_PATH;else process.env.QML_IMPORT_PATH=savedImports;
  process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);
  rmSync(temporary,{recursive:true,force:true});
}
