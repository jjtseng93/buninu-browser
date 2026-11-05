import {test,expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine,parseDeclarations,supportsDeclaration,resolveVariables} from '../lib/style/computed-style.js';
import {normalizeTableValue,computedTableSpacing} from '../lib/style/table-values.js';
import {RenderTreeBuilder} from '../lib/render-tree/index.js';
import {layoutText} from '../lib/layout/text-layout.js';

test('table properties share CSS token validation, CSSOM preservation and feature queries',()=>{
  const {window,document}=parseHTMLDocument('<div></div>');
  try {
    const style=document.querySelector('div').style;
    for(const [name,valid,invalid] of [
      ['table-layout',[['AUTO','auto'],['f\\69 xed','fixed']],["none","auto fixed",'"fixed"']],
      ['border-collapse',[['COLLAPSE','collapse'],['s\\65 parate','separate']],["collapse separate","none"]],
      ['border-spacing',[
        ['0','0px'],['.5PX','0.5px'],['1e1px 2px','10px 2px'],['1px/**/2px','1px 2px'],
        ['2px 2px','2px'],['calc(10px + .5em) calc(10px - .5em)','calc(0.5em + 10px) calc(-0.5em + 10px)'],
        ['calc(1in + 2px)','calc(98px)'],['calc((2px + 2em) * 2)','calc(4em + 4px)'],
      ],['10%','-1px','1','1.','1px 2px 3px','calc(1px + 2)','calc(1px+2px)','calc(1px + 1%)','var(foo)','var(--)','"1px"']],
    ]) {
      for(const [input,expected] of valid) {
        style.setProperty(name,input);
        expect(style.getPropertyValue(name)).toBe(expected);
        expect(supportsDeclaration(name,input)).toBeTrue();
        expect(parseDeclarations(`${name}:${input}`).get(name)?.value).toBe(expected);
      }
      const initial=valid[0][1];
      for(const input of invalid) {
        style.setProperty(name,initial,'important');style.setProperty(name,input);
        expect(style.getPropertyValue(name)).toBe(initial);
        expect(style.getPropertyPriority(name)).toBe('important');
        expect(supportsDeclaration(name,input)).toBeFalse();
        expect(parseDeclarations(`${name}:${initial};${name}:${input}`).get(name)?.value).toBe(initial);
      }
      for(const input of ['initial','inherit','unset','revert','revert-layer','var(--table)'])expect(supportsDeclaration(name,input)).toBeTrue();
      expect(style.removeProperty(name)).toBe(initial);expect(style.getPropertyValue(name)).toBe('');
    }
    for(const unit of ['ex','cap','ic','lh','rex','rch','rcap','ric','rlh']) {
      style.borderSpacing=`1${unit}`;expect(style.borderSpacing).toBe(`1${unit}`);
      expect(supportsDeclaration('border-spacing',`1${unit}`)).toBeFalse();
      expect(computedTableSpacing(`1${unit}`,()=>NaN)).toBeNull();
    }
    for(const value of ['var(--日本)','VAR(--x)','var(--x)/**/','env(unknown, collapse)']) {
      style.borderCollapse='separate';style.borderCollapse=value;
      expect(style.borderCollapse).toBe(value);
      expect(supportsDeclaration('border-collapse',value)).toBeTrue();
    }
  } finally {window.happyDOM.close();}
});

test('table lengths resolve real relative units then clamp math, and pending invalid values unset',()=>{
  const {window,document}=parseHTMLDocument('<main id=p><div id=a></div><div id=b></div><div id=c></div></main>');
  try {
    const p=document.getElementById('p'),a=document.getElementById('a'),b=document.getElementById('b'),c=document.getElementById('c');
    p.style.cssText='font-size:40px;border-spacing:3px 7px;border-collapse:collapse;table-layout:fixed';
    a.style.cssText='border-spacing:calc(10px + .5em) calc(10px - .5em);table-layout:inherit';
    b.style.cssText='border-spacing:99px;border-spacing:var(--space, 2px);--space:invalid;border-collapse:var(--collapse);--collapse:invalid;table-layout:var(--layout);--layout:invalid';
    c.style.cssText='border-spacing:initial;border-collapse:initial;table-layout:initial';
    const styles=new StyleEngine().compute(document),values=e=>{const s=styles.get(e);return [s.borderSpacing,s.borderCollapse,s.tableLayout]};
    expect(values(a)).toEqual([[30,0],'collapse','fixed']);
    expect(values(b)).toEqual([[3,7],'collapse','auto']);
    expect(values(c)).toEqual([[0,0],'separate','auto']);
    for(const [source,expected] of [['calc(1em * 2)',[80,80]],['min(2em, 20px)',[20,20]],['calc(2em / 1em * 3px)',[6,6]],['calc(-4px)',[0,0]],['calc(NaN * 1px)',[0,0]]]) {
      const normalized=normalizeTableValue('border-spacing',source);
      expect(normalized).not.toBeNull();
      expect(computedTableSpacing(normalized,unit=>unit==='1em'?40:NaN)).toEqual(expected);
    }
    a.style.cssText='border-spacing:var(--missing, 6px)';
    expect(new StyleEngine().compute(document).get(a).borderSpacing).toEqual([6,6]);
    a.style.cssText='border-spacing:9px;border-collapse:separate;table-layout:fixed;all:unset';
    let reset=new StyleEngine().compute(document).get(a);
    expect([reset.borderSpacing,reset.borderCollapse,reset.tableLayout]).toEqual([[3,7],'collapse','auto']);
    a.style.cssText+=';all:initial';reset=new StyleEngine().compute(document).get(a);
    expect([reset.borderSpacing,reset.borderCollapse,reset.tableLayout]).toEqual([[0,0],'separate','auto']);
    for(const declaration of ['var(--日本)','VAR(--x)','var(--x)/**/']) {
      a.style.cssText=`--日本:separate;--x:separate;border-collapse:${declaration}`;
      expect(new StyleEngine().compute(document).get(a).borderCollapse).toBe('separate');
    }
    const variables=new Map([['--Width','12px'],['--width','5px']]);
    expect(resolveVariables('calc(VAR(--Width) + vAr(--width))',variables)).toBe('calc(12px + 5px)');
    expect(resolveVariables('VAR(--missing, VaR(--Width))',variables)).toBe('12px');
    expect(resolveVariables('someVAR(--Width)',variables)).toBe('someVAR(--Width)');
    a.style.cssText='--Width:12px;--width:5px';
    const dimensions=new StyleEngine().compute(document,['#a{width:VAR(--Width);height:vAr(--width)}']).get(a);
    expect([dimensions.width,dimensions.height]).toEqual([12,5]);
  } finally {window.happyDOM.close();}
});

test('computed spacing and fixed layout affect real table cell placement',()=>{
  const {window,document}=parseHTMLDocument('<body style="margin:0"><table><tr><td id=a style="width:40px;padding:0">A</td><td id=b style="padding:0">a very long text</td></tr></table></body>');
  try {
    const table=document.querySelector('table');
    table.style.cssText='font-size:20px;width:200px;table-layout:fixed;border-spacing:calc(2px + .5em) calc(10px - 1em)';
    const positions=()=>{
      const tree=new RenderTreeBuilder().build(document,new StyleEngine().compute(document));
      const layout=layoutText(tree,{x:0,y:0,width:400,measureText:text=>text.length*10,fontMetrics:()=>({ascent:8,height:10})});
      return ['a','b'].map(id=>{const b=layout.boxes.find(box=>tree.nodesById.get(box.nodeId)?.domNode?.id===id);return [b.x,b.y,b.width]});
    };
    expect(positions()).toEqual([[12,0,40],[64,0,124]]);
    table.style.borderCollapse='collapse';expect(positions()).toEqual([[0,0,40],[40,0,160]]);
    table.style.borderCollapse='separate';table.style.borderSpacing='-1px';
    expect(positions()).toEqual([[12,0,40],[64,0,124]]);
  } finally {window.happyDOM.close();}
});
