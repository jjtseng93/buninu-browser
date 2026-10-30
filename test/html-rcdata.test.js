import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';

test('textarea preserves embedded markup as text and decodes character references', () => {
  const {document} = parseHTMLDocument('<textarea>\nconst html = `<div>&amp;<br></div>`;<!-- literal -->\n</TEXTAREA><p>after</p>');
  const area = document.querySelector('textarea');
  expect(area.value).toBe('const html = `<div>&<br></div>`;<!-- literal -->\n');
  expect(area.children.length).toBe(0);
  expect(document.querySelector('p').textContent).toBe('after');
});

test('RCDATA ends only at matching end tag, retaining all content through EOF', () => {
  const {document} = parseHTMLDocument('<textarea>a</textareax><b>c &lt;d\0');
  expect(document.querySelector('textarea').value).toBe('a</textareax><b>c <d\uFFFD');
  const other = parseHTMLDocument('<title>A <b>B</b> &amp; C</title><textarea>&#10;hello</textarea>').document;
  expect(other.title).toBe('A <b>B</b> & C');
  expect(other.querySelector('textarea').value).toBe('hello');
});

test('textarea parsing also works inside HTML fragments without changing script raw text', () => {
  const {document} = parseHTMLDocument('');
  document.body.innerHTML='<textarea><div>&amp;</div></textarea><script>"<div>&amp;</div>"</script>';
  expect(document.querySelector('textarea').value).toBe('<div>&</div>');
  expect(document.querySelector('script').textContent).toBe('"<div>&amp;</div>"');
});
