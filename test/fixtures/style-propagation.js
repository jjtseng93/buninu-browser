import '../../vendor/ses/dist/ses.mjs';
import assert from 'node:assert/strict';
import {parseHTMLDocument} from '../../lib/happy-dom/parser.js';
import {StyleEngine} from '../../lib/style/computed-style.js';
const {document,window}=parseHTMLDocument('<div id="parent" style="--accent:blue">'+Array.from({length:600},(_,i)=>`<span class="c${i%30}">child ${i}</span>`).join('')+'</div>');
const sheets=[Array.from({length:30},(_,i)=>`.c${i}{font-size:${14+i%5}px;line-height:1.2;margin:2px;color:var(--accent)}`).join('\n')];
const parent=document.getElementById('parent'),children=[...parent.children],engine=new StyleEngine().compute(document,sheets);
lockdown({errorTaming:'safe',overrideTaming:'severe',consoleTaming:'unsafe',localeTaming:'unsafe',stackFiltering:'concise',reporting:'none'});
try {
  const retained=children.map(child=>engine.get(child));
  for(const [property,value]of [['width','200px'],['padding','4px'],['opacity','.5']]){
    parent.style[property]=value;
    engine.compute(document,sheets,{},new Set(),new Set([parent]));
    assert.equal(engine.restyled,1);
    const full=new StyleEngine().compute(document,sheets);
    for(const [index,child]of children.entries()){
      assert.equal(engine.get(child),retained[index]);
      assert.deepEqual(engine.get(child),full.get(child));
    }
  }
  parent.style.setProperty('--accent','red');
  engine.compute(document,sheets,{},new Set(),new Set([parent]));
  assert.equal(engine.restyled,601);
  const full=new StyleEngine().compute(document,sheets);
  for(const child of children){assert.equal(engine.get(child).color,'rgba(255, 0, 0, 1)');assert.deepEqual(engine.get(child),full.get(child));}
}finally{window.happyDOM.abort();}
