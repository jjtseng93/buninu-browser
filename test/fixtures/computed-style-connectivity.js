import assert from "node:assert/strict";
import { LayoutEngine } from "../../lib/layout/text-layout.js";
import { createPageRenderer } from "../../lib/renderer/page-renderer.js";

const mode = process.argv[2] ?? "ses";
let layouts = 0;
const layout = LayoutEngine.prototype.layout;
LayoutEngine.prototype.layout = function (...args) {
  layouts++;
  return layout.apply(this, args);
};
const errors = [];
const renderer = await createPageRenderer({ reportError: error => errors.push(String(error)) });
if (mode === "ses") {
  await import("../../vendor/ses/dist/ses.mjs");
  lockdown({ errorTaming: "safe", overrideTaming: "severe", consoleTaming: "unsafe",
    localeTaming: "unsafe", stackFiltering: "concise", reporting: "none" });
}
try {
  renderer.setScripting(mode);
  await renderer.loadDocument({ url: "https://styles.test/", contentType: "text/html",
    source: "<!doctype html><style>#accessor{-webkit-line-clamp:2}</style><body></body>" });
  await renderer.whenLoaded();

  // This must be the first CSSOM declaration in a fresh process: accessors
  // cannot depend on a connected declaration having initialized their schema.
  const detached = await renderer.evaluate(`(() => {
    window.node=document.createElement('div');node.id='accessor';
    node.style.cssText='width:77px;height:19px;color:rgb(12,34,56);--tone:first';
    window.savedStyle=getComputedStyle(node);
    window.readStyle=s=>[s.color,s.width,s.getPropertyValue('--tone'),s.length===0,s.item(0)===''];
    window.savedKeys=Object.keys(savedStyle);
    return {values:readStyle(savedStyle),accessors:['color','width','WebkitLineClamp','webkitLineClamp'].every(key=>key in savedStyle),
      aliases:[savedStyle.WebkitLineClamp,savedStyle.webkitLineClamp],absent:savedStyle.getPropertyValue('unknown-property')};
  })()`);
  assert.deepEqual(detached, { values: ["", "", "", true, true], accessors: true,
    aliases: ["", ""], absent: "" });

  const connected = await renderer.evaluate(`(() => {
    document.body.appendChild(node);
    window.normalNames=Array.from({length:savedStyle.length},(_,i)=>savedStyle.item(i));
    return {values:readStyle(savedStyle),names:normalNames.includes('color')&&normalNames.includes('width'),
      aliases:[savedStyle.WebkitLineClamp,savedStyle.webkitLineClamp],keysStable:savedKeys.join('|')===Object.keys(savedStyle).join('|')};
  })()`);
  assert.deepEqual(connected, { values: ["rgba(12, 34, 56, 1)", "77px", "first", false, false],
    names: true, aliases: ["2", "2"], keysStable: true });

  const changes = await renderer.evaluate(`(() => {
    node.style.setProperty('--tone','second');node.style.setProperty('--later','new');
    const customChanged=readStyle(savedStyle);
    const fixedNames=normalNames.join('|')===Array.from({length:savedStyle.length},(_,i)=>savedStyle.item(i)).join('|');
    node.remove();const removed=readStyle(savedStyle),fresh=readStyle(getComputedStyle(node));
    node.style.width='88px';node.style.color='rgb(78,90,12)';
    const changedDetached=readStyle(savedStyle);
    document.body.appendChild(node);const reattached=readStyle(savedStyle);
    return {customChanged,fixedNames,removed,fresh,changedDetached,reattached,
      keysStable:savedKeys.join('|')===Object.keys(savedStyle).join('|')};
  })()`);
  assert.deepEqual(changes, {
    customChanged: ["rgba(12, 34, 56, 1)", "77px", "second", false, false], fixedNames: true,
    removed: ["", "", "", true, true], fresh: ["", "", "", true, true],
    changedDetached: ["", "", "", true, true],
    reattached: ["rgba(78, 90, 12, 1)", "88px", "second", false, false], keysStable: true,
  });

  const hidden = await renderer.evaluate(`(() => {
    const parent=document.createElement('div');parent.style.cssText='display:none;color:rgb(99,88,77);--tone:inherited';
    const child=document.createElement('div');child.style.width='3em';parent.appendChild(child);document.body.appendChild(parent);
    const style=getComputedStyle(child),connected=readStyle(style);
    parent.remove();const detached=readStyle(style);document.body.appendChild(parent);
    return {connected,detached,reattached:readStyle(style)};
  })()`);
  assert.deepEqual(hidden, {
    connected: ["rgba(99, 88, 77, 1)", "48px", "inherited", false, false],
    detached: ["", "", "", true, true],
    reattached: ["rgba(99, 88, 77, 1)", "48px", "inherited", false, false],
  });

  // A descendant never queried while connected must also avoid stale style
  // retained by an earlier normal style pass after its ancestor is removed.
  await renderer.evaluate(`document.body.insertAdjacentHTML('beforeend',
    '<style>#hidden{display:none;color:red;--tone:old}#hidden .child{width:3em;background:green}</style>'+
    '<div id="hidden"><span class="child" id="child">Hidden</span></div><div id="visible"></div>')`);
  await renderer.screenshot({ format: "rgba" });
  assert.deepEqual(await renderer.evaluate(`(() => {
    const child=document.getElementById('child');child.remove();
    document.getElementById('visible').style.width='19px';const style=getComputedStyle(child);
    return [style.color,style.width,style.backgroundColor,style.getPropertyValue('--tone'),style.length,style.item(0)];
  })()`), ["", "", "", "", 0, ""]);

  await renderer.evaluate(`window.detached=document.createElement('div');window.ds=getComputedStyle(detached);
    document.body.style.padding='7px'`);
  const before = layouts;
  assert.deepEqual(await renderer.evaluate(`[ds.color,ds.width,ds.length,ds.item(0),ds.getPropertyValue('--tone')]`),
    ["", "", 0, "", ""]);
  assert.equal(layouts, before, "detached reads must not flush unrelated layout");
  assert.deepEqual(errors, []);
} finally {
  renderer.dispose();
  LayoutEngine.prototype.layout = layout;
}
