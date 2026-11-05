import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {createDetachedDocument} from '../lib/renderer/document-constructor.js';
import {RendererHost} from '../lib/renderer/host.js';

const fixture = () => parseHTMLDocument('<!doctype html><body><div>abc</div></body>');
const points = range => [range.startContainer, range.startOffset, range.endContainer, range.endOffset];
const domError = (callback, name) => {
  let error;
  try { callback(); } catch (caught) { error = caught; }
  expect(error?.name).toBe(name);
};

test('Range boundary setters collapse across ordinary roots while retaining offsets within one root', async () => {
  const {document, window} = fixture();
  try {
    const host = document.createElement('div'); document.body.appendChild(host);
    const shadow = host.attachShadow({mode:'open'});
    const attr = document.createAttribute('x'); attr.value = 'not node length';
    const detached = document.createElement('section'), fragment = document.createDocumentFragment();
    for (const root of [shadow, attr, detached, fragment]) {
      const range = document.createRange();
      range.setStart(root, 0);
      expect(points(range)).toEqual([root, 0, root, 0]);
      expect(range.collapsed).toBe(true); expect(range.commonAncestorContainer).toBe(root);
      expect(range.cloneContents().childNodes.length).toBe(0);
      expect(range.extractContents().childNodes.length).toBe(0);
      range.deleteContents(); expect(points(range)).toEqual([root, 0, root, 0]);
      range.selectNodeContents(document.body); range.setEnd(root, 0);
      expect(points(range)).toEqual([root, 0, root, 0]);
    }
    const a = shadow.appendChild(document.createTextNode('abc'));
    const b = shadow.appendChild(document.createTextNode('def'));
    const range = document.createRange(); range.setStart(a, 1); range.setEnd(b, 2);
    expect(points(range)).toEqual([a, 1, b, 2]); expect(range.toString()).toBe('bcde');
    range.setStart(b, 3); expect(points(range)).toEqual([b, 3, b, 3]);
    range.setEnd(a, 0); expect(points(range)).toEqual([a, 0, a, 0]);
    domError(() => range.setStart(attr, 1), 'IndexSizeError');
    expect(points(range)).toEqual([a, 0, a, 0]);
  } finally { await window.happyDOM.close(); }
});

test('Range queries exclude detached, attribute and shadow roots and validate in specification order', async () => {
  const {document, window} = fixture();
  try {
    const host = document.createElement('div'); document.body.appendChild(host);
    const shadow = host.attachShadow({mode:'open'}); shadow.innerHTML = '<b>abc</b>';
    const attr = document.createAttribute('x'), detached = document.createElement('div');
    const range = document.createRange(); range.selectNode(document.body);
    expect(range.intersectsNode(host)).toBe(true);
    for (const node of [attr, detached, shadow, shadow.firstChild]) {
      expect(range.intersectsNode(node)).toBe(false);
      expect(range.isPointInRange(node, 1000)).toBe(false);
      domError(() => range.comparePoint(node, 1000), 'WrongDocumentError');
      const other = document.createRange(); other.selectNodeContents(node);
      for (const how of [0, 1, 2, 3]) domError(() => range.compareBoundaryPoints(how, other), 'WrongDocumentError');
      domError(() => range.compareBoundaryPoints(4, other), 'NotSupportedError');
      expect(other.intersectsNode(node)).toBe(true);
    }
    range.selectNodeContents(attr);
    expect(range.comparePoint(attr, 0)).toBe(0); expect(range.isPointInRange(attr, 0)).toBe(true);
    domError(() => range.comparePoint(attr, 1), 'IndexSizeError');
    domError(() => range.isPointInRange(attr, 1), 'IndexSizeError');
    range.selectNodeContents(shadow.firstChild);
    expect(range.intersectsNode(shadow.firstChild.firstChild)).toBe(true);
    expect(range.isPointInRange(shadow.firstChild.firstChild, 2)).toBe(true);
  } finally { await window.happyDOM.close(); }
});

test('Range comparisons use current roots even when ranges were constructed in different documents', async () => {
  const {document, window} = fixture(), foreign = fixture();
  try {
    const text = foreign.document.body.firstChild.firstChild;
    const a = document.createRange(), b = foreign.document.createRange();
    a.setStart(text, 1); a.setEnd(text, 2);
    b.setStart(text, 0); b.setEnd(text, 3);
    expect(points(a)).toEqual([text, 1, text, 2]);
    expect([0, 1, 2, 3].map(how => a.compareBoundaryPoints(how, b))).toEqual([1, 1, -1, -1]);
    expect(a.cloneContents().ownerDocument).toBe(foreign.document);
    expect(a.cloneRange().cloneContents().ownerDocument).toBe(foreign.document);
    for (const method of ['selectNode', 'selectNodeContents']) {
      const range = document.createRange(); range[method](text);
      expect(range.cloneContents().ownerDocument).toBe(foreign.document);
    }
    const adopted = document.createElement('i'); adopted.textContent = 'retained';
    const retained = document.createRange(); retained.selectNodeContents(adopted);
    foreign.document.adoptNode(adopted);
    expect(retained.cloneContents().ownerDocument).toBe(foreign.document);
    expect(retained.cloneRange().cloneContents().ownerDocument).toBe(foreign.document);
    const extracted = retained.extractContents();
    expect(extracted.ownerDocument).toBe(foreign.document); expect(extracted.textContent).toBe('retained');
    const xml = createDetachedDocument(window, {contentType:'application/xml'});
    const cdata = xml.createCDATASection('abc'), comment = xml.createComment('abc');
    for (const node of [cdata, comment]) {
      const range = document.createRange(); range.setStart(node, 1); range.setEnd(node, 3);
      expect(points(range)).toEqual([node, 1, node, 3]);
      domError(() => range.setEnd(node, 4), 'IndexSizeError');
    }
  } finally { await window.happyDOM.close(); await foreign.window.happyDOM.close(); }
});

test('Range insertion rejects invalid node types before changing either tree or splitting Text', async () => {
  const {document, window} = fixture();
  try {
    const attr = document.createAttribute('x'), range = document.createRange();
    const container = document.body.firstChild, text = container.firstChild;
    range.selectNodeContents(attr);
    domError(() => range.insertNode(container), 'HierarchyRequestError');
    domError(() => range.surroundContents(document.createElement('span')), 'HierarchyRequestError');
    expect(container.parentNode).toBe(document.body); expect(attr.childNodes.length).toBe(0);
    range.setStart(text, 1); range.collapse(true);
    for (const node of [attr, document]) domError(() => range.insertNode(node), 'HierarchyRequestError');
    expect(container.childNodes.length).toBe(1); expect(text.data).toBe('abc');
    expect(points(range)).toEqual([text, 1, text, 1]);
  } finally { await window.happyDOM.close(); }
});

test('root changes preserve live-normalize tracking and UTF-16 boundary offsets', async () => {
  const {document, window} = fixture();
  try {
    const parent = document.createElement('form');
    const first = parent.appendChild(document.createTextNode('😀'));
    const last = parent.appendChild(document.createTextNode('abc'));
    const range = document.createRange(); range.setStart(last, 1); range.setEnd(last, 2);
    const clone = range.cloneRange(); parent.normalize();
    expect(points(range)).toEqual([first, 3, first, 4]); expect(points(clone)).toEqual(points(range));
    expect(range.toString()).toBe('b');
  } finally { await window.happyDOM.close(); }
});

test('page Range bindings preserve IDL order, exception identities and mutable per-page prototypes', async () => {
  const host = new RendererHost({timeout:20000});
  try {
    await host.call('loadDocument', {url:'https://range.test/', contentType:'text/html', source:'<!doctype html><body>abc</body>'});
    await host.call('whenLoaded');
    expect(await host.call('evaluate', `(() => {
      const range = new Range(), result = [], marker = {}, body = document.body;
      const typeError = fn => {try {fn();return false} catch (e) {return e instanceof TypeError}};
      for (const method of ['setStart','setEnd','comparePoint','isPointInRange']) {
        result.push(typeError(()=>range[method](body)), typeError(()=>range[method](body,1n)),
          typeError(()=>range[method](body,Symbol())),typeError(()=>Range.prototype[method].call({},body,0)));
        let converted=false;
        result.push(typeError(()=>range[method](null,{valueOf(){converted=true;return 0}})),!converted);
        try {range[method](body,{valueOf(){throw marker}})} catch(e) {result.push(e===marker)}
      }
      for(const method of ['intersectsNode','selectNode','selectNodeContents','setStartBefore','setStartAfter','setEndBefore','setEndAfter','insertNode','surroundContents']) {
        result.push(typeError(()=>range[method]()),typeError(()=>range[method]({})));
      }
      range.setStart(body.firstChild,4294967297);range.setEnd(body.firstChild,3);
      result.push(range.startOffset===1,range.endOffset===3);
      for(const how of [0,65536,-65536]) result.push(range.compareBoundaryPoints(how,range)===0);
      let converted=false;result.push(typeError(()=>range.compareBoundaryPoints({valueOf(){converted=true;return 0}},{})),converted);
      const attr=document.createAttribute('x');range.selectNodeContents(attr);
      for(const method of ['setStartBefore','setStartAfter','setEndBefore','setEndAfter','selectNode']) {
        try {range[method](attr)}catch(e){result.push(e instanceof DOMException,e.name==='InvalidNodeTypeError',e.code===24)}
      }
      const getter=Object.getOwnPropertyDescriptor(Range.prototype,'startContainer').get;
      result.push(typeError(()=>getter.call({})),typeError(()=>Range()));
      const original=Range.prototype.intersectsNode;Range.prototype.intersectsNode=()=>123;
      result.push(range.intersectsNode(body)===123);Range.prototype.intersectsNode=original;
      return result;
    })()`)).toEqual(Array(71).fill(true));
  } finally { host.close(); }
}, 30000);
