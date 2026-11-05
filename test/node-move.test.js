import {beforeAll, afterAll, test, expect} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

let host;
beforeAll(async () => {
  host = new RendererHost({timeout:20000});
  await host.start();
  await host.call('loadDocument', {url:'https://move.test/',contentType:'text/html',source:'<!doctype html><body></body>'});
  await host.call('whenLoaded');
});
afterAll(() => host?.close());
const evaluate = source => host.call('evaluate', source);

test('moveBefore keeps focus, dirty values, backward selections and iframe realms alive', async () => {
  expect(await evaluate(`(() => {
    const fixture=document.createElement('div');document.body.append(fixture);
    fixture.innerHTML='<div><input value="initial"><textarea>initial</textarea><iframe></iframe></div><section></section>';
    const source=fixture.firstChild,dest=fixture.lastChild,input=source.children[0],textarea=source.children[1],frame=source.lastChild;
    input.value='0123456789';input.focus();input.setSelectionRange(2,7,'backward');textarea.value='dirty';textarea.setSelectionRange(1,4,'backward');
    const win=frame.contentWindow,doc=frame.contentDocument;win.keep={id:1};
    const saved=win.keep;doc.body.textContent='preserved';let blur=0;input.onblur=()=>blur++;
    dest.moveBefore(source,null);
    const out=[document.activeElement===input,input.value,input.selectionStart,input.selectionEnd,input.selectionDirection,
      textarea.value,textarea.selectionStart,textarea.selectionEnd,textarea.selectionDirection,blur,
      frame.contentWindow===win,frame.contentDocument===doc,win.keep===saved,doc.body.textContent];
    fixture.remove();return out;
  })()`)).toEqual([true,'0123456789',2,7,'backward','dirty',1,4,'backward',0,true,true,true,'preserved']);
});

test('moving scripts preserves execution state and canvas backing pixels', async () => {
  expect(await evaluate(`(() => {
    const fixture=document.createElement('div');document.body.append(fixture);
    fixture.innerHTML='<div></div><section></section>';const source=fixture.firstChild,dest=fixture.lastChild;
    const script=document.createElement('script');script.text='window.moveExecutions=(window.moveExecutions||0)+1';source.append(script);
    const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;source.append(canvas);
    const context=canvas.getContext('2d');context.fillStyle='red';context.fillRect(0,0,2,2);
    const before=window.moveExecutions;dest.moveBefore(source,null);
    const out=[window.moveExecutions===before,canvas.getContext('2d')===context,[...context.getImageData(0,0,1,1).data]];
    fixture.remove();return out;
  })()`)).toEqual([true,true,[255,0,0,255]]);
});

test('atomic moves preserve live collection objects and repair ranges and iterator positions', async () => {
  expect(await evaluate(`(() => {
    const root=document.createElement('div');root.innerHTML='<p>A</p><section>B</section><aside>C</aside>';
    const a=root.firstChild,b=a.nextSibling,c=root.lastChild,nodes=root.childNodes,elements=root.children;
    const range=document.createRange();range.setStart(a.firstChild,1);range.setEnd(root,3);
    const after=document.createRange();after.setStart(root,2);after.collapse(true);
    const iterator=document.createNodeIterator(root);iterator.nextNode();iterator.nextNode();iterator.nextNode();
    root.moveBefore(a,c);
    return [root.childNodes===nodes,root.children===elements,[...nodes].map(n=>n.tagName).join(','),
      range.startContainer===root,range.startOffset,range.endContainer===root,range.endOffset,
      after.startContainer===root,after.startOffset,iterator.referenceNode===root,iterator.nextNode()===b,
      root.moveBefore(c,c)===undefined,root.lastChild===c];
  })()`)).toEqual([true,true,'SECTION,P,ASIDE',true,0,true,3,true,1,true,true,true,true]);
});

test('move callbacks are captured at definition and see final connected tree in subtree order', async () => {
  expect(await evaluate(`(() => {
    const events=[];let dest;
    class Outer extends HTMLElement {connectedCallback(){events.push('connect')} disconnectedCallback(){events.push('disconnect')}
      connectedMoveCallback(){events.push('move:'+this.isConnected+':'+(this.parentNode===dest))}}
    class Inner extends HTMLElement {connectedCallback(){events.push('inner connect:'+this.isConnected)} disconnectedCallback(){events.push('inner disconnect:'+this.isConnected)}}
    customElements.define('move-outer',Outer);customElements.define('move-inner',Inner);
    Outer.prototype.connectedMoveCallback=()=>events.push('WRONG');
    const fixture=document.createElement('div');document.body.append(fixture);const outer=document.createElement('move-outer');
    outer.append(document.createElement('move-inner'));fixture.append(outer);dest=document.createElement('section');fixture.append(dest);
    events.length=0;dest.moveBefore(outer,null);const out=events.slice();fixture.remove();return out;
  })()`)).toEqual(['move:true:true','inner disconnect:true','inner connect:true']);
});

test('closed shadow moves preserve connectivity, update ordinary roots, ids and form ownership', async () => {
  expect(await evaluate(`(() => {
    const fixture=document.createElement('div');fixture.innerHTML='<form id="move-form"><input id="move-input"></form><div></div>';document.body.append(fixture);
    const form=fixture.firstChild,input=form.firstChild,shadow=fixture.lastChild.attachShadow({mode:'closed'});
    shadow.moveBefore(input,null);
    const out=[input.isConnected,input.getRootNode()===shadow,input.getRootNode({composed:true})===document,input.form===null,
      document.getElementById('move-input')===null,shadow.getElementById('move-input')===input];
    form.moveBefore(input,null);out.push(input.form===form,input.getRootNode()===document,document.getElementById('move-input')===input,shadow.getElementById('move-input')===null);
    fixture.remove();return out;
  })()`)).toEqual(Array(10).fill(true));
});

test('observers report final-tree removals then additions and preserve transient registrations', async () => {
  expect(await evaluate(`(() => {
    const root=document.createElement('div');root.innerHTML='<section><i></i><b></b><u></u></section><aside><em></em></aside>';
    const old=root.firstChild,dest=root.lastChild,node=old.children[1],first=old.firstChild,last=old.lastChild,ref=dest.firstChild;
    const all=new MutationObserver(()=>{}),sub=new MutationObserver(()=>{});all.observe(root,{childList:true,attributes:true,subtree:true});sub.observe(old,{attributes:true,subtree:true});
    dest.moveBefore(node,ref);node.id='changed';const records=all.takeRecords(),temporary=sub.takeRecords();
    all.disconnect();sub.disconnect();return [records.length,records[0].target===old,records[0].removedNodes[0]===node,
      records[0].previousSibling===first,records[0].nextSibling===last,records[1].target===dest,records[1].addedNodes[0]===node,
      records[1].previousSibling===null,records[1].nextSibling===ref,records[2].target===node,temporary.length,temporary[0].target===node];
  })()`)).toEqual([3,true,true,true,true,true,true,true,true,true,1,true]);
});

test('moving checked radios updates form and shadow groups without making checkedness dirty', async () => {
  expect(await evaluate(`(() => {
    const fixture=document.createElement('div');fixture.innerHTML='<form><input type="radio" name="choice" checked></form><form><input type="radio" name="choice" checked></form><div></div>';
    document.body.append(fixture);
    const first=fixture.children[0],second=fixture.children[1],radio=first.firstChild,peer=second.firstChild;
    second.moveBefore(radio,null);const out=[radio.checked,!peer.checked,radio.form===second];
    radio.removeAttribute('checked');out.push(!radio.checked); // A move must not mark checkedness dirty.
    radio.checked=true;
    const shadow=fixture.lastChild.attachShadow({mode:'closed'}),shadowRadio=document.createElement('input');
    shadowRadio.type='radio';shadowRadio.name='choice';shadowRadio.checked=true;shadow.append(shadowRadio);
    shadow.moveBefore(radio,null);out.push(radio.checked,!shadowRadio.checked,radio.form===null,radio.getRootNode()===shadow);
    peer.checked=true;second.moveBefore(radio,null);out.push(radio.checked,!peer.checked,radio.form===second);
    fixture.remove();
    first.append(shadowRadio);shadowRadio.checked=true;first.moveBefore(radio,null);
    out.push(radio.checked,!shadowRadio.checked,radio.form===first,!radio.isConnected);
    return out;
  })()`)).toEqual(Array(15).fill(true));
});

test('move validation is branded, atomic, and permits detached nodes only within one shadow-including tree', async () => {
  expect(await evaluate(`(() => {
    const root=document.createElement('div');root.innerHTML='<p>A</p><section></section>';
    const node=root.firstChild,dest=root.lastChild,outsider=document.createElement('div'),out=[];
    for(const f of [()=>dest.moveBefore(node),()=>dest.moveBefore({},null),()=>dest.moveBefore(node,{}),
      ()=>Element.prototype.moveBefore.call({},node,null),()=>Element.prototype.moveBefore.call(document,node,null)]){
      try{f();out.push(false)}catch(e){out.push(e instanceof TypeError,node.parentNode===root)}
    }
    for(const [f,name] of [[()=>dest.moveBefore(root,null),'HierarchyRequestError'],[()=>outsider.moveBefore(node,null),'HierarchyRequestError'],
      [()=>dest.moveBefore(node,outsider),'NotFoundError']]) {try{f();out.push(false)}catch(e){out.push(e.name===name,node.parentNode===root)}}
    dest.moveBefore(node,null);out.push(!node.isConnected,node.parentNode===dest,root.getRootNode()===root);
    return out;
  })()`)).toEqual(Array(19).fill(true));
});

test('rendering fixes focus in hidden and inert contexts after synchronous preservation', async () => {
  for (const css of ['hidden', 'inert', 'visibility']) {
    expect(await evaluate(`(() => {
      const fixture=document.createElement('div');fixture.innerHTML='<div><button>Focus</button></div><section></section>';document.body.append(fixture);
      globalThis.focusFixture=fixture;const source=fixture.firstChild,dest=fixture.lastChild,button=source.firstChild;
      if('${css}'==='visibility')dest.style.visibility='hidden';else dest['${css}']=true;
      globalThis.focusEvents=[];button.onblur=()=>focusEvents.push('blur');button.addEventListener('focusout',()=>focusEvents.push('focusout'));
      button.focus();dest.moveBefore(source,null);return document.activeElement===button;
    })()`)).toBe(true);
    await Bun.sleep(140);
    expect(await evaluate(`(()=>{const out=[document.activeElement===document.body,focusEvents];focusFixture.remove();return out})()`))
      .toEqual([true,['blur','focusout']]);
  }
});

test('connectedMove includes closed shadow descendants and queues reentrant callbacks in element order', async () => {
  expect(await evaluate(`(() => {
    const events=[];let destination,other;
    class Item extends HTMLElement {connectedMoveCallback(){events.push(this.id);if(this.id==='outer')other.moveBefore(this.firstChild,null)}}
    customElements.define('move-reentrant',Item);
    const fixture=document.createElement('div');document.body.append(fixture);destination=document.createElement('section');other=document.createElement('aside');fixture.append(destination,other);
    const outer=document.createElement('move-reentrant'),inner=document.createElement('move-reentrant');outer.id='outer';inner.id='inner';outer.append(inner);
    const host=document.createElement('div');outer.append(host);const shadow=host.attachShadow({mode:'closed'});const hidden=document.createElement('move-reentrant');hidden.id='shadow';shadow.append(hidden);fixture.append(outer);
    destination.moveBefore(outer,null);const out=[events,inner.parentNode===other,hidden.getRootNode()===shadow,hidden.isConnected];fixture.remove();return out;
  })()`)).toEqual([['outer','inner','inner','shadow'],true,true,true]);
});
