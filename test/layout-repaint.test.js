import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {LayoutEngine} from '../lib/layout/text-layout.js';
import {buildDisplayList} from '../lib/paint/display-list.js';
import {repaintLayout} from '../lib/layout/repaint.js';

function fixture(source='<body><div id="a" style="width:100px;height:30px;transform:scaleX(0.3);background-image:linear-gradient(red, blue);background-size:20px 20px">hello <span>world</span></div><p>after</p></body>') {
  const parsed=parseHTMLDocument(source);
  const builder=new RenderTreeBuilder(),engine=new LayoutEngine();
  const first=builder.build(parsed.document,new StyleEngine().compute(parsed.document));
  const options={width:300,viewportHeight:200};
  const layout=engine.layout(first,options);
  return {...parsed,builder,engine,first,layout,options,element:parsed.document.getElementById('a')};
}
for (const [name,value] of [['transform','scaleX(0.8)'],['backgroundSize','40px 15px'],['transformOrigin','left top']]) {
  test(`retained ${name} paint matches a complete layout, leaving prior geometry immutable`,()=>{
    const f=fixture();
    try {
      const before=JSON.stringify(f.layout);
      f.element.style[name]=value;
      const next=f.builder.build(f.document,new StyleEngine().compute(f.document)),retained=repaintLayout(f.layout,f.first,next);
      expect(retained).not.toBeNull();
      expect(buildDisplayList(retained,next)).toEqual(buildDisplayList(f.engine.layout(next,f.options),next));
      expect(JSON.stringify(f.layout)).toBe(before);
      const unchanged=f.layout.fragments.findIndex(fragment=>fragment.runs.some(run=>run.text==='after'));
      expect(unchanged).toBeGreaterThanOrEqual(0);
      expect(retained.fragments[unchanged]).toBe(f.layout.fragments[unchanged]);
      expect(retained.fragments[unchanged].runs).toBe(f.layout.fragments[unchanged].runs);
    } finally {f.window.happyDOM.abort();}
  });
}
for (const [name,value] of [['transform','translateX(10px) scaleX(0.8)'],['transform','none'],['width','120px'],['color','red'],['display','none']]) {
  test(`changing ${name} outside the paint-only subset retains full layout`,()=>{
    const f=fixture();try {f.element.style[name]=value;expect(repaintLayout(f.layout,f.first,f.builder.build(f.document,new StyleEngine().compute(f.document)))).toBeNull();}
    finally{f.window.happyDOM.abort();}
  });
}
test('text changes cannot reuse old line breaking',()=>{
  const f=fixture();try{f.element.firstChild.data='a much longer paragraph';expect(repaintLayout(f.layout,f.first,f.builder.build(f.document,new StyleEngine().compute(f.document)))).toBeNull();}
  finally{f.window.happyDOM.abort();}
});
test('a changed run only replaces its own immutable fragment and preserves sibling runs',()=>{
  const f=fixture('<body><div style="width:280px">before <span id="a" style="background-size:20px 20px">target</span> after</div><p>outside</p></body>');
  try {
    const before=JSON.stringify(f.layout);
    const index=f.layout.fragments.findIndex(fragment=>fragment.runs.some(run=>run.text==='target'));
    const original=f.layout.fragments[index];
    expect(original.runs.length).toBeGreaterThan(1);
    f.element.style.backgroundSize='40px 15px';
    const next=f.builder.build(f.document,new StyleEngine().compute(f.document)),retained=repaintLayout(f.layout,f.first,next);
    expect(retained).not.toBeNull();
    const updated=retained.fragments[index];
    expect(updated).not.toBe(original);
    expect(updated.runs).not.toBe(original.runs);
    for(let runIndex=0;runIndex<original.runs.length;runIndex++) {
      const run=original.runs[runIndex],replacement=updated.runs[runIndex];
      if(run.text==='target') {
        expect(replacement).not.toBe(run);
        expect(Object.isFrozen(replacement)).toBe(true);
        expect(Object.isFrozen(replacement.style)).toBe(true);
      } else expect(replacement).toBe(run);
    }
    expect(Object.isFrozen(updated)).toBe(true);
    expect(Object.isFrozen(updated.runs)).toBe(true);
    expect(Object.isFrozen(retained.fragments)).toBe(true);
    expect(buildDisplayList(retained,next)).toEqual(buildDisplayList(f.engine.layout(next,f.options),next));
    expect(JSON.stringify(f.layout)).toBe(before);
  } finally {f.window.happyDOM.abort();}
});
test('box-only and no-op paint updates keep unchanged fragment and record arrays',()=>{
  const f=fixture('<body><div id="a" style="width:100px;height:30px;background-size:20px 20px"></div><p>after</p></body>');
  try {
    const before=JSON.stringify(f.layout);
    f.element.style.backgroundSize='40px 15px';
    const next=f.builder.build(f.document,new StyleEngine().compute(f.document)),retained=repaintLayout(f.layout,f.first,next);
    expect(retained).not.toBeNull();
    expect(retained.boxes).not.toBe(f.layout.boxes);
    expect(Object.isFrozen(retained.boxes)).toBe(true);
    expect(retained.fragments).toBe(f.layout.fragments);
    expect(buildDisplayList(retained,next)).toEqual(buildDisplayList(f.engine.layout(next,f.options),next));
    expect(JSON.stringify(f.layout)).toBe(before);
    const unchanged=f.builder.build(f.document,new StyleEngine().compute(f.document));
    const again=repaintLayout(retained,next,unchanged);
    expect(again.boxes).toBe(retained.boxes);
    expect(again.fragments).toBe(retained.fragments);
    expect(again.generation).toBe(unchanged.generation);
  } finally {f.window.happyDOM.abort();}
});
