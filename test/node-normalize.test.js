import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {createDetachedDocument} from '../lib/renderer/document-constructor.js';
import {BindingRealm} from '../lib/renderer/bindings.js';

const fixture = () => parseHTMLDocument('<!doctype html><body></body>');
const appendText = (document, parent, values) => values.map(value => parent.appendChild(document.createTextNode(value)));
const point = range => [range.startContainer, range.startOffset, range.endContainer, range.endOffset];

test('normalize removes leading empty Texts, preserves first nonempty identity and records one append', async() => {
  const {document, window} = fixture();
  try {
    const parent = document.createElement('div');
    const [empty, first, middle, last] = appendText(document, parent, ['', 'a', '', 'b']);
    const observer = new window.MutationObserver(() => {});
    observer.observe(parent, {childList: true, characterData: true, characterDataOldValue: true, subtree: true});
    parent.normalize();
    expect([...parent.childNodes]).toEqual([first]); expect(first.data).toBe('ab');
    expect([empty.data, middle.data, last.data]).toEqual(['', '', 'b']);
    const records = observer.takeRecords();
    expect(records.map(record => [record.type, record.target, record.oldValue])).toEqual([
      ['childList', parent, null], ['characterData', first, 'a'], ['childList', parent, null], ['childList', parent, null],
    ]);
    expect(records.filter(record => record.type === 'childList').map(record => record.removedNodes)).toEqual([[empty], [middle], [last]]);
    parent.normalize();
    expect(observer.takeRecords().map(record => [record.type, record.oldValue])).toEqual([['characterData', 'ab']]);
    observer.disconnect();
  } finally {await window.happyDOM.close();}
});

test('normalize keeps non-Text boundaries, limits traversal to descendants and leaves shadow/template trees alone', async() => {
  const {document, window} = fixture();
  try {
    const xml = createDetachedDocument(window, {contentType:'application/xml'}), parent = xml.createElement('root');
    const nodes = [xml.createTextNode('a'), xml.createCDATASection(''), xml.createTextNode('b'), xml.createComment(''),
      xml.createTextNode('c'), xml.createProcessingInstruction('pi', ''), xml.createTextNode('d')];
    for (const node of nodes) parent.appendChild(node);
    parent.normalize(); expect([...parent.childNodes]).toEqual(nodes);
    const element = document.createElement('div'), text = appendText(document, element, ['', 'a', 'b']);
    text[0].normalize(); expect([...element.childNodes]).toEqual(text);
    const shadow = element.attachShadow({mode:'open'}), template = document.createElement('template');
    element.appendChild(template);
    const shadowText = appendText(document, shadow, ['s', 'h']), templateText = appendText(document, template.content, ['t', 'm']);
    element.normalize();
    expect([...shadow.childNodes]).toEqual(shadowText); expect([...template.content.childNodes]).toEqual(templateText);
    shadow.normalize(); template.content.normalize();
    expect(shadow.textContent).toBe('sh'); expect(shadow.childNodes.length).toBe(1);
    expect(template.content.textContent).toBe('tm'); expect(template.content.childNodes.length).toBe(1);
  } finally {await window.happyDOM.close();}
});

test('normalize moves UTF-16 range endpoints and parent-index boundaries before merged nodes are removed', async() => {
  const {document, window} = fixture();
  try {
    const parent = document.createElement('div'), before = document.createElement('i'), after = document.createElement('i');
    parent.appendChild(before);
    const [a, empty, b, c] = appendText(document, parent, ['A😀', '', 'BB', 'CCC']); parent.appendChild(after);
    const inside = document.createRange(); inside.setStart(b, 1); inside.setEnd(c, 2);
    const boundary = document.createRange(); boundary.setStart(parent, 2); boundary.setEnd(parent, 4);
    const outside = document.createRange(); outside.setStart(parent, 0); outside.setEnd(parent, 5);
    const collapsed = document.createRange(); collapsed.setStart(empty, 0); collapsed.collapse(true);
    const clone = inside.cloneRange(); inside.detach();
    parent.normalize();
    expect(point(inside)).toEqual([a, 4, a, 7]); expect(inside.toString()).toBe('BCC');
    expect(point(clone)).toEqual(point(inside)); expect(clone.toString()).toBe('BCC');
    expect(point(boundary)).toEqual([a, 3, a, 5]); expect(boundary.toString()).toBe('BB');
    expect(point(outside)).toEqual([parent, 0, parent, 2]);
    expect(point(collapsed)).toEqual([a, 3, a, 3]);
    expect([...parent.childNodes]).toEqual([before, a, after]);
  } finally {await window.happyDOM.close();}
});

test('empty Text removal relocates both direct and parent ranges without touching sibling data', async() => {
  const {document, window} = fixture();
  try {
    const parent = document.createElement('div'), [empty, text] = appendText(document, parent, ['', 'text']);
    const direct = document.createRange(); direct.setStart(empty, 0); direct.setEnd(empty, 0);
    const parentRange = document.createRange(); parentRange.selectNode(empty);
    const after = document.createRange(); after.setStart(parent, 2); after.collapse(true);
    parent.normalize();
    expect(point(direct)).toEqual([parent, 0, parent, 0]);
    expect(point(parentRange)).toEqual([parent, 0, parent, 0]);
    expect(point(after)).toEqual([parent, 1, parent, 1]); expect(parent.firstChild).toBe(text);
  } finally {await window.happyDOM.close();}
});

test('selection-created ranges, synchronous selectionchange reentry and escaped selection ranges remain live', async() => {
  const {document, window} = fixture();
  try {
    const parent = document.createElement('div'); document.body.appendChild(parent);
    const selection = window.getSelection();
    let [a, b] = appendText(document, parent, ['first', 'second']);
    selection.setBaseAndExtent(b, 1, b, 4);
    parent.normalize(); expect(selection.toString()).toBe('eco');
    expect([selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset]).toEqual([a, 6, a, 9]);
    parent.textContent = ''; [a, b] = appendText(document, parent, ['first', 'second']);
    selection.setBaseAndExtent(b, 1, b, 4); const escaped = selection.getRangeAt(0); selection.removeAllRanges();
    parent.normalize(); expect(point(escaped)).toEqual([a, 6, a, 9]);
    parent.textContent = ''; [a, b] = appendText(document, parent, ['first', 'second']);
    const onChange = () => parent.normalize(); document.addEventListener('selectionchange', onChange);
    selection.setBaseAndExtent(b, 1, b, 4); document.removeEventListener('selectionchange', onChange);
    expect(selection.toString()).toBe('eco'); expect(selection.anchorNode).toBe(a);
  } finally {await window.happyDOM.close();}
});

test('normalization preserves stylesheet, textarea, iterator and renderer invalidation hooks', async() => {
  const {document, window} = fixture();
  try {
    const style = document.createElement('style'); document.head.appendChild(style);
    appendText(document, style, ['body{color:', 'red}']); style.normalize();
    expect(style.sheet.cssRules[0].style.color).toBe('red');
    const area = document.createElement('textarea'); document.body.appendChild(area);
    appendText(document, area, ['first', 'second']); area.normalize(); expect(area.defaultValue).toBe('firstsecond');
    let touched; const realm = new BindingRealm(window, {touch(node){touched=node}});
    const parent = document.createElement('div'), [a, b] = appendText(document, parent, ['first', 'second']);
    const wrapped = realm.wrap(parent), iterator = realm.wrap(document).createNodeIterator(wrapped);
    iterator.nextNode(); iterator.nextNode(); iterator.nextNode();
    wrapped.normalize(); expect(touched).toBe(parent);
    expect(iterator.referenceNode).toBe(realm.wrap(a)); expect(iterator.nextNode()).toBeNull(); expect(b.parentNode).toBeNull();
  } finally {await window.happyDOM.close();}
});

test('normalize walks deeply nested descendants without recursive normalization calls', async() => {
  const {document, window} = fixture();
  try {
    const root = document.createElement('div'); let leaf = root;
    for (let i = 0; i < 1500; i++) leaf = leaf.appendChild(document.createElement('div'));
    appendText(document, leaf, ['', 'deep', ' text']);
    root.normalize(); expect(leaf.childNodes.length).toBe(1); expect(leaf.firstChild.data).toBe('deep text');
    expect(() => window.Node.prototype.normalize.call({})).toThrow(TypeError);
  } finally {await window.happyDOM.close();}
});
