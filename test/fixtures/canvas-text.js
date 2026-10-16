import { strict as assert } from "node:assert";
import { createPageRenderer } from "../../lib/renderer/page-renderer.js";
const renderer = await createPageRenderer({});
try {
  renderer.resize(500, 200, 1);
  renderer.setScripting("host");
  await renderer.loadDocument({ url: "https://text.test/", contentType: "text/html",
    source: `<body style="margin:0"><canvas width=500 height=200 id=c></canvas><script>
      window.c=document.getElementById('c');window.ctx=c.getContext('2d');
      window.ink=()=>{const data=ctx.getImageData(0,0,500,200).data;let left=500,right=-1,top=200,bottom=-1;
        for(let y=0;y<200;y++)for(let x=0;x<500;x++)if(data[(y*500+x)*4+3]){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y)}
        return {left,right,top,bottom};};
    </script>` });
  await renderer.whenLoaded();
  assert.equal(await renderer.evaluate("ctx.font"), "10px sans-serif");
  await renderer.evaluate("ctx.font='32px sans-serif';window.width=ctx.measureText('Canvas text').width;ctx.fillText('Canvas text',10,50)");
  assert.ok(await renderer.evaluate("width > 150 && width < 190"));
  const left = await renderer.evaluate("ink()");
  assert.ok(left.left >= 10 && left.right > 160 && left.bottom <= 51);
  await renderer.evaluate("ctx.clearRect(0,0,500,200);ctx.textAlign='right';ctx.fillText('Canvas text',300,50)");
  const right = await renderer.evaluate("ink()");
  assert.ok(right.right >= 295 && right.right <= 300);
  assert.ok(right.left > 125 && right.left < 150);
  await renderer.evaluate("ctx.clearRect(0,0,500,200);ctx.textAlign='left';ctx.fillText('Canvas text',10,50,80)");
  const scaled = await renderer.evaluate("ink()");
  assert.ok(scaled.right <= 90 && scaled.right >= 85);
  await renderer.evaluate("ctx.save();ctx.font='48px serif';ctx.textAlign='center';ctx.textBaseline='top';ctx.direction='rtl';ctx.restore()");
  assert.deepEqual(await renderer.evaluate("[ctx.font,ctx.textAlign,ctx.textBaseline,ctx.direction]"), ["32px sans-serif", "left", "alphabetic", "inherit"]);
  await renderer.evaluate("ctx.font='not a font';ctx.textAlign='invalid'");
  assert.deepEqual(await renderer.evaluate("[ctx.font,ctx.textAlign]"), ["32px sans-serif", "left"]);
  await renderer.evaluate("ctx.translate(12,18);ctx.scale(2,3)");
  assert.deepEqual(await renderer.evaluate("const m=ctx.getTransform();[m.a,m.b,m.c,m.d,m.e,m.f]"), [2,0,0,3,12,18]);
  await renderer.evaluate("c.width=500");
  assert.deepEqual(await renderer.evaluate("[ctx.font,ctx.textAlign,ctx.textBaseline,ctx.direction]"), ["10px sans-serif", "start", "alphabetic", "inherit"]);
  await renderer.evaluate("ctx.font='32px sans-serif';ctx.fillText('測試 🙂',10,50)");
  assert.ok((await renderer.evaluate("ink()")).right > 60, "Unicode text uses browser fallback fonts");
  await renderer.evaluate(`ctx.clearRect(0,0,500,200);window.gradient=ctx.createLinearGradient(0,0,150,0);
    gradient.addColorStop(0,'red');gradient.addColorStop(1,'blue');ctx.strokeStyle=gradient;ctx.lineWidth=2;
    ctx.strokeText('Gradient',10,50)`);
  assert.ok((await renderer.evaluate("ink()")).right > 100, "shaped strokeText accepts a branded gradient without reading the native color-only getter");
  assert.equal(await renderer.evaluate("ctx.strokeStyle===gradient && gradient.Td===undefined && gradient.pe===undefined"), true);
} finally { renderer.dispose(); }
