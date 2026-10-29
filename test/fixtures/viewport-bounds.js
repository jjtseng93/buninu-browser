import { createPageRenderer } from "../../lib/renderer/page-renderer.js";
import { StyleEngine } from "../../lib/style/computed-style.js";

const originalGet = StyleEngine.prototype.get;
let counting = false, styleReads = 0, checks = 0;
StyleEngine.prototype.get = function (element) {
  if (counting) styleReads++;
  return originalGet.call(this, element);
};

await import("../../vendor/ses/dist/ses.mjs");
lockdown({ errorTaming: "safe", overrideTaming: "severe", consoleTaming: "unsafe",
  localeTaming: "unsafe", stackFiltering: "concise", reporting: "none" });

function check(condition, message) {
  if (!condition) throw new Error(message);
  checks++;
}
function equal(actual, expected, message) {
  check(Bun.deepEquals(actual, expected, true), `${message}: ${JSON.stringify(actual)}`);
}
const errors = [];
const renderer = await createPageRenderer({ embedded: true,
  reportError: error => errors.push(String(error)) });
const evaluate = source => renderer.evaluate(source);
async function countsStyles(source) {
  styleReads = 0;
  counting = true;
  try { return await evaluate(source); }
  finally { counting = false; }
}
const settle = () => Bun.sleep(20);

try {
  renderer.setScripting("ses");
  renderer.resize(260, 180, 1);
  await renderer.loadDocument({ url: "https://bounds.test/", contentType: "text/html", source: `
    <!doctype html><style>
      body { margin:0; min-height:1000px; min-width:500px; font:14px sans-serif }
      #hidden { display:none; --tone:rgb(12,34,56); color:var(--tone) }
      #leaf { display:inline-block; width:7ch; height:28px; font-family:monospace }
      #ownNone { display:none }
      #contents, #emptyContents { display:contents }
      #fixed { position:fixed; left:140px; top:8px; width:90px; height:55px; background:rgb(0,128,0) }
      #scroller { width:120px; height:55px; overflow:auto; border:3px solid blue; padding:2px }
      #inner { width:300px; height:220px }
      #button { width:80px; height:30px }
    </style>
    <div id="hidden"><section id="chain"><span id="leaf">hidden</span></section></div>
    <div id="ownNone">none</div><div id="emptyContents"></div><span id="emptyInline"></span>
    <div id="contents"><span id="inline">inline text</span></div>
    <svg id="svg" width="28" height="24"><path id="path" d="M1 1h20v16H1z" fill="red"/></svg>
    <div id="fixed"></div><div id="scroller"><div id="inner"></div></div>
    <button id="button">hit</button>` });
  await renderer.whenLoaded();
  await evaluate(`
    window.leaf=document.getElementById('leaf');
    window.detached=document.createElement('div');
    window.rect=e=>{const r=e.getBoundingClientRect();return[r.x,r.y,r.width,r.height]};
    window.sizes=e=>[...rect(e),e.offsetWidth,e.offsetHeight,e.clientWidth,e.clientHeight,
      e.scrollWidth,e.scrollHeight,e.scrollLeft,e.scrollTop];
    window.clicks=0;document.getElementById('button').onclick=()=>clicks++;
    window.scrolls=0;document.getElementById('scroller').onscroll=()=>scrolls++;
  `);

  const empty = await countsStyles(`(() => {
    const elements=['leaf','ownNone','emptyContents','emptyInline','path'].map(id=>document.getElementById(id));
    elements.push(detached);
    const range=document.createRange();range.selectNodeContents(leaf);
    return [...elements.map(sizes),rect({getBoundingClientRect:()=>range.getBoundingClientRect()})];
  })()`);
  check(empty.every(values => values.every(value => value === 0)), "boxless geometry is zero");
  equal(styleReads, 0, "boxless bounds and sizes do not materialize hidden styles");
  equal(await countsStyles(`(() => {
    leaf.scrollTo(20,30);leaf.scrollTop=12;leaf.scrollLeft=3;
    return [leaf.scrollLeft,leaf.scrollTop];
  })()`), [0, 0], "hidden scroll setters remain ineffective");
  equal(styleReads, 0, "hidden scroll setters do not read styles");

  const css = await countsStyles(`(() => {
    const s=getComputedStyle(leaf);return[s.color,s.width,s.getPropertyValue('--tone')];
  })()`);
  equal([css[0], css[2]], ["rgba(12, 34, 56, 1)", "rgb(12,34,56)"], "explicit hidden CSS still resolves");
  check(css[1].endsWith("px") && Number.parseFloat(css[1]) > 0, "hidden ch width resolves to positive pixels");
  check(styleReads > 0, "explicit CSS materializes the deferred style");
  await evaluate(`leaf.style.width='81px';leaf.style.height='29px';leaf.style.color='rgb(9,8,7)';
    document.getElementById('hidden').style.setProperty('--tone','purple')`);
  equal(await evaluate(`(() => {const s=getComputedStyle(leaf);
    return[s.width,s.height,s.color,s.getPropertyValue('--tone')];})()`),
    ["81px", "29px", "rgba(9, 8, 7, 1)", "purple"], "hidden CSS updates remain live");

  const rendered = await evaluate(`['inline','contents','svg'].map(id=>rect(document.getElementById(id)))`);
  check(rendered[0][2] > 0 && rendered[1][2] > 0, "inline and display-contents text retain bounds");
  equal(rendered[2].slice(2), [28, 24], "SVG retains its rendered dimensions");

  await evaluate(`window.resizeWidths=[];window.intersections=[];
    window.ro=new ResizeObserver(es=>resizeWidths.push(es[0].contentRect.width));ro.observe(leaf);
    window.io=new IntersectionObserver(es=>intersections.push(es[0].isIntersecting));io.observe(leaf)`);
  await settle();
  equal(await evaluate(`[resizeWidths.length,intersections.at(-1)]`), [0, false], "initial zero size does not notify ResizeObserver");
  await evaluate(`document.getElementById('hidden').style.display='block'`);
  await settle();
  equal(await evaluate(`[resizeWidths.at(-1),intersections.at(-1)]`), [81, true], "reveal updates observer geometry");
  await evaluate(`document.getElementById('hidden').style.display='none'`);
  await settle();
  equal(await evaluate(`[resizeWidths.at(-1),intersections.at(-1)]`), [0, false], "hiding updates observer geometry");

  await evaluate(`document.getElementById('fixed').append(leaf)`);
  const fixed = await evaluate(`rect(leaf)`);
  renderer.scrollTo(60, 130);
  equal(await evaluate(`rect(leaf)`), fixed, "a fixed ancestor cancels viewport scrolling");
  renderer.scrollTo(0, 0);
  await evaluate(`document.getElementById('inner').append(leaf)`);
  const beforeScroll = await evaluate(`rect(leaf)`);
  await evaluate(`document.getElementById('scroller').scrollTo(60,70)`);
  await settle();
  const afterScroll = await evaluate(`rect(leaf)`);
  equal(afterScroll, [beforeScroll[0] - 60, beforeScroll[1] - 70, beforeScroll[2], beforeScroll[3]],
    "scroll-container offsets remain part of viewport bounds");
  check(await evaluate("scrolls > 0"), "scroll event still fires");
  await evaluate(`leaf.style.visibility='hidden'`);
  equal(await evaluate(`rect(leaf)`), afterScroll, "visibility hidden retains geometry");
  await evaluate(`leaf.style.visibility='visible';leaf.style.transform='translate(8px,5px)'`);
  const translated = await evaluate(`rect(leaf)`);
  equal(translated, [afterScroll[0] + 8, afterScroll[1] + 5, afterScroll[2], afterScroll[3]],
    "translated coordinates remain intact");

  await evaluate(`leaf.remove()`);
  equal(await countsStyles("sizes(leaf)"), Array(12).fill(0), "detached geometry is zero");
  equal(styleReads, 0, "detached geometry does not read stale styles");
  await evaluate(`document.getElementById('chain').append(leaf);window.destroyed=document.getElementById('chain');
    document.getElementById('hidden').innerHTML=''`);
  equal(await countsStyles("[...sizes(leaf),...sizes(destroyed)]"), Array(24).fill(0), "removed subtree has no geometry");
  equal(styleReads, 0, "removed subtree does not materialize styles");

  renderer.resize(220, 160, 2);
  const image = await renderer.screenshot({ format: "rgba" });
  equal([image.width, image.height], [440, 320], "DPR scales the raster");
  const pixel = (100 * image.width + 400) * 4;
  equal([...image.pixels.slice(pixel, pixel + 4)], [0, 128, 0, 255], "fixed box still paints at the expected viewport position");
  const button = await evaluate("rect(document.getElementById('button'))");
  renderer.click(button[0] + 10, button[1] + 10);
  equal(await evaluate("clicks"), 1, "visible geometry still targets pointer activation");
  equal(errors, [], "renderer reports no errors");
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  renderer.dispose();
}
