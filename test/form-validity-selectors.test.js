import { expect, test } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import * as PropertySymbol from '../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';
import { RendererHost } from '../lib/renderer/host.js';

test('validity selectors follow current input values without dispatching invalid events', () => {
  const { document } = parseHTMLDocument('<input required pattern="[A-Z]+"><div></div>');
  const input = document.querySelector('input');
  let invalid = 0;
  input.addEventListener('invalid', () => invalid++);
  expect(document.querySelectorAll(':invalid').length).toBe(1);
  input.value = 'ABC';
  expect(document.querySelector(':invalid')).toBeNull();
  expect(input.matches(':is(:valid)')).toBeTrue();
  input.value = 'a';
  expect(input.matches(':not(:valid)')).toBeTrue();
  expect(document.querySelectorAll(':invalid').length).toBe(1);
  input.disabled = true;
  expect(input.matches(':valid, :invalid')).toBeFalse();
  expect(document.querySelector('div').matches(':valid, :invalid')).toBeFalse();
  expect(invalid).toBe(0);
});

test('form validity includes external owners and excludes reassigned descendants', () => {
  const { document } = parseHTMLDocument('<form id="a"><input form="b" required></form><form id="b"></form><input form="a" value="ok" required>');
  const a = document.getElementById('a');
  const b = document.getElementById('b');
  expect(a.matches(':valid')).toBeTrue();
  expect(b.matches(':invalid')).toBeTrue();
  document.querySelector('input[form="a"]').value = '';
  expect(a.matches(':invalid')).toBeTrue();
});

test('disconnected fieldsets follow custom validity and option selection', () => {
  const { document } = parseHTMLDocument('<fieldset><input><select required multiple><option>one</option></select></fieldset>');
  const fieldset = document.querySelector('fieldset');
  const input = document.querySelector('input');
  const select = document.querySelector('select');
  expect(fieldset.matches(':invalid')).toBeTrue();
  fieldset.remove();
  select.firstElementChild.selected = true;
  expect(fieldset.matches(':valid')).toBeTrue();
  input.setCustomValidity('bad');
  expect(fieldset.matches(':invalid')).toBeTrue();
  input.setCustomValidity('');
  expect(fieldset.matches(':valid')).toBeTrue();
});

test('explicit form ownership stays inside the control tree', () => {
  const { document } = parseHTMLDocument('<form id="owner"></form><div id="host"></div>');
  const shadow = document.getElementById('host').attachShadow({ mode: 'open' });
  shadow.innerHTML = '<form id="owner"></form><input required form="owner">';
  expect(document.getElementById('owner').matches(':valid')).toBeTrue();
  expect(shadow.getElementById('owner').matches(':invalid')).toBeTrue();
});

test('ordinary selector caching and repeated validity matching remain stable', () => {
  const { document } = parseHTMLDocument('<fieldset><input required></fieldset>');
  const fieldset = document.querySelector('fieldset');
  const input = document.querySelector('input');
  expect(fieldset.matches(':invalid')).toBeTrue();
  const ordinary = document.querySelectorAll('input');
  for (let i = 0; i < 100; i++) {
    expect(fieldset.matches(':invalid')).toBeTrue();
    expect(document.querySelectorAll('input') === ordinary).toBeTrue();
  }
  input.value = 'ok';
  expect(fieldset.matches(':valid')).toBeTrue();
});

test('repeated validity queries reuse cache records and release their old root links', () => {
  const { document } = parseHTMLDocument('<fieldset><input required></fieldset>');
  const fieldset = document.querySelector('fieldset');
  const input = document.querySelector('input');
  fieldset.matches(':invalid');
  const before = document[PropertySymbol.affectsCache].length;
  for (let i = 0; i < 200; i++) fieldset.matches(':invalid');
  expect(document[PropertySymbol.affectsCache].length).toBe(before);
  for (let i = 0; i < 200; i++) {
    input.value = i % 2 ? 'ok' : '';
    expect(fieldset.matches(':valid')).toBe(Boolean(i % 2));
  }
  expect(document[PropertySymbol.affectsCache].length).toBeLessThan(10);
});

test('rendered form and fieldset validity restyles after state, type and owner changes', async () => {
  const renderer = new RendererHost({ timeout: 20_000 });
  try {
    await renderer.start();
    await renderer.call('resize', 400, 300, 1);
    await renderer.call('loadDocument', {
      url: 'https://page.test/', contentType: 'text/html', status: 200,
      source: '<style>form:valid,fieldset:valid{color:green}form:invalid,fieldset:invalid{color:red}fieldset:invalid .label{background-color:red}</style><form id="a"><fieldset id="f"><input id="i" type="text" min="8" value="4"><span class="label"></span></fieldset></form><form id="b"></form><input id="external" form="a" value="ok" required>',
    });
    await renderer.call('whenLoaded');
    const colors = () => renderer.call('evaluate', 'JSON.stringify(["a","b","f"].map(id=>getComputedStyle(document.getElementById(id)).color))');
    expect(await colors()).toBe('["rgb(0, 128, 0)","rgb(0, 128, 0)","rgb(0, 128, 0)"]');
    await renderer.call('evaluate', 'document.getElementById("i").type="number"');
    expect(await colors()).toBe('["rgb(255, 0, 0)","rgb(0, 128, 0)","rgb(255, 0, 0)"]');
    expect(await renderer.call('evaluate', 'getComputedStyle(document.querySelector(".label")).backgroundColor')).toBe('rgb(255, 0, 0)');
    await renderer.call('evaluate', 'document.getElementById("i").value="9"');
    expect(await colors()).toBe('["rgb(0, 128, 0)","rgb(0, 128, 0)","rgb(0, 128, 0)"]');
    await renderer.call('evaluate', 'document.getElementById("external").value="";document.getElementById("external").setAttribute("form","b")');
    expect(await colors()).toBe('["rgb(0, 128, 0)","rgb(255, 0, 0)","rgb(0, 128, 0)"]');
  } finally { renderer.close(); }
}, 30_000);

test('radio peers and disabled fieldset descendants restyle when shared validity changes', async () => {
  const renderer = new RendererHost({ timeout: 20_000 });
  try {
    await renderer.start();
    await renderer.call('resize', 400, 300, 1);
    await renderer.call('loadDocument', {
      url: 'https://page.test/', contentType: 'text/html', status: 200,
      source: '<style>input{color:black}input:valid{color:green}input:invalid{color:red}</style><form><input id="a" type="radio" name="x" required><input id="b" type="radio" name="x" required></form><fieldset id="f" disabled><legend id="first"><input id="one" required></legend><legend id="second"><input id="two" required></legend><input id="three" required></fieldset>',
    });
    await renderer.call('whenLoaded');
    const colors = ids => renderer.call('evaluate', `JSON.stringify(${JSON.stringify(ids)}.map(id=>getComputedStyle(document.getElementById(id)).color))`).then(JSON.parse);
    const red = 'rgb(255, 0, 0)', green = 'rgb(0, 128, 0)', black = 'rgb(0, 0, 0)';
    expect(await colors(['a', 'b'])).toEqual([red, red]);
    await renderer.call('evaluate', 'document.getElementById("a").checked=true');
    expect(await colors(['a', 'b'])).toEqual([green, green]);
    await renderer.call('evaluate', 'document.getElementById("a").checked=false');
    expect(await colors(['a', 'b'])).toEqual([red, red]);
    await renderer.call('evaluate', 'document.getElementById("a").checked=true;document.getElementById("a").name="y"');
    expect(await colors(['a', 'b'])).toEqual([green, red]);
    await renderer.call('evaluate', 'document.getElementById("a").name="x"');
    expect(await colors(['a', 'b'])).toEqual([green, green]);
    expect(await colors(['one', 'two', 'three'])).toEqual([red, black, black]);
    await renderer.call('evaluate', 'document.getElementById("f").disabled=false');
    expect(await colors(['one', 'two', 'three'])).toEqual([red, red, red]);
    await renderer.call('evaluate', 'document.getElementById("f").disabled=true');
    expect(await colors(['one', 'two', 'three'])).toEqual([red, black, black]);
    await renderer.call('evaluate', 'document.getElementById("f").insertBefore(document.getElementById("second"),document.getElementById("first"))');
    expect(await colors(['one', 'two', 'three'])).toEqual([black, red, black]);
  } finally { renderer.close(); }
}, 30_000);
