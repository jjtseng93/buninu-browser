import { test, expect } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';
import { isEventTrusted } from '../lib/happy-dom/event-state.js';
import { RendererHost } from '../lib/renderer/host.js';

test('reset dispatches before changing controls, honors cancelation and prevents reentry', () => {
  const { window, document } = parseHTMLDocument('<form><input value="default"></form>');
  try {
    const form = document.querySelector('form'), input = document.querySelector('input');
    input.value = 'edited';
    let resets = 0, changes = 0;
    form.addEventListener('input', () => changes++);
    form.addEventListener('change', () => changes++);
    const cancel = event => {
      resets++;
      expect(input.value).toBe('edited');
      expect([event.bubbles, event.cancelable, event.composed, isEventTrusted(event)]).toEqual([true, true, false, true]);
      form.reset();
      event.preventDefault();
    };
    form.addEventListener('reset', cancel);
    expect(form.reset()).toBeUndefined();
    expect(input.value).toBe('edited');
    expect(resets).toBe(1);
    form.removeEventListener('reset', cancel);
    form.reset();
    expect(input.value).toBe('default');
    expect(changes).toBe(0);
  } finally { window.happyDOM.close(); }
});

test('reset restores dirty values, radio groups, multiple selects and output default mode', () => {
  const { window, document } = parseHTMLDocument('<form><input value="old"><input type="radio" name="x" checked><input type="radio" name="x" checked><input type="checkbox" checked><textarea>old</textarea><select multiple><option selected>a</option><option selected>b</option><option>c</option></select><select><option>a</option><option selected>b</option><option selected>c</option></select><output>original</output><input type="file"></form>');
  try {
    const form = document.querySelector('form'), [input, a, b, checkbox, file] = document.querySelectorAll('input');
    const textarea = document.querySelector('textarea'), [multiple, single] = document.querySelectorAll('select'), output = document.querySelector('output');
    input.value = textarea.value = 'edited'; a.checked = true; checkbox.checked = false;
    for (const option of multiple.options) option.selected = option.textContent === 'c';
    single.value = 'a';
    output.value = 'result'; output.textContent = 'changed result';
    expect(output.defaultValue).toBe('original');
    file.files = [new window.File(['file'], 'one.txt')];
    form.reset();
    expect([input.value, textarea.value]).toEqual(['old', 'old']);
    expect([a.checked, b.checked, checkbox.checked]).toEqual([false, true, true]);
    expect([...multiple.options].map(option => option.selected)).toEqual([true, true, false]);
    expect([multiple.selectedIndex, single.selectedIndex, single.value]).toEqual([0, 2, 'c']);
    expect([output.value, output.defaultValue]).toEqual(['original', 'original']);
    expect(file.files.length).toBe(0);
    input.defaultValue = textarea.defaultValue = 'new default';
    checkbox.defaultChecked = false;
    multiple.options[0].defaultSelected = false;
    expect([input.value, textarea.value, checkbox.checked, multiple.selectedIndex]).toEqual(['new default', 'new default', false, 1]);
    output.textContent = 'new default';
    expect(output.defaultValue).toBe('new default');
    output.value = 'result'; output.defaultValue = 'replacement';
    expect(output.value).toBe('result');
    form.reset();
    expect(output.value).toBe('replacement');
  } finally { window.happyDOM.close(); }
});

test('reset resolves external form owners after reset handlers run', () => {
  const { window, document } = parseHTMLDocument('<form id="a"><input id="inside" value="default" form="b"></form><form id="b"></form><input id="outside" value="default" form="a"><input id="other" value="default" form="b">');
  try {
    const form = document.getElementById('a'), inside = document.getElementById('inside'), outside = document.getElementById('outside'), other = document.getElementById('other');
    for (const input of [inside, outside, other]) input.value = 'edited';
    form.addEventListener('reset', () => other.setAttribute('form', 'a'));
    form.reset();
    expect([inside.value, outside.value, other.value]).toEqual(['edited', 'default', 'default']);
  } finally { window.happyDOM.close(); }
});

test('page form.reset exposes the HTML API and updates rendered validity without input/change', async () => {
  const renderer = new RendererHost({ timeout: 20_000 });
  try {
    await renderer.start();
    await renderer.call('loadDocument', { url: 'https://page.test/', contentType: 'text/html', source: '<style>input:invalid{color:red}input:valid{color:green}</style><form><input required><input type="checkbox"><select multiple><option>one</option></select></form><div></div>' });
    await renderer.call('whenLoaded');
    expect(await renderer.call('evaluate', `(()=>{
      const form=document.querySelector('form'), input=document.querySelector('input'), checkbox=document.querySelector('input[type="checkbox"]'), option=document.querySelector('option');
      input.value='edited';checkbox.defaultChecked=true;option.defaultSelected=true;
      let events=[]; form.onreset=e=>events.push([input.value,e.isTrusted]);
      form.oninput=form.onchange=()=>events.push('unexpected');
      const before=getComputedStyle(input).color;
      form.reset();
      return [typeof document.querySelector('div').reset,before,input.value,getComputedStyle(input).color,checkbox.checked,option.selected,events];
    })()`)).toEqual(['undefined','rgb(0, 128, 0)','','rgb(255, 0, 0)',true,true,[['edited',true]]]);
  } finally { await renderer.close(); }
}, 30_000);
