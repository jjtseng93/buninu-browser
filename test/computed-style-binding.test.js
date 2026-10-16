import { afterAll, beforeAll, expect, test } from "bun:test";
import { RendererHost } from "../lib/renderer/host.js";

let renderer;
beforeAll(async () => {
  renderer = new RendererHost({ timeout: 20_000 });
  await renderer.start();
});
afterAll(() => renderer?.close());

test("computed corner radii preserve percentages, elliptical axes and logical mappings", async () => {
  await renderer.call("loadDocument", {
    url: "https://page.test/", contentType: "text/html", status: 200,
    source: `<!doctype html><style>
      #box { width:100px;height:80px;border-radius:60% 30% 15% 0 / 20% 40% 60% 0 }
      #rtl { direction:rtl;border-radius:10px;border-start-start-radius:2em 50% }
    </style><div id="box"></div><div id="rtl"></div>`,
  });
  await renderer.call("whenLoaded");
  const result = JSON.parse(await renderer.call("evaluate", `JSON.stringify(['box','rtl'].map(id=>{
    const s=getComputedStyle(document.getElementById(id));return [s.borderRadius,s.borderTopLeftRadius,s.borderTopRightRadius,s.borderStartStartRadius];
  }))`));
  expect(result).toEqual([
    ["60% 30% 15% 0px / 20% 40% 60% 0px", "60% 20%", "30% 40%", "60% 20%"],
    ["10px 32px 10px 10px / 10px 50% 10px 10px", "10px", "32px 50%", "32px 50%"],
  ]);
});

test("computed zero gaps remain numeric for script-driven responsive toolbars", async () => {
  await renderer.call("loadDocument", {
    url: "https://page.test/",
    source: `<!doctype html><style>
      #toolbar { display:flex;gap:0;font-style:italic;font-stretch:75% }
      #toolbar > div { width:80px;flex:none }
      #normal { gap:normal 0px } #inherited { gap:inherit }
      #reset { gap:12px;all:initial }
    </style><div id="toolbar"><div></div><div></div></div>
    <div id="normal"><div id="inherited"></div></div><div id="reset"></div>`,
    contentType: "text/html", status: 200,
  });
  await renderer.call("whenLoaded");
  const result = await renderer.call("evaluate", `JSON.stringify((() => {
    const toolbar = document.getElementById('toolbar');
    const style = getComputedStyle(toolbar);
    const widths = Array.from(toolbar.children, child => child.offsetWidth + 2 * parseInt(style.columnGap, 10));
    const gaps = id => { const s = getComputedStyle(document.getElementById(id)); return [s.rowGap,s.columnGap]; };
    return {widths, zero:gaps('toolbar'), normal:gaps('normal'), inherited:gaps('inherited'), reset:gaps('reset'),
      font:[style.fontStyle,style.fontStretch]};
  })())`);
  expect(JSON.parse(result)).toEqual({widths:[80,80], zero:["0px","0px"], normal:["normal","0px"],
    inherited:["normal","0px"], reset:["normal","normal"], font:["italic","75%"]});
});

test("computed transform matrices retain every translation and resolve nested length math", async () => {
  await renderer.call("loadDocument", {
    url:"https://page.test/",contentType:"text/html",status:200,
    source:`<!doctype html><style>div{width:100px;height:150px}
      #popup{transform:translate(56px,780px) translate(0,-100%)}
      #math{transform:scale(2) translate(calc(25% + 10px),min(20%,40px)) translate(10%,5px)}
    </style><div id="popup"></div><div id="math"></div>`,
  });
  await renderer.call("whenLoaded");
  expect(JSON.parse(await renderer.call("evaluate", `JSON.stringify(['popup','math'].map(id=>getComputedStyle(document.getElementById(id)).transform))`)))
    .toEqual(["matrix(1, 0, 0, 1, 56, 630)","matrix(2, 0, 0, 2, 90, 70)"]);
});

test("focus invalidates subjects, ancestor paths, siblings and relational selectors", async () => {
  await renderer.call("loadDocument", {
    url:"https://page.test/",contentType:"text/html",status:200,
    source:`<!doctype html><style>
      input{color:black}input:focus{color:red}input:focus-visible{background:yellow}
      section{color:black}section:focus-within{color:green}
      :where(.group,.alternative):focus-within .nested{color:blue}
      section:has(input:focus) .related{color:red}
      section:focus-within + aside .following{color:purple}
    </style><section class="group" id="left"><input id="a"><i class="nested"></i><i class="related"></i></section>
    <aside><i class="following"></i></aside><section class="alternative" id="right"><input id="b"></section>`,
  });
  await renderer.call("whenLoaded");
  const read = async action => JSON.parse(await renderer.call("evaluate", `JSON.stringify((()=>{
    ${action};return ['#a','#b','#left','#right','.nested','.related','.following'].map(s=>{const e=document.querySelector(s);return e?getComputedStyle(e).color:null})
  })())`));
  const black="rgba(0, 0, 0, 1)",red="rgba(255, 0, 0, 1)",green="rgba(0, 128, 0, 1)",blue="rgba(0, 0, 255, 1)",purple="rgba(128, 0, 128, 1)";
  expect(await read("document.getElementById('a').focus()"))
    .toEqual([red,black,green,black,blue,red,purple]);
  expect(await read("document.getElementById('b').focus()"))
    .toEqual([black,red,black,green,black,black,black]);
  expect(await read("document.getElementById('left').appendChild(document.getElementById('b'))"))
    .toEqual([black,black,black,black,black,black,black]);
  expect(await read("document.getElementById('b').focus()"))
    .toEqual([black,red,green,black,blue,red,purple]);
  expect(await read("document.getElementById('b').remove();document.getElementById('a').focus();document.getElementById('a').blur()"))
    .toEqual([black,null,black,black,black,black,black]);
});

test("metadata mutations invalidate only selectors that observe those attributes", async () => {
  await renderer.call("loadDocument", {
    url:"https://page.test/",contentType:"text/html",status:200,
    source:`<!doctype html><style>
      section,span{color:black}[data-open] span{color:red}
      section:has([aria-expanded="true"]){color:green}span[title="visible"]{color:blue}
    </style><section><span>Label</span></section>`,
  });
  await renderer.call("whenLoaded");
  expect(JSON.parse(await renderer.call("evaluate", `JSON.stringify((()=>{
    const parent=document.querySelector('section'),child=document.querySelector('span'),result=[];
    const read=()=>result.push([getComputedStyle(parent).color,getComputedStyle(child).color]);
    for(let i=0;i<20;i++){child.setAttribute('aria-activedescendant','item'+i);child.dataset.internal=String(i);read()}
    parent.dataset.open='';child.setAttribute('aria-expanded','true');read();child.title='visible';read();
    return [result[0],result[19],result[20],result[21]];
  })())`))).toEqual([
    ["rgba(0, 0, 0, 1)","rgba(0, 0, 0, 1)"], ["rgba(0, 0, 0, 1)","rgba(0, 0, 0, 1)"],
    ["rgba(0, 128, 0, 1)","rgba(255, 0, 0, 1)"], ["rgba(0, 128, 0, 1)","rgba(0, 0, 255, 1)"],
  ]);
});

test("focus invalidation reaches descendants through nested stylesheet groups", async () => {
  await renderer.call("loadDocument",{
    url:"https://page.test/",contentType:"text/html",status:200,
    source:'<!doctype html><style>body{color:black}@media(min-width:1px){@layer app{.panel:focus-within span{color:red}}}</style><div class="panel"><input><span>Label</span></div>',
  });
  await renderer.call("whenLoaded");
  expect(JSON.parse(await renderer.call("evaluate",`JSON.stringify((()=>{
    const input=document.querySelector('input'),label=document.querySelector('span');input.focus();
    const focused=getComputedStyle(label).color;input.blur();return[focused,getComputedStyle(label).color];
  })())`))).toEqual(["rgba(255, 0, 0, 1)","rgba(0, 0, 0, 1)"]);
});

test("native label activation restyles both radios and relational ancestors without a global reset", async () => {
  await renderer.call("loadDocument", {
    url:"https://page.test/",contentType:"text/html",status:200,
    source:`<!doctype html><style>label{display:block}span,form{color:black}input:checked+span{color:red}
      form:has(#second:checked){color:purple}</style><form>
      <label><input type="radio" name="choice" checked id="first"><span id="firstText">First</span></label>
      <label id="secondLabel"><input type="radio" name="choice" id="second"><span id="secondText">Second</span></label></form>`,
  });
  await renderer.call("whenLoaded");
  const position = JSON.parse(await renderer.call("evaluate", `JSON.stringify((()=>{const r=document.getElementById('secondText').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})())`));
  await renderer.call("click",...position);
  const result = JSON.parse(await renderer.call("evaluate", `JSON.stringify([document.getElementById('first').checked,document.getElementById('second').checked,
    ...['#firstText','#secondText','form'].map(s=>getComputedStyle(document.querySelector(s)).color)])`));
  expect(result).toEqual([false,true,"rgba(0, 0, 0, 1)","rgba(255, 0, 0, 1)","rgba(128, 0, 128, 1)"]);
});

test("summary UA styles follow disclosure state and principal-summary changes incrementally", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/summary-style.js", import.meta.url).pathname],
    { stdout:"pipe", stderr:"pipe" });
  const [exit,stderr] = await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
});
