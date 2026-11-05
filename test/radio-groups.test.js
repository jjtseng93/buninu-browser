import { test, expect } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';

test('radio validity counts the entire group and excludes non-radio and other form owners', () => {
  const { window, document } = parseHTMLDocument('<form id="a"><input id="one" type="radio" name="group" required disabled><input id="two" type="radio" name="group"><input type="checkbox" name="group" checked></form><form id="b"><input type="radio" name="group" checked></form><input id="external" type="radio" name="group" form="a">');
  try {
    const one = document.getElementById('one'), two = document.getElementById('two'), external = document.getElementById('external');
    expect([one, two, external].map(input => input.validity.valueMissing)).toEqual([true, true, true]);
    external.checked = true;
    expect([one, two, external].map(input => input.validity.valueMissing)).toEqual([false, false, false]);
    expect(document.querySelector('#b input').checked).toBeTrue();
    external.setAttribute('form', 'b');
    expect(document.querySelector('#b input').checked).toBeFalse();
    expect(two.validity.valueMissing).toBeTrue();
  } finally { window.happyDOM.close(); }
});

test('radio names are literal strings and empty names do not form groups', () => {
  const { window, document } = parseHTMLDocument('<input type="radio"><input type="radio"><input type="radio">');
  try {
    const [a, b, c] = document.querySelectorAll('input');
    a.name = b.name = 'a"]\\\n';
    a.required = true;
    b.checked = true;
    expect(a.validity.valueMissing).toBeFalse();
    a.checked = true;
    expect(b.checked).toBeFalse();
    a.name = b.name = '';
    b.checked = true;
    c.checked = true;
    expect([a.checked, b.checked, c.checked]).toEqual([true, true, true]);
  } finally { window.happyDOM.close(); }
});

test('radio grouping and constraints only use null-namespace HTML attributes', () => {
  const { window, document } = parseHTMLDocument('<form id="a"><input type="radio" name="x"><input type="radio" name="x"></form><form id="b"><input type="radio" name="x"></form>');
  try {
    const [a, b, c] = document.querySelectorAll('input');
    a.setAttributeNS('urn:test', 'required', '');
    expect(a.validity.valueMissing).toBeFalse();
    a.setAttributeNS(null, 'required', '');
    expect(b.validity.valueMissing).toBeTrue();
    a.setAttributeNS('urn:test', 'form', 'b');
    a.setAttributeNS('urn:test', 'name', 'other');
    b.checked = true;
    expect(a.validity.valueMissing).toBeFalse();
    c.checked = true;
    expect(b.checked).toBeTrue();
    b.removeAttributeNS(null, 'name');
    b.setAttributeNS('urn:test', 'name', 'x');
    a.checked = true;
    expect(b.checked).toBeTrue();
    expect(c.checked).toBeTrue();
  } finally { window.happyDOM.close(); }
});

test('radio checkedness follows type/name changes and connected insertion', () => {
  const { window, document } = parseHTMLDocument('<input id="a" type="radio" name="x" checked><input id="b" name="x" checked>');
  try {
    const a = document.getElementById('a'), b = document.getElementById('b');
    b.type = 'radio';
    expect(a.checked).toBeFalse();
    a.checked = true;
    expect(b.checked).toBeFalse();
    b.name = 'y'; b.checked = true; b.name = 'x';
    expect(a.checked).toBeFalse();
    const c = document.createElement('input');
    c.type = 'radio'; c.name = 'x'; c.checked = true;
    document.body.append(c);
    expect(b.checked).toBeFalse();
    expect(c.checked).toBeTrue();
  } finally { window.happyDOM.close(); }
});

test('disconnected radios with a form attribute use their nearest ancestor form', () => {
  const { window, document } = parseHTMLDocument('<form id="external"></form>');
  try {
    const form = document.createElement('form');
    form.innerHTML = '<input type="radio" name="x" checked required><input type="radio" name="x" form="external">';
    const [a, b] = form.querySelectorAll('input');
    b.checked = true;
    expect(a.checked).toBeFalse();
    expect(a.validity.valueMissing).toBeFalse();
    document.body.append(form);
    expect(a.validity.valueMissing).toBeTrue();
    expect(document.getElementById('external').matches(':valid')).toBeTrue();
    a.checked = true;
    expect(b.checked).toBeTrue();
    b.setAttribute('form', 'missing');
    expect(b.checked).toBeTrue();
    expect(a.checked).toBeTrue();
    a.checked = false;
    expect(a.validity.valueMissing).toBeTrue();
    expect(b.validity.valueMissing).toBeFalse();
  } finally { window.happyDOM.close(); }
});

test('canceled radio clicks restore the previous checked group member', () => {
  const { window, document } = parseHTMLDocument('<input type="radio" name="x" checked><input type="radio" name="x">');
  try {
    const [a, b] = document.querySelectorAll('input');
    const events = [];
    b.addEventListener('click', event => { events.push('click'); expect(a.checked).toBeFalse(); expect(b.checked).toBeTrue(); event.preventDefault(); });
    b.addEventListener('input', () => events.push('input'));
    b.addEventListener('change', () => events.push('change'));
    b.click();
    expect([a.checked, b.checked]).toEqual([true, false]);
    expect(events).toEqual(['click']);
  } finally { window.happyDOM.close(); }
});

test('radio attribute updates respect checked dirtiness, and checkbox behavior remains intact', () => {
  const { window, document } = parseHTMLDocument('<input type="radio" name="x" checked><input type="radio" name="x"><input type="checkbox">');
  try {
    const [a, b, checkbox] = document.querySelectorAll('input');
    b.defaultChecked = true;
    expect([a.checked, b.checked]).toEqual([false, true]);
    a.defaultChecked = false; a.defaultChecked = true;
    expect([a.checked, b.checked]).toEqual([true, false]);
    a.checked = false; a.defaultChecked = false; a.defaultChecked = true;
    expect(a.checked).toBeFalse();
    checkbox.click(); expect(checkbox.checked).toBeTrue();
    checkbox.click(); expect(checkbox.checked).toBeFalse();
  } finally { window.happyDOM.close(); }
});

test('radio activation emits non-cancelable input/change after the click', () => {
  const { window, document } = parseHTMLDocument('<input type="radio">');
  try {
    const input = document.querySelector('input'), events = [];
    for (const type of ['click', 'input', 'change']) input.addEventListener(type, event => events.push({
      type: event.type, bubbles: event.bubbles,
      composed: event.composed, cancelable: event.cancelable,
    }));
    input.click();
    expect(events).toEqual([
      { type: 'click', bubbles: true, composed: true, cancelable: true },
      { type: 'input', bubbles: true, composed: true, cancelable: false },
      { type: 'change', bubbles: true, composed: false, cancelable: false },
    ]);
    input.click();
    expect(events.map(event => event.type)).toEqual(['click', 'input', 'change', 'click']);
  } finally { window.happyDOM.close(); }
});
