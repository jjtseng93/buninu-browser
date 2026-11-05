import { test, expect } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { isEventTrusted } from '../lib/happy-dom/event-state.js';
import { BindingRealm, installTextSelectionAccessors } from '../lib/renderer/bindings.js';
import { RendererHost } from '../lib/renderer/host.js';

const selection = element => [element.selectionStart, element.selectionEnd, element.selectionDirection];
const settle = () => new Promise(resolve => setTimeout(resolve, 15));

test('selection state follows API values, default text mutations, type changes, clone and reset', () => {
  const { window, document } = parseHTMLDocument('<form><input value="abc"><textarea>abc</textarea></form>');
  try {
    for (const element of document.querySelectorAll('input,textarea')) {
      expect(selection(element)).toEqual([0, 0, 'none']);
      element.value = 'abcdef';expect(selection(element)).toEqual([6, 6, 'none']);
      element.setSelectionRange(1, 4, 'backward');
      element.value = 'abcdef';expect(selection(element)).toEqual([1, 4, 'backward']);
      element.value = 'abc\ndef';
      expect(selection(element)).toEqual(element.localName === 'input' ? [1, 4, 'backward'] : [7, 7, 'none']);
      expect(selection(element.cloneNode(true))).toEqual([0, 0, 'none']);
      element.value = 'reset-from-different';document.querySelector('form').reset();
      expect(selection(element)).toEqual([3, 3, 'none']);
      element.value = {toString() { element.value = 'xyz';element.setSelectionRange(0, 1, 'backward');return 'xyz'; }};
      expect(selection(element)).toEqual([0, 1, 'backward']);
      element.selectionStart = -1;expect(selection(element).slice(0, 2)).toEqual([3, 3]);
      element.selectionEnd = 2 ** 32;expect(selection(element).slice(0, 2)).toEqual([0, 0]);
    }
    const area = document.createElement('textarea');area.textContent = 'abcdef';area.setSelectionRange(2, 5);
    const text = area.firstChild;text.remove();area.append(text);
    expect(selection(area)).toEqual([0, 0, 'none']);
    area.setSelectionRange(2, 5);text.data = 'a';expect(selection(area).slice(0, 2)).toEqual([1, 1]);
    const input = document.querySelector('input');input.value = 'https://example.com   ';input.type = 'url';
    expect(input.value).toBe('https://example.com');expect(input.selectionEnd).toBe(input.value.length);
    input.type = 'number';expect(input.selectionStart).toBeNull();input.type = 'text';
    expect(selection(input)).toEqual([0, 0, 'none']);
  } finally { window.happyDOM.close(); }
});

test('selection events are queued, trusted, change-sensitive and owner-window cancellable', async () => {
  const { window, document } = parseHTMLDocument('<input value="abcdef"><textarea>abcdef</textarea>');
  try {
    for (const element of document.querySelectorAll('input,textarea')) {
      const events = [];
      element.addEventListener('select', event => events.push([isEventTrusted(event), event.bubbles, event.cancelable]));
      element.setSelectionRange(0, 3);element.setSelectionRange(0, 3);
      expect(events).toEqual([]);await settle();expect(events).toEqual([[true, true, false]]);
      events.length = 0;
      element.setRangeText('XYZ', 0, 3, 'select');await settle();expect(events).toEqual([]);
      element.setSelectionRange(0, 3, 'backward');await settle();events.length = 0;
      element.setRangeText('abc', 0, 3, 'select');await settle();expect(events.length).toBe(1);
      events.length = 0;element.value = 'abcdef';await settle();expect(events).toEqual([]);
      element.setSelectionRange(0, 1);element.setSelectionRange(1, 2);await settle();expect(events.length).toBe(2);
    }
    let calls = 0;const element = document.createElement('input');element.value = 'abc';
    element.addEventListener('select', () => calls++);element.setSelectionRange(0, 1);
    window.happyDOM.close();await settle();expect(calls).toBe(0);
  } finally { window.happyDOM.close(); }
});

test('setRangeText uses UTF-16 replacement length, preserve offsets and does not dispatch input/change', async () => {
  const { window, document } = parseHTMLDocument('<input><textarea></textarea>');
  try {
    for (const element of document.querySelectorAll('input,textarea')) {
      let inputEvents = 0;element.oninput = element.onchange = () => inputEvents++;
      element.value = 'abcdef';element.setSelectionRange(1, 5, 'backward');
      element.setRangeText('😀', 2, 4);
      expect([element.value, ...selection(element)]).toEqual(['ab😀ef', 1, 5, 'none']);
      element.value = 'abc';element.setRangeText('\r\n', 0, 1, 'select');
      expect([element.value, ...selection(element)]).toEqual([element.localName === 'textarea' ? '\nbc' : 'bc', 0, 2, 'none']);
      expect(() => element.setRangeText('a', 2, 1)).toThrow('Start exceeds end');
      expect(() => element.setRangeText('a', 1)).toThrow();
      expect(() => element.setRangeText('a', 0, 1, null)).toThrow();
      await settle();expect(inputEvents).toBe(0);
    }
    const pristine = document.createElement('textarea');pristine.defaultValue = 'abc';
    expect(() => pristine.setRangeText('x', 2, 1)).toThrow();pristine.defaultValue = 'changed';
    expect(pristine.value).toBe('abc');
  } finally { window.happyDOM.close(); }
});

test('selection binding validates receiver and converts overloads in defining realm before reading state', () => {
  class PageTypeError extends TypeError {}
  const {window,document} = parseHTMLDocument('<input><textarea></textarea>');
  const realm = new BindingRealm(window, {touch() {}});
  realm.inputValueIntrinsics = { TypeError: PageTypeError, DOMException: window.DOMException };
  const prototypes = new Map([['HTMLInputElement', {}], ['HTMLTextAreaElement', {}]]);
  installTextSelectionAccessors(prototypes, realm);
  try {
    const input = document.querySelector('input'), wrapper = realm.wrap(input), proto = prototypes.get('HTMLInputElement');
    const start = Object.getOwnPropertyDescriptor(proto, 'selectionStart');
    for (const receiver of [{}, null, prototypes.get('HTMLInputElement'), new Proxy(wrapper, {}), realm.wrap(document.createElement('div')), realm.wrap(document.createElement('textarea'))]) {
      expect(() => start.get.call(receiver)).toThrow(PageTypeError);
      expect(() => proto.setRangeText.call(receiver, {toString(){throw Error('must not convert')}})).toThrow(PageTypeError);
    }
    let conversions = 0;const replacement = {toString(){conversions++;return 'x'}};
    expect(() => proto.setRangeText.call(wrapper, replacement, 0)).toThrow(PageTypeError);expect(conversions).toBe(0);
    for (const value of [Symbol(), 1n, Object(1n)]) expect(() => start.set.call(wrapper, value)).toThrow(PageTypeError);
    input.type = 'number';
    expect(() => proto.setRangeText.call(wrapper, 'x', 0, 1, null)).toThrow(PageTypeError);
    expect(() => proto.setSelectionRange.call(wrapper, 0, 1)).toThrow('This input type');
    const order=[];input.type='text';input.value='abcdef';
    proto.setRangeText.call(wrapper,
      {toString(){order.push('text');return 'X'}},
      {valueOf(){order.push('start');return 1}},
      {valueOf(){order.push('end');return 3}},
      {toString(){order.push('mode');input.value='uvwxyz';return 'select'}});
    expect(order).toEqual(['text','start','end','mode']);expect(input.value).toBe('uXxyz');expect(selection(input)).toEqual([1,2,'none']);
    proto.setRangeText.call(wrapper,{toString(){input.setSelectionRange(2,4);return 'Y'}});
    expect(input.value).toBe('uXYz');
    expect([proto.select.length,proto.setSelectionRange.length,proto.setRangeText.length]).toEqual([0,2,1]);
  } finally { window.happyDOM.close(); }
});

test('page selection APIs share keyboard, clipboard and rendered control text', async () => {
  let clipboard = '';
  const host = new RendererHost({clipboardRead:async()=>clipboard,clipboardWrite:async value=>{clipboard=value}});
  const run = source => host.call('evaluate', source);
  try {
    await host.start();
    await host.call('loadDocument', {url:'https://selection.test/',contentType:'text/html',source:'<input id=i value="abcdef"><textarea id=t>uvwxyz</textarea>'});
    await host.call('whenLoaded');
    await host.call('press','Shift');
    await run(`window.i=document.getElementById('i');window.t=document.getElementById('t');i.select();document.execCommand('copy')`);
    for (let i=0;i<20&&clipboard!=='abcdef';i++) await settle();
    expect(clipboard).toBe('abcdef');
    await run(`i.setSelectionRange(1,4,'backward')`);await host.call('type','😀');
    expect(await run(`[i.value,i.selectionStart,i.selectionEnd]`)).toEqual(['a😀ef',3,3]);
    await host.call('press','Shift');await run(`t.select();document.execCommand('copy')`);
    for (let i=0;i<20&&clipboard!=='uvwxyz';i++) await settle();
    expect(clipboard).toBe('uvwxyz');
    const before = await host.call('screenshot', {format:'png'});
    await run(`t.setRangeText('PAINT',1,5,'select')`);
    expect(await run(`[t.value,t.selectionStart,t.selectionEnd]`)).toEqual(['uPAINTz',1,6]);
    const screenshot = await host.call('screenshot', {format:'png'});
    expect(screenshot).not.toBe(before);
    await run(`t.value='uPAINTz';t.setSelectionRange(1,6)`);
    expect(await host.call('screenshot', {format:'png'})).toBe(screenshot);
    clipboard = 'paste';await host.call('press','v',{modifiers:2});
    await new Promise(resolve=>setTimeout(resolve,40));
    expect(await run(`[t.value,t.selectionStart,t.selectionEnd]`)).toEqual(['upastez',6,6]);
    expect(await run(`(()=>{try { i.setSelectionRange(1n,2);return false }catch(e){return e instanceof TypeError}})()`)).toBeTrue();
  } finally { await host.close(); }
}, 30000);
