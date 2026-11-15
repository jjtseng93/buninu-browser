import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {layoutText} from '../lib/layout/text-layout.js';
import {buildDisplayList} from '../lib/paint/display-list.js';
function page(css,tag='div') {
 const {window,document}=parseHTMLDocument(`<!doctype html><body><${tag} id="box" style="width:100px;height:40px;color:red;${css}">text</${tag}></body>`);
 const tree=new RenderTreeBuilder().build(document,new StyleEngine().compute(document));
 const layout=layoutText(tree,{width:400});const id=[...tree.nodesById.values()].find(n=>n.domNode?.id==='box').id;
 const box=layout.boxes.find(b=>b.nodeId===id);const list=buildDisplayList(layout,tree);window.happyDOM.close();return {box,list};
}
test('outline defaults to currentColor, extends outside geometry and paints after text',()=>{
 const {box,list}=page('outline:2px solid;outline-offset:3px');
 const item=list.items.at(-1);expect(item.op).toBe('border');
 expect(item.colors).toEqual(Array(4).fill('rgba(255, 0, 0, 1)'));
 expect(item.rect).toEqual({x:box.x-5,y:box.y-5,width:box.width+10,height:box.height+10});
 expect(page('outline:none').list.items.some(i=>i.op==='border')).toBe(false);
 expect(page('outline:2px solid;opacity:0').list.items).toHaveLength(0);
});
test('outline decorates otherwise undecorated inline text and does not change layout',()=>{
 const plain=page('','span'),outlined=page('outline:1px solid blue','span');
 expect(outlined.list.items.some(i=>i.op==='border')).toBe(true);
 expect(outlined.list.items.find(i=>i.op==='drawText').bounds).toEqual(plain.list.items.find(i=>i.op==='drawText').bounds);
});
