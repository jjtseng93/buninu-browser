import {test, expect} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine, supportsDeclaration, supportsCSS} from '../lib/style/computed-style.js';
import {RendererHost} from '../lib/renderer/host.js';

test('currentcolor is a supported color in declaration and conditional feature queries', () => {
  for (const value of ['currentcolor', 'currentColor', 'CURRENTCOLOR', ' currentcolor ']) {
    expect(supportsDeclaration('color', value)).toBeTrue();
    expect(supportsCSS(`(color: ${value})`)).toBeTrue();
    expect(supportsCSS(`not (color: ${value})`)).toBeFalse();
  }
  for (const value of ['currentcolors', 'currentcolor red', '"currentcolor"']) {
    expect(supportsDeclaration('color', value)).toBeFalse();
  }
});

test('currentcolor restores inherited color after resets and follows incremental parent changes', () => {
  const {document, window} = parseHTMLDocument(`<!doctype html><html style="color:red"><body>
    <div id="parent" style="color:blue">
      <span id="reset" style="all:initial;color:currentcolor">reset</span>
      <span id="mixed" style="color:CURRENTCOLOR">mixed case</span>
      <span id="fallback" style="color:var(--missing,currentColor)">fallback</span>
      <span id="inherited" style="color:inherit">inherited</span>
      <span id="ordinary">ordinary inheritance</span>
      <span id="explicit" style="color:red">explicit color</span>
    </div></body></html>`);
  try {
    const root = document.documentElement;
    const parent = document.getElementById('parent');
    const ids = ['reset', 'mixed', 'fallback', 'inherited', 'ordinary'];
    const engine = new StyleEngine().compute(document);
    for (const id of ids) expect(engine.get(document.getElementById(id)).color).toBe('rgba(0, 0, 255, 1)');
    parent.style.color = 'green';
    engine.compute(document, [], {}, new Set(), new Set([parent]));
    const full = new StyleEngine().compute(document);
    for (const id of ids) {
      const node = document.getElementById(id);
      expect(engine.get(node).color).toBe('rgba(0, 128, 0, 1)');
      expect(engine.get(node)).toEqual(full.get(node));
    }
    expect(engine.get(document.getElementById('explicit')).color).toBe('rgba(255, 0, 0, 1)');
    root.style.color = 'currentColor';
    engine.compute(document, [], {}, new Set(), new Set([root]));
    expect(engine.get(root).color).toBe('rgba(0, 0, 0, 1)');
    expect(engine.get(document.body).color).toBe('rgba(0, 0, 0, 1)');
  } finally {window.happyDOM.close();}
});

test('page feature queries and live colors agree with inherited currentcolor painting inputs', async () => {
  const host = new RendererHost({timeout:20000});
  try {
    await host.start();
    await host.call('loadDocument', {
      url:'https://test.local/', contentType:'text/html',
      source:`<!doctype html><style>
        #parent { color:blue }
        #conditional { color:red }
        @supports (color:currentcolor) { #conditional { color:currentcolor } }
        @supports not (color:currentcolor) { #conditional { color:purple } }
      </style><div id="parent">
        <span id="child" style="color:red;border:1px solid currentcolor;text-decoration:underline currentcolor">text</span>
        <span id="conditional">conditional</span>
        <svg><rect id="shape" width="10" height="10" style="color:currentcolor;fill:currentcolor;stroke:currentcolor"/></svg>
      </div>`,
    });
    await host.call('whenLoaded');
    const result = await host.call('evaluate', `(() => {
      const parent = document.getElementById('parent'), child = document.getElementById('child');
      const color = getComputedStyle(child), shape = getComputedStyle(document.getElementById('shape'));
      const read = () => [color.color, color.borderTopColor, color.textDecorationColor, shape.fill, shape.stroke];
      const originalStyle = child.getAttribute('style');
      const supported = [CSS.supports('color','currentcolor'), CSS.supports('(color:CURRENTCOLOR)')];
      const unchanged = child.getAttribute('style') === originalStyle;
      const before = color.color;
      child.style.color = 'currentColor';
      const inherited = read();
      const conditional = getComputedStyle(document.getElementById('conditional')).color;
      parent.style.color = 'green';
      const updated = read();
      document.documentElement.style.color = 'red';
      const rootBefore = getComputedStyle(document.documentElement).color;
      document.documentElement.style.color = 'CURRENTCOLOR';
      const rootAfter = getComputedStyle(document.documentElement).color;
      return {supported, unchanged, before, inherited, conditional, updated, rootBefore, rootAfter};
    })()`);
    expect(result).toEqual({
      supported:[true,true], unchanged:true, before:'rgb(255, 0, 0)',
      inherited:Array(5).fill('rgb(0, 0, 255)'), conditional:'rgb(0, 0, 255)',
      updated:Array(5).fill('rgb(0, 128, 0)'),
      rootBefore:'rgb(255, 0, 0)', rootAfter:'rgb(0, 0, 0)',
    });
  } finally {await host.close();}
});
