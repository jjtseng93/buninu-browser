import { test, expect } from 'bun:test';
import { optionConstructor } from '../lib/renderer/option.js';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { RendererHost } from '../lib/renderer/host.js';

test('Option distinguishes missing arguments, text content and value attributes', () => {
  const { window, document } = parseHTMLDocument('');
  const Option = optionConstructor(document, { wrap: node => node }, window.HTMLOptionElement.prototype);
  try {
    for (const args of [[], [undefined, undefined], ['', ''], [null, null], [false, false], [0, 0]]) {
      const option = new Option(...args);
      const text = args[0] === undefined ? '' : String(args[0]);
      expect(option.textContent).toBe(text);
      expect(option.childNodes.length).toBe(text === '' ? 0 : 1);
      expect(option.getAttribute('value')).toBe(args[1] === undefined ? null : String(args[1]));
      expect(option.ownerDocument).toBe(document);
      expect(Object.getPrototypeOf(option)).toBe(window.HTMLOptionElement.prototype);
    }
    expect(Option.length).toBe(0);
    expect(() => Option()).toThrow(TypeError);
    expect(() => new Option(Symbol())).toThrow(TypeError);
    expect(() => new Option('', Symbol())).toThrow(TypeError);
    const order = [];
    new Option({ toString() { order.push('text'); return 'x'; } }, { toString() { order.push('value'); return 'y'; } });
    expect(order).toEqual(['text', 'value']);
    const sentinel = {};
    let thrown;
    try { new Option({ toString() { throw sentinel; } }); } catch (error) { thrown = error; }
    expect(thrown).toBe(sentinel);
  } finally { window.happyDOM.close(); }
});

test('Option initializes selectedness without making subsequent attribute changes ineffective', () => {
  const { window, document } = parseHTMLDocument('');
  const Option = optionConstructor(document, { wrap: node => node }, window.HTMLOptionElement.prototype);
  try {
    for (const defaultSelected of [false, true]) for (const selected of [false, true]) {
      const option = new Option('text', 'value', defaultSelected, selected);
      expect(option.hasAttribute('selected')).toBe(defaultSelected);
      expect(option.selected).toBe(selected);
      option.removeAttribute('selected');
      option.setAttribute('selected', '');
      expect(option.selected).toBeTrue();
      option.removeAttribute('selected');
      expect(option.selected).toBeFalse();
    }
    class SubOption extends Option {}
    const child = new SubOption();
    expect(Object.getPrototypeOf(child)).toBe(SubOption.prototype);
    expect(child instanceof SubOption).toBeTrue();
    expect(child instanceof window.HTMLOptionElement).toBeTrue();
    function Alternate() {}
    Alternate.prototype = null;
    expect(Object.getPrototypeOf(Reflect.construct(Option, [], Alternate))).toBe(Option.prototype);
    let prototypeReads = 0;
    const Target = new Proxy(SubOption, { get(target, key, receiver) {
      if (key === 'prototype') prototypeReads++;
      return Reflect.get(target, key, receiver);
    } });
    expect(Object.getPrototypeOf(Reflect.construct(Option, [], Target))).toBe(SubOption.prototype);
    expect(prototypeReads).toBe(1);
  } finally { window.happyDOM.close(); }
});

test('page Option uses the page interface prototype and works in select collections', async () => {
  const renderer = new RendererHost({ timeout: 20_000 });
  try {
    await renderer.start();
    await renderer.call('loadDocument', { url: 'https://page.test/', contentType: 'text/html', source: '<select></select>' });
    await renderer.call('whenLoaded');
    expect(await renderer.call('evaluate', `(()=>{
      const a=new Option('one','1'),b=new Option('two','2',false,true),s=document.querySelector('select');
      s.append(a,b);
      class SubOption extends Option {}
      const child=new SubOption();
      let callError=false,symbolError=false;
      try{Option()}catch(e){callError=e instanceof TypeError}
      try{new Option(Symbol())}catch(e){symbolError=e instanceof TypeError}
      return [Option.prototype===HTMLOptionElement.prototype,a instanceof HTMLOptionElement,
        Object.getPrototypeOf(a)===HTMLOptionElement.prototype,child instanceof SubOption,
        child instanceof HTMLOptionElement,child.ownerDocument===document,s.value,s.length,callError,symbolError];
    })()`)).toEqual([true, true, true, true, true, true, '2', 2, true, true]);
  } finally { await renderer.close(); }
}, 30_000);
