import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,parseDeclarations,supportsDeclaration} from '../lib/style/computed-style.js';
import {normalizeAlignment} from '../lib/style/alignment-values.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {layoutText} from '../lib/layout/text-layout.js';

function fixture(source) {
  const f=parseHTMLDocument(`<!doctype html><body style="margin:0">${source}</body>`);
  const styles=new StyleEngine(),builder=new RenderTreeBuilder(),sheets=[];let tree,layout;
  const render=()=>{tree=builder.build(f.document,styles.compute(f.document,sheets));layout=layoutText(tree,{x:0,y:0,width:400,viewportHeight:300,measureText:s=>s.length*10});};
  const e=id=>f.document.getElementById(id),box=id=>layout.boxes.find(b=>tree.nodesById.get(b.nodeId)?.domNode===e(id));
  return {...f,e,box,render,styles,sheets,style:id=>styles.get(e(id)),close:()=>f.window.happyDOM.close()};
}
const item='<i id=a style="display:block;width:20px;height:20px;flex:none"></i>';

test('alignment grammar canonicalizes whole productions and rejects invalid writes before the cascade',()=>{
  const f=fixture('<main id=box></main>'),s=f.e('box').style;
  try {
    for(const [name,value,expected] of [
      ['align-items','FIRST/**/BASELINE','baseline'],['justify-items','right LEGACY','legacy right'],
      ['place-content','first baseline','baseline start'],['place-content','last baseline','last baseline start'],
      ['place-items','unsafe center unsafe center','unsafe center'],['place-items','first baseline right legacy','baseline legacy right'],
      ['place-self','safe normal unsafe normal','safe normal unsafe normal'],['place-self','s\\61 fe/**/self-end','safe self-end'],
      ['justify-content','flex-end','flex-end'],['align-self','safe flow-start','safe flow-start']]) {
      s.cssText='';s.setProperty(name,value);expect(s.getPropertyValue(name)).toBe(expected);expect(supportsDeclaration(name,value)).toBeTrue();
    }
    for(const name of ['align-content','justify-content','align-items','justify-items','align-self','justify-self','place-content','place-items','place-self']) {
      for(const value of ['safe','normal unsafe','safe stretch','baseline last','safe baseline','center, end','center end right','"center"','\u00a0center','center\u00a0']) {
        // Two longhands permit center/end, but no alignment permits three values.
        s.cssText='';s.setProperty(name,'center','important');s.setProperty(name,value);
        expect(s.getPropertyValue(name)).toBe('center');expect(s.getPropertyPriority(name)).toBe('important');
        expect(normalizeAlignment(name,value)).toBeNull();expect(supportsDeclaration(name,value)).toBeFalse();
        expect(parseDeclarations(`${name}:center;${name}:${value}`)).toEqual(parseDeclarations(`${name}:center`));
      }
    }
    for(const [name,value] of [['align-items','left'],['align-self','legacy center'],['justify-content','baseline'],['align-content','safe normal'],['place-items','auto'],['place-content','self-start']])expect(supportsDeclaration(name,value)).toBeFalse();
    s.cssText='place-items:center;justify-items:end';expect(s.placeItems).toBe('center end');expect(s.length).toBe(2);
    expect(s.removeProperty('place-items')).toBe('center end');expect(s.length).toBe(0);
  }finally{f.close();}
});

test('pending place values share shorthand priority, source ordering and invalid substitution rules',()=>{
  const f=fixture('<main id=box></main>'),s=f.e('box').style;
  try {
    s.cssText='--p:safe center unsafe end;place-items:var(--p);justify-items:left';
    expect(s.placeItems).toBe('');expect(s.alignItems).toBe('');f.render();expect([f.style('box').alignItems,f.style('box').justifyItems]).toEqual(['safe center','left']);
    s.setProperty('--p','last baseline');f.render();expect([f.style('box').alignItems,f.style('box').justifyItems]).toEqual(['last baseline','left']);
    s.setProperty('--p','safe stretch');f.render();expect([f.style('box').alignItems,f.style('box').justifyItems]).toEqual(['normal','left']);
    s.cssText='place-self:end!important;place-self:center;align-self:start!important';f.render();expect([f.style('box').alignSelf,f.style('box').justifySelf]).toEqual(['start','end']);
    for(const source of ['place-content:baseline;all:initial;justify-content:end','all:initial;place-items:safe center','place-self:initial;align-self:normal','--p:center;place-items:var(--p);place-content:baseline start']) {
      s.cssText=source;f.render();const before=f.style('box');s.cssText=s.cssText;f.render();
      for(const name of ['alignContent','justifyContent','alignItems','justifyItems','alignSelf','justifySelf'])expect(f.style('box')[name]).toBe(before[name]);
    }
    s.cssText='--p:center;place-self:var(--p)';expect(s.placeSelf).toBe('var(--p)');s.removeProperty('place-self');expect(s.alignSelf).toBe('');expect(s.justifySelf).toBe('');
    for(const part of ['content','items','self']) {
      s.cssText=`--pair:start end;align-${part}:var(--pair);justify-${part}:var(--pair)`;
      expect(s.getPropertyValue(`place-${part}`)).toBe('');
      const field=part[0].toUpperCase()+part.slice(1),initial=part==='self'?'auto':'normal';
      f.render();expect([f.style('box')['align'+field],f.style('box')['justify'+field]]).toEqual([initial,initial]);
      s.cssText=s.cssText;f.render();expect([f.style('box')['align'+field],f.style('box')['justify'+field]]).toEqual([initial,initial]);
    }
  }finally{f.close();}
});

test('justify-items legacy follows its parent and computed aliases retain specified spelling',()=>{
  const f=fixture('<main id=p style="justify-items:legacy right"><div id=box style="place-items:flex-end legacy"></div></main>');
  try {
    f.render();expect([f.style('box').alignItems,f.style('box').justifyItems]).toEqual(['flow-end','legacy right']);expect(f.e('box').style.placeItems).toBe('flex-end legacy');
    f.e('p').style.justifyItems='legacy center';f.styles.compute(f.document,f.sheets,{},new Set(),new Set([f.e('p')]));expect(f.style('box').justifyItems).toBe('legacy center');
    f.e('p').style.justifyItems='flex-start';f.render();expect(f.style('box').justifyItems).toBe('normal');
    f.e('box').style.cssText='';f.e('p').style.justifyItems='legacy left';f.render();expect(f.style('box').justifyItems).toBe('legacy left');
    f.e('box').style.justifyItems='normal';f.render();expect(f.style('box').justifyItems).toBe('normal');
    const before=f.style('box');f.e('p').style.width='120px';f.styles.compute(f.document,f.sheets,{},new Set(),new Set([f.e('p')]));expect(f.styles.restyled).toBe(1);expect(f.style('box')).toBe(before);
  }finally{f.close();}
});

test('flex main alignment distinguishes logical edges, flow edges, physical edges and overflow',()=>{
  for(const direction of ['row','row-reverse','column','column-reverse']) {
    const column=direction.startsWith('column'),reverse=direction.endsWith('reverse'),axis=column?'y':'x',free=column?60:80;
    const f=fixture(`<main id=box style="display:flex;flex-direction:${direction};width:100px;height:80px">${item}</main>`);
    try {
      for(const [value,expected] of [['start',0],['end',free],['flex-start',reverse?free:0],['flex-end',reverse?0:free],['center',free/2],['safe center',free/2],['unsafe end',free]]) {
        f.e('box').style.justifyContent=value;f.render();expect(f.box('a')[axis]).toBe(expected);
      }
      f.e('a').style.width='140px';f.e('a').style.height='120px';
      for(const [value,expected] of [['unsafe center',-20],['unsafe end',-40],['safe center',reverse?-40:0],['space-around',reverse?-40:0],['space-evenly',reverse?-40:0],['space-between',reverse?-40:0]]) {
        // CSS Align 3's safe fallback is flow-start, including reverse flows.
        f.e('box').style.justifyContent=value;f.render();expect(f.box('a')[axis]).toBe(expected);
      }
    }finally{f.close();}
  }
  for(const direction of ['row','row-reverse']) {
    const f=fixture(`<main id=box style="display:flex;direction:rtl;flex-direction:${direction};width:100px;height:80px">${item}</main>`);
    try {
      for(const [value,expected] of [['start',80],['end',0],['left',0],['right',80],['flow-start',direction==='row'?80:0],['flow-end',direction==='row'?0:80]]) {f.e('box').style.justifyContent=value;f.render();expect(f.box('a').x).toBe(expected);}
    }finally{f.close();}
  }
});

test('explicit normal self alignment stretches independently of the container default',()=>{
  for(const display of ['flex','flex;flex-direction:column','grid']) {
    const column=display.includes('column'),grid=display==='grid';
    const f=fixture(`<main style="display:${display};width:100px;height:80px;place-items:end"><i id=a style="display:block;place-self:normal"><b style="display:block;width:20px;height:20px"></b></i></main>`);
    try {
      f.render();expect(f.box('a')[column||grid?'width':'height']).toBe(column||grid?100:80);expect(f.box('a').x).toBe(0);expect(f.box('a').y).toBe(0);
      f.e('a').style.placeSelf='auto';f.render();expect(f.box('a')[column||grid?'width':'height']).toBe(20);expect(f.box('a')[column||grid?'x':'y']).toBe(column||grid?80:60);
    }finally{f.close();}
  }
});

test('grid content and item alignment preserve unsafe overflow and auto margins override positions',()=>{
  for(const property of ['place-content','place-items']) {
    const tracks=property==='place-content'?'140px':'100px',rows=property==='place-content'?'120px':'80px';
    const f=fixture(`<main id=box style="display:grid;width:100px;height:80px;grid-template-columns:${tracks};grid-template-rows:${rows}"><i id=a style="display:block;width:140px;height:120px"></i></main>`);
    try {
      for(const [value,expected] of [['safe center',[0,0]],['unsafe center',[-20,-20]],['unsafe end',[-40,-40]],['flow-end',[-40,-40]]]) {f.e('box').style.setProperty(property,value);f.render();expect([f.box('a').x,f.box('a').y]).toEqual(expected);}
      if(property==='place-items') {
        f.e('a').style.margin='auto';f.render();expect([f.box('a').x,f.box('a').y]).toEqual([0,0]);
        f.e('a').style.width='20px';f.e('a').style.height='20px';f.render();expect([f.box('a').x,f.box('a').y]).toEqual([40,30]);
      }
    }finally{f.close();}
  }
  for(const display of ['grid;grid-template-columns:100px;grid-template-rows:80px','flex;flex-direction:column']) {
    const f=fixture(`<main style="display:${display};width:100px;height:80px"><i id=a style="display:block;margin-left:auto;margin-right:auto;height:20px">XX</i></main>`);
    try {f.render();expect([f.box('a').x,f.box('a').width]).toEqual([40,20]);}finally{f.close();}
  }
  const f=fixture(`<main id=box style="display:grid;direction:rtl;width:100px;height:80px">${item}</main>`);
  try {
    f.e('a').style.direction='ltr';
    for(const [value,expected] of [['start',80],['end',0],['self-start',0],['self-end',80],['left',0],['right',80],['legacy right',80],['baseline',0],['last baseline',80]]) {
      f.e('box').style.justifyItems=value;f.render();expect(f.box('a').x).toBe(expected);
    }
  }finally{f.close();}
});

test('renderer updates alignment from adopted CSSOM rules, pending substitutions and parent legacy',async()=>{
  const {RendererHost}=await import('../lib/renderer/host.js'),host=new RendererHost({timeout:20000});
  try {
    await host.start();await host.call('resize',200,150,1);
    await host.call('loadDocument',{url:'https://alignment.test/',contentType:'text/html',source:'<!doctype html><style>body{margin:0}main{display:grid;width:100px;height:80px}i{display:block;width:20px;height:20px}</style><main id=box><i id=a></i></main>'});await host.call('whenLoaded');
    const run=code=>host.call('evaluate',code);
    expect(await run(`(()=>{const sheet=new CSSStyleSheet();sheet.replaceSync('main{--p:safe center unsafe end;place-items:var(--p)}');document.adoptedStyleSheets=[sheet];const a=document.getElementById('a').getBoundingClientRect(),s=getComputedStyle(document.getElementById('box'));return [s.placeItems,s.alignItems,s.justifyItems,a.x,a.y]})()`)).toEqual(['safe center unsafe end','safe center','unsafe end',80,30]);
    expect(await run(`(()=>{const s=document.adoptedStyleSheets[0].cssRules[0].style;s.justifyItems='left';s.setProperty('--p','unsafe end safe center');const a=document.getElementById('a').getBoundingClientRect();return [s.placeItems,getComputedStyle(document.getElementById('box')).placeItems,a.x,a.y]})()`)).toEqual(['','unsafe end left',0,60]);
    expect(await run(`(()=>{document.getElementById('box').style.placeItems='flex-end';const s=getComputedStyle(document.getElementById('box')),a=document.getElementById('a').getBoundingClientRect();return [s.placeItems,a.x,a.y]})()`)).toEqual(['flow-end',80,60]);
    expect(await run(`(()=>{document.getElementById('box').style.justifyItems='legacy right';return getComputedStyle(document.getElementById('a')).justifyItems})()`)).toBe('legacy right');
    expect(await run(`(()=>{document.getElementById('box').style.justifyItems='center';return getComputedStyle(document.getElementById('a')).justifyItems})()`)).toBe('normal');
  }finally{await host.close();}
},30000);
