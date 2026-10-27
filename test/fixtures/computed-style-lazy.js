import { strict as assert } from "node:assert";
import { LayoutEngine } from "../../lib/layout/text-layout.js";
import { createPageRenderer } from "../../lib/renderer/page-renderer.js";

let layouts = 0;
const layout = LayoutEngine.prototype.layout;
LayoutEngine.prototype.layout = function (...args) { layouts++; return layout.apply(this, args); };
let releaseImage;
const imageReady = new Promise(resolve => { releaseImage = resolve; });
const redImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGP4z8AARAwoFABE0AX7pM/egAAAAABJRU5ErkJggg==", "base64");
const renderer = await createPageRenderer({ fetchResource: async url => {
  await imageReady;
  return { ok:true,status:200,url,contentType:"image/png",body:redImage };
} });
try {
  renderer.setScripting("host");
  await renderer.resize(400, 300, 1);
  await renderer.loadDocument({ url: "https://page.test/", contentType: "text/html", status: 200,
    source: `<!doctype html><style>body{margin:0}#box{width:50%;height:40px;color:red;--tone:red}
      #child{width:50%;height:20px;padding:5%}</style><div id="box"><div id="child">Text</div></div>` });
  await renderer.whenLoaded();
  globalThis.__layoutCalls = () => layouts;
  const styles = await renderer.evaluate(`(() => {
    const box=document.getElementById('box'),style=getComputedStyle(box),start=__layoutCalls();
    window.savedStyle=style;
    const values=[];
    for(let i=0;i<20;i++) {
      box.style.width=(100+i)+'px';box.style.color=i%2?'blue':'red';box.style.setProperty('--tone',String(i));
      values.push([style.color,style.display,style.getPropertyValue('--tone')]);
    }
    box.style.display='none';values.push([style.display]);box.style.display='block';
    return {layouts:__layoutCalls()-start,first:values[0],last:values[19],hidden:values[20]};
  })()`);
  assert.deepEqual(styles, { layouts:0,first:["rgba(255, 0, 0, 1)","block","0"],
    last:["rgba(0, 0, 255, 1)","block","19"],hidden:["none"] });
  const padding = await renderer.evaluate(`(() => {
    const box=document.getElementById('box'),child=document.getElementById('child'),start=__layoutCalls();
    box.style.width='310px';box.style.padding='2px 3px 4px 5px';
    const fixed=[savedStyle.padding,savedStyle.paddingTop,savedStyle.getPropertyValue('padding-right'),savedStyle.paddingBottom,savedStyle.paddingLeft];
    box.style.paddingLeft='7px';fixed.push(savedStyle.paddingLeft);
    const before=__layoutCalls()-start;
    const percent=getComputedStyle(child).paddingLeft;
    box.style.padding='0px';
    return {fixed,before,percent,after:__layoutCalls()-start};
  })()`);
  assert.deepEqual(padding, { fixed:["2px 3px 4px 5px","2px","3px","4px","5px","7px"],
    before:0,percent:"15.5px",after:1 });
  const geometry = await renderer.evaluate(`(() => {
    const box=document.getElementById('box'),child=document.getElementById('child'),start=__layoutCalls();
    box.style.width='240px';box.style.height='60px';savedStyle.color;
    const before=__layoutCalls()-start;
    const result=[savedStyle.width,savedStyle.height,savedStyle.getPropertyValue('WIDTH'),getComputedStyle(child).paddingLeft];
    return {before,after:__layoutCalls()-start,result};
  })()`);
  assert.deepEqual(geometry, { before:0,after:1,result:["240px","60px","240px","12px"] });
  // A style-only read cannot hide later structure, stylesheet or viewport changes.
  await renderer.evaluate(`document.getElementById('box').style.width='50%'; savedStyle.color`);
  await renderer.resize(600, 300, 1.75);
  assert.equal(await renderer.evaluate("savedStyle.width"), "300px");
  assert.equal(await renderer.evaluate(`(() => {
    const sheet=document.createElement('style');sheet.textContent='#box{width:180px!important;color:green!important}';document.head.appendChild(sheet);
    return [savedStyle.color,savedStyle.width].join('/');
  })()`), "rgba(0, 128, 0, 1)/180px");
  assert.equal(await renderer.evaluate(`(() => {
    const box=document.getElementById('box');box.style.height='auto';box.replaceChildren();
    const child=document.createElement('div');child.style.height='70px';box.appendChild(child);savedStyle.display;
    return savedStyle.height;
  })()`), "70px");
  assert.deepEqual(await renderer.evaluate(`(() => {
    const node=document.createElement('div'),style=getComputedStyle(node),keys=Object.keys(style);
    node.style.cssText='width:77px;height:19px;color:red';document.body.appendChild(node);
    const connected=[style.width,style.height,style.color];node.remove();node.style.width='88px';
    document.body.appendChild(node);const reconnected=[style.width,style.height,style.color];
    return [connected,reconnected,keys.length===Object.keys(style).length];
  })()`), [["77px","19px","rgba(255, 0, 0, 1)"],["88px","19px","rgba(255, 0, 0, 1)"],true]);
  await renderer.evaluate("document.body.style.backgroundColor='rgb(11,22,33)';savedStyle.color");
  const painted = await renderer.screenshot({format:"rgba"});
  assert.deepEqual([...painted.pixels.slice(-4)], [11,22,33,255]);
  assert.deepEqual(await renderer.evaluate(`(() => {
    const image=document.createElement('img');image.id='delayed';image.src='/delayed.png';document.body.appendChild(image);
    const start=__layoutCalls();window.imageStyle=getComputedStyle(image);
    return [imageStyle.display,__layoutCalls()-start];
  })()`), ["inline",0]);
  releaseImage();
  const deadline = Date.now() + 3000;
  while (!(await renderer.evaluate("document.getElementById('delayed').complete"))) {
    assert.ok(Date.now() < deadline,"delayed image should finish loading");
    await Bun.sleep(5);
  }
  assert.deepEqual(await renderer.evaluate("[imageStyle.width,imageStyle.height]"),["2px","3px"]);
  await renderer.evaluate("document.getElementById('delayed').remove();savedStyle.color");
  assert.deepEqual([...(await renderer.screenshot({format:"rgba"})).pixels.slice(-4)],[11,22,33,255]);
} finally {
  renderer.dispose();
  delete globalThis.__layoutCalls;
  LayoutEngine.prototype.layout = layout;
}
