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
for (const [name,value] of [['transform','scaleX(0.8)'],['backgroundSize','40px 15px'],['transformOrigin','left top'],['opacity','0.4'],['backgroundColor','blue']]) {
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

function expectEquivalent(f, next, retained) {
  expect(retained).not.toBeNull();
  const full = new LayoutEngine().layout(next, f.options);
  // Fragment IDs retain the generation in which their geometry was created.
  const comparable = layout => ({ ...layout, fragments: layout.fragments.map(({ id, ...fragment }) => fragment) });
  expect(comparable(retained)).toEqual(comparable(full));
  const painted = buildDisplayList(retained, next), reference = buildDisplayList(full, next);
  expect(painted).toEqual(reference);
  // Hit testing, text selection, and scroll extents are non-enumerable.
  expect(painted.hits).toEqual(reference.hits);
  expect(painted.scrollers).toEqual(reference.scrollers);
  expect(painted.extent).toEqual(reference.extent);
  return painted;
}

test('ancestor opacity updates nested positioned content and survives zero opacity', () => {
  const f = fixture(`<body><div id="a" style="position:relative;z-index:2;width:100px;height:70px;background:red">
    text <span style="opacity:.5;background:yellow">faint</span>
    <span style="position:absolute;z-index:-1;left:2px;top:4px;background:blue">behind</span>
    <span style="position:absolute;z-index:3;left:8px;top:15px;background:green">above</span>
    </div><div style="position:relative;z-index:1">outside</div></body>`);
  try {
    let previous = f.first, layout = f.layout;
    for (const opacity of ['0.5', '0', '1']) {
      f.element.style.opacity = opacity;
      const next = f.builder.build(f.document, new StyleEngine().compute(f.document));
      const retained = repaintLayout(layout, previous, next);
      const list = expectEquivalent(f, next, retained);
      const faint = list.items.find(item => item.text === 'faint');
      if (opacity === '0') expect(faint).toBeUndefined();
      else expect(faint.opacity).toBe(Number(opacity) * 0.5);
      for (let index = 0; index < retained.boxes.length; index++) {
        expect(retained.boxes[index].layer).toBe(layout.boxes[index].layer);
      }
      previous = next;
      layout = retained;
    }
  } finally { f.window.happyDOM.abort(); }
});

for (const [description, content] of [
  ['wrapped inline', '<div style="width:90px">before <span id="a" style="background:red">several wrapped words</span> after</div>'],
  ['bordered inline', '<div><span id="a" style="border:1px solid currentColor">text</span></div>'],
  ['bordered image', '<div><img id="a" width="30" height="20" style="border:1px solid currentColor"></div>'],
  ['table cell with resolved padding', '<table style="width:140px"><tr><td id="a" style="padding:10%;background:red">cell</td><td>other</td></tr></table>'],
  ['block with anonymous lines', '<div id="a" style="padding:5%">before<p>middle</p>after</div>'],
]) {
  test(`background color retains ${description} geometry and paint`, () => {
    const f = fixture(`<body>${content}</body>`);
    try {
      f.element.style.backgroundColor = 'blue';
      const next = f.builder.build(f.document, new StyleEngine().compute(f.document));
      expectEquivalent(f, next, repaintLayout(f.layout, f.first, next));
    } finally { f.window.happyDOM.abort(); }
  });
}

for (const [description, content, color] of [
  ['new inline background', '<span id="a">text</span>', 'red'],
  ['removed inline background', '<span id="a" style="background:red">text</span>', 'transparent'],
  ['new image background', '<img id="a" width="30" height="20">', 'red'],
  ['removed image background', '<img id="a" width="30" height="20" style="background:red">', 'transparent'],
]) {
  test(`${description} regenerates inline decoration boxes`, () => {
    const f = fixture(`<body><div>${content}</div></body>`);
    try {
      f.element.style.backgroundColor = color;
      const next = f.builder.build(f.document, new StyleEngine().compute(f.document));
      expect(repaintLayout(f.layout, f.first, next)).toBeNull();
    } finally { f.window.happyDOM.abort(); }
  });
}

test('retained styles preserve gradient text identity across repeated paint changes', () => {
  const f = fixture('<body><div id="a" style="width:100px;background-image:linear-gradient(red,blue);background-clip:text">gradient text</div></body>');
  try {
    let previous = f.first, layout = f.layout;
    for (const [property, value] of [['opacity', '.5'], ['background-size', '40px 20px'], ['background-color', 'green']]) {
      f.element.setAttribute('style', `${f.element.getAttribute('style')};${property}:${value}`);
      const next = f.builder.build(f.document, new StyleEngine().compute(f.document));
      const retained = repaintLayout(layout, previous, next);
      const list = expectEquivalent(f, next, retained);
      expect(list.items.filter(item => item.op === 'drawText').every(item => item.gradient)).toBe(true);
      previous = next;
      layout = retained;
    }
  } finally { f.window.happyDOM.abort(); }
});

test('color changes with inherited currentColor borders, decorations and SVG keep full layout', () => {
  const f = fixture(`<body><div id="a" style="color:red;text-decoration:underline">
    <span style="border:1px solid currentColor">text</span>
    <svg width="20" height="20"><rect width="20" height="20" fill="currentColor"/></svg>
    </div></body>`);
  try {
    f.element.style.color = 'blue';
    const next = f.builder.build(f.document, new StyleEngine().compute(f.document));
    expect(repaintLayout(f.layout, f.first, next)).toBeNull();
  } finally { f.window.happyDOM.abort(); }
});

for (const otherOpacity of [null, '0.7', '0.3']) {
  test(`a shared old style cannot leak into an alias with opacity ${otherOpacity ?? 'unchanged'}`, () => {
    const f = fixture('<body><div id="a" style="width:100px">first</div><div id="b" style="width:100px">second</div></body>');
    try {
      const a = [...f.first.nodesById.values()].find(node => node.domNode === f.element);
      const other = f.document.getElementById('b');
      const b = [...f.first.nodesById.values()].find(node => node.domNode === other);
      expect(a.style).toEqual(b.style);
      // Render trees may share immutable styles. Give both elements and their
      // text nodes that same style, then split it in the next generation.
      const nodesById = new Map();
      const share = node => {
        const shared = Object.freeze({ ...node,
          style: node.style === b.style ? a.style : node.style,
          children: Object.freeze(node.children.map(share)),
        });
        nodesById.set(shared.id, shared);
        return shared;
      };
      const previous = { ...f.first, root: share(f.first.root), nodesById };
      const layout = new LayoutEngine().layout(previous, f.options);
      f.element.style.opacity = '0.3';
      if (otherOpacity != null) other.style.opacity = otherOpacity;
      const next = f.builder.build(f.document, new StyleEngine().compute(f.document));
      const retained = repaintLayout(layout, previous, next);
      if (otherOpacity === '0.3') expectEquivalent(f, next, retained);
      else expect(retained).toBeNull();
    } finally { f.window.happyDOM.abort(); }
  });
}
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
