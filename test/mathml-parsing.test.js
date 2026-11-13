import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';

const MATHML = 'http://www.w3.org/1998/Math/MathML';
const HTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';

test('math and its descendants are parsed into the MathML namespace', () => {
  const {document} = parseHTMLDocument('<p>a <MATH display="block"><mfrac><mi>x</mi><mn>2</mn></mfrac></MATH> b</p>');
  const math = document.querySelector('math');
  expect(math.namespaceURI).toBe(MATHML);
  expect(math.localName).toBe('math');
  expect(math.getAttribute('display')).toBe('block');
  for (const name of ['mfrac', 'mi', 'mn']) expect(document.querySelector(name).namespaceURI).toBe(MATHML);
  expect(document.querySelector('p').textContent).toBe('a x2 b');
});

test('HTML inside a text integration point is HTML again, and svg inside math is SVG', () => {
  const {document} = parseHTMLDocument('<math><mtext>t<b>bold</b>u</mtext><mi><mglyph/></mi><svg><circle r="1"/></svg></math>');
  expect(document.querySelector('b').namespaceURI).toBe(HTML);
  expect(document.querySelector('mglyph').namespaceURI).toBe(MATHML);
  expect(document.querySelector('svg').namespaceURI).toBe(SVG);
  expect(document.querySelector('circle').namespaceURI).toBe(SVG);
});

test('MathML elements self-close, and end tags close across namespaces', () => {
  const {document} = parseHTMLDocument('<p>a<math><mtext>t<span>s</mtext><mspace width="1em"/><mi>x</mi></math><span id="after">after</span></p>');
  const math = document.querySelector('math');
  expect([...math.children].map(child => child.localName)).toEqual(['mtext', 'mspace', 'mi']);
  expect(document.querySelector('mspace').children.length).toBe(0);
  // </mtext> closes the HTML <span> it holds; </math> ends MathML before the next HTML sibling.
  expect(document.getElementById('after').parentNode.localName).toBe('p');
  expect(document.getElementById('after').namespaceURI).toBe(HTML);
});

test('innerHTML parses MathML the same way and serializes it back', () => {
  const {document} = parseHTMLDocument('');
  document.body.innerHTML = '<math><msup><mi>e</mi><mrow><mi>i</mi><mi>π</mi></mrow></msup></math>';
  expect(document.querySelector('msup').namespaceURI).toBe(MATHML);
  expect(document.body.innerHTML).toBe('<math><msup><mi>e</mi><mrow><mi>i</mi><mi>π</mi></mrow></msup></math>');
});
