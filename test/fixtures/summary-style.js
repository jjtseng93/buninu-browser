import { strict as assert } from "node:assert";
import { createPageRenderer } from "../../lib/renderer/page-renderer.js";

const renderer = await createPageRenderer({});
try {
  renderer.setScripting("host");
  await renderer.loadDocument({url:"https://page.test/",contentType:"text/html",status:200,
    source:'<!doctype html><details><summary id="first">First</summary><summary id="second">Second</summary></details>'});
  await renderer.whenLoaded();
  const read = () => ["#first","#second"].map(selector => {
    const style = renderer.inspect(selector,["display","listStyleType"])[0]?.style;
    return style && [style.display,style.listStyleType];
  });
  const mutate = async source => {
    await renderer.evaluate(`${source}; document.body.offsetHeight`);
  };
  const closed = [["list-item","disclosure-closed"],["block","disc"]];
  assert.deepEqual(read(),closed);
  await mutate("document.querySelector('details').open=true");
  assert.deepEqual(read(),[["list-item","disclosure-open"],["block","disc"]]);
  await mutate("document.querySelector('details').open=false");
  assert.equal(await renderer.evaluate("document.querySelector('details').open"),false);
  assert.deepEqual(read(),closed);
  await mutate("document.querySelector('details').insertBefore(document.getElementById('second'),document.getElementById('first'))");
  assert.deepEqual(read(),[["block","disc"],["list-item","disclosure-closed"]]);
  await mutate("document.getElementById('second').remove()");
  assert.deepEqual(read()[0],["list-item","disclosure-closed"]);
} finally { renderer.dispose(); }
