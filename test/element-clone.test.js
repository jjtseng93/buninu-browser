import { test, expect } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { createDetachedDocument, elementTagName } from '../lib/renderer/document-constructor.js';

const HTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';

test('element cloning retains prefixed HTML, SVG and XML names without aliasing attributes', () => {
  const { window } = parseHTMLDocument('');
  try {
    const document = createDetachedDocument(window);
    for (const [namespace, name, interfaceName] of [
      [HTML, 'h:div', 'HTMLDivElement'], [SVG, 's:svg', 'SVGSVGElement'],
      ['urn:other', 'p:Mixed', 'Element'], [null, 'Mixed', 'Element'],
    ]) {
      const source = document.createElementNS(namespace, name);
      source.setAttributeNS('urn:attribute', 'a:label', 'original');
      source.appendChild(document.createTextNode('text'));
      const clone = source.cloneNode(false);
      expect(clone instanceof window[interfaceName]).toBeTrue();
      expect([clone.prefix, clone.localName, clone.namespaceURI, elementTagName(clone)])
        .toEqual([source.prefix, source.localName, namespace, name]);
      expect(clone.ownerDocument).toBe(document);
      expect(clone.childNodes.length).toBe(0);
      expect(clone.getAttributeNodeNS('urn:attribute', 'label')).not.toBe(source.attributes[0]);
      clone.setAttributeNS('urn:attribute', 'b:label', 'changed');
      expect(source.getAttributeNS('urn:attribute', 'label')).toBe('original');
      expect(source.prefix).toBe(name.includes(':') ? name.split(':')[0] : null);
    }
  } finally { window.happyDOM.close(); }
});

test('deep cloning and import retain qualified names throughout nested trees', () => {
  const { window } = parseHTMLDocument('');
  try {
    const sourceDocument = createDetachedDocument(window), target = createDetachedDocument(window);
    const root = sourceDocument.createElementNS('urn:root', 'r:root');
    const child = sourceDocument.createElementNS(SVG, 's:svg');
    child.appendChild(sourceDocument.createElementNS(SVG, 's:path'));
    root.appendChild(child);
    sourceDocument.appendChild(root);
    const clonedDocument = sourceDocument.cloneNode(true);
    const clone = root.cloneNode(true), imported = target.importNode(root, true);
    for (const tree of [clone, imported, clonedDocument.documentElement]) {
      expect([tree.prefix, tree.firstChild.prefix, tree.firstChild.firstChild.prefix]).toEqual(['r', 's', 's']);
      expect(tree.firstChild).not.toBe(child);
      expect(tree.firstChild instanceof window.SVGSVGElement).toBeTrue();
      expect(tree.firstChild.firstChild instanceof window.SVGPathElement).toBeTrue();
      expect(new window.XMLSerializer().serializeToString(tree))
        .toBe(new window.XMLSerializer().serializeToString(root));
    }
    expect([imported.ownerDocument, imported.firstChild.ownerDocument, imported.firstChild.firstChild.ownerDocument])
      .toEqual([target, target, target]);
    expect(clonedDocument.documentElement.ownerDocument).toBe(clonedDocument);
    expect(root.ownerDocument).toBe(sourceDocument);
  } finally { window.happyDOM.close(); }
});

test('element clone adapter preserves specialized form state and template content steps', () => {
  const { window } = parseHTMLDocument('');
  try {
    const document = createDetachedDocument(window);
    const input = document.createElementNS(HTML, 'h:input');
    input.defaultValue = 'default'; input.value = 'edited';
    const copy = input.cloneNode();
    expect([copy.prefix, copy.defaultValue, copy.value]).toEqual(['h', 'default', 'edited']);
    const template = document.createElementNS(HTML, 'h:template');
    template.content.appendChild(document.createElementNS('urn:test', 'p:item'));
    const deep = template.cloneNode(true), shallow = template.cloneNode(false);
    expect([deep.prefix, deep.content.firstChild.prefix, shallow.prefix, shallow.content.childNodes.length])
      .toEqual(['h', 'p', 'h', 0]);
    expect(deep.content.firstChild).not.toBe(template.content.firstChild);
  } finally { window.happyDOM.close(); }
});
