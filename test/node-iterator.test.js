import { afterAll, beforeAll, expect, test } from 'bun:test';
import { RendererHost } from '../lib/renderer/host.js';
import { nodeIteratorCases } from './fixtures/node-iterator-cases.js';
import chromium from './fixtures/node-iterator-chromium.json';

const host = new RendererHost({timeout: 20000, fetch: async () => new Response('')});
beforeAll(async () => {
  await host.call('loadDocument', {url:'https://iterator.test/',source:'<body></body>',contentType:'text/html',status:200});
  await host.call('whenLoaded');
});
afterAll(() => host.close());
const evaluate = async expression => JSON.parse(await host.call('evaluate', `JSON.stringify(${expression})`));

test('NodeIterator traversal, replacement and WebIDL conversion match Chromium and DOM', async () => {
  const actual = await evaluate(`(${nodeIteratorCases})()`);
  const expected = chromium.map(row => {
    // Chromium retains a detached reference when replacing a node with its
    // following sibling while the pointer is before it. DOM replace adopts
    // (detaches) that sibling first, then removes the old node: the repaired
    // reference must be root, not the now-detached old node/descendant.
    // https://dom.spec.whatwg.org/#concept-node-replace steps 6–7
    if (row[1] === 'sibling' && [1,2].includes(row[2]) && row[3]) {
      return [...row.slice(0,4), 'root', false, 'b', 'b', 'b'];
    }
    return row;
  });
  expect(actual).toEqual(expected);
});

test('failed replacements leave the tree and iterator position unchanged', async () => {
  expect(await evaluate(`(() => {
    const results=[];
    for(const kind of ['ancestor','missing','document','textDocument','twoElements']) {
      const root=document.createElement('div');root.id='root';root.innerHTML='<b id="a"></b><i id="b"></i>';
      const doc=document.implementation.createHTMLDocument('');
      const parent=kind==='textDocument'||kind==='twoElements'?doc:root;
      const old=parent.firstChild;
      const it=document.createNodeIterator(parent);it.nextNode();it.nextNode();
      const reference=it.referenceNode,before=it.pointerBeforeReferenceNode;
      const children=[...parent.childNodes];
      let incoming=kind==='ancestor'?root:kind==='document'?document:document.createElement('em');
      if(kind==='textDocument')incoming=document.createTextNode('invalid');
      if(kind==='twoElements'){incoming=document.createDocumentFragment();incoming.append(document.createElement('i'),document.createElement('b'));}
      let error;
      try{parent.replaceChild(incoming,kind==='missing'?document.createElement('b'):old)}catch(e){error=e.name}
      results.push([kind,error,it.referenceNode===reference,it.pointerBeforeReferenceNode===before,
        children.length===parent.childNodes.length&&children.every((n,i)=>n===parent.childNodes[i])]);
    }
    return results;
  })()`)).toEqual([
    ['ancestor','HierarchyRequestError',true,true,true],['missing','NotFoundError',true,true,true],
    ['document','HierarchyRequestError',true,true,true],['textDocument','HierarchyRequestError',true,true,true],
    ['twoElements','HierarchyRequestError',true,true,true]
  ]);
});

test('filter replacement repairs both active and stored iterator cursors', async () => {
  expect(await evaluate(`(() => {
    const root=document.createElement('div');root.id='root';root.innerHTML='<b id="a"></b><i id="b"></i>';
    const it=document.createNodeIterator(root,1,n=>{
      if(n.id==='a'){const replacement=document.createElement('em');replacement.id='x';root.replaceChild(replacement,n)}
      return 1;
    });
    const got=[];for(let n,i=0;i<8&&(n=it.nextNode());i++)got.push(n.id);
    return got;
  })()`)).toEqual(['root','a','x','b']);
});

test('batch removal follows DOM tree order and keeps references attached', async () => {
  expect(await evaluate(`(() => {
    const results=[];
    for(const operation of ['replaceChildren','innerHTML','textContent'])for(const before of [false,true]) {
      const root=document.createElement('div');root.innerHTML='<i>a</i><i>b</i>';
      const it=document.createNodeIterator(root);it.nextNode();it.nextNode();it.nextNode();
      if(before)it.previousNode();
      if(operation==='replaceChildren')root.replaceChildren();else root[operation]='';
      results.push([it.referenceNode===root,it.pointerBeforeReferenceNode,it.nextNode()]);
    }
    return results;
  })()`)).toEqual(Array.from({length:6},()=>[true,false,null]));
});
