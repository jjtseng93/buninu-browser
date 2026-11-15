import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {LayoutEngine} from '../lib/layout/text-layout.js';
function page(markup){
 const parsed=parseHTMLDocument(`<!doctype html><body style="margin:0">${markup}</body>`);
 const styles=new StyleEngine(),builder=new RenderTreeBuilder(),engine=new LayoutEngine();
 const layout=width=>{const tree=builder.build(parsed.document,styles.compute(parsed.document));return {tree,layout:engine.layout(tree,{width,viewportHeight:600,x:0,y:0})};};
 return {...parsed,layout};
}
test('inline-block child borders keep their padding offset and width across relayouts',()=>{
 const p=page('<span id="outer" style="display:inline-block;width:200px;border:2px solid;padding:10px;margin:20px"><div id="child" style="border:1px solid;height:30px">abc</div></span>');
 try {for(const width of [400,720,400]){
  const {tree,layout}=p.layout(width);const box=id=>layout.boxes.find(b=>tree.nodesById.get(b.nodeId)?.domNode?.id===id);
  // Also checked against Chromium Headless Shell on the same markup.
  expect(box('outer')).toMatchObject({x:20,y:20,width:224,height:56});
  expect(box('child')).toMatchObject({x:32,y:32,width:200,height:32});
 }}finally{p.window.happyDOM.close();}
});
test('opacity does not add or remove MathML layout space',()=>{
 const p=page('<p><span id="copy"><math><mfrac><mi>x</mi><mn>2</mn></mfrac></math></span> after</p><p id="next">end</p>');
 try {
  const next=()=>{const {tree,layout}=p.layout(400);const b=layout.boxes.find(b=>tree.nodesById.get(b.nodeId)?.domNode?.id==='next');return [b.x,b.y,b.width,b.height]};
  const visible=next();p.document.getElementById('copy').setAttribute('style','opacity:0');expect(next()).toEqual(visible);
  p.document.getElementById('copy').removeAttribute('style');expect(next()).toEqual(visible);
 }finally{p.window.happyDOM.close();}
});
