import { test, expect } from 'bun:test';
import { parseHTMLDocument } from '../lib/happy-dom/parser.js';

test('barred controls neither match validity pseudo-classes nor block validation', () => {
  const { window, document } = parseHTMLDocument('<form><fieldset disabled><input required><select required><option value="">empty</option></select><textarea required></textarea><button>submit</button></fieldset><button type="button"></button><button type="reset"></button><datalist><input required></datalist></form>');
  try {
    const controls = document.querySelectorAll('input,select,textarea,button');
    let invalid = 0;
    for (const control of controls) {
      control.setCustomValidity('custom error');
      control.addEventListener('invalid', () => invalid++);
      expect(control.willValidate).toBeFalse();
      expect(control.validity.customError).toBeTrue();
      expect(control.matches(':valid, :invalid')).toBeFalse();
      expect(control.checkValidity()).toBeTrue();
      expect(control.reportValidity()).toBeTrue();
      expect(control.validationMessage).toBe('');
    }
    expect(document.querySelector('form').matches(':valid')).toBeTrue();
    expect(document.querySelector('fieldset').matches(':valid')).toBeTrue();
    expect(document.querySelector('form').checkValidity()).toBeTrue();
    expect(invalid).toBe(0);
  } finally { window.happyDOM.close(); }
});

test('disabled fieldsets exempt their first legend only and update dynamically', () => {
  const { window, document } = parseHTMLDocument('<fieldset disabled><div></div><legend id="first"><input required></legend><legend id="second"><input required></legend><input required></fieldset>');
  try {
    const fieldset = document.querySelector('fieldset');
    const [first, second, outside] = document.querySelectorAll('input');
    expect([first, second, outside].map(control => control.willValidate)).toEqual([true, false, false]);
    expect(fieldset.matches(':invalid')).toBeTrue();
    first.value = 'ok';
    expect(fieldset.matches(':valid')).toBeTrue();
    fieldset.insertBefore(document.getElementById('second'), document.getElementById('first'));
    expect([first, second, outside].map(control => control.willValidate)).toEqual([false, true, false]);
    expect(fieldset.matches(':invalid')).toBeTrue();
    fieldset.disabled = false;
    expect([first, second, outside].map(control => control.willValidate)).toEqual([true, true, true]);
  } finally { window.happyDOM.close(); }
});

test('nested disabled fieldsets require exemption from every ancestor', () => {
  const { window, document } = parseHTMLDocument('<fieldset disabled><legend><fieldset disabled><legend><input id="exempt"></legend><input id="inner"></fieldset></legend><fieldset disabled><legend><input id="outer"></legend></fieldset></fieldset>');
  try {
    expect(document.getElementById('exempt').willValidate).toBeTrue();
    expect(document.getElementById('inner').willValidate).toBeFalse();
    expect(document.getElementById('outer').willValidate).toBeFalse();
  } finally { window.happyDOM.close(); }
});

test('datalist ancestry crosses foreign elements but stops at shadow roots', () => {
  const { window, document } = parseHTMLDocument('<datalist id="list"></datalist><fieldset disabled id="field"></fieldset>');
  try {
    const input = document.createElement('input');
    const foreign = document.createElementNS('urn:test', 'field');
    foreign.append(input);
    document.getElementById('list').append(foreign);
    expect(input.willValidate).toBeFalse();
    foreign.remove();
    expect(input.willValidate).toBeTrue();
    const foreignDatalist = document.createElementNS('urn:test', 'datalist');
    foreignDatalist.append(input);
    expect(input.willValidate).toBeTrue();
    const host = document.createElement('div');
    document.getElementById('field').append(host);
    host.attachShadow({ mode: 'open' }).append(input);
    expect(input.willValidate).toBeTrue();
  } finally { window.happyDOM.close(); }
});
