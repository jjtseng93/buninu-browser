import {test, expect} from 'bun:test';
import {normalizeAnimationEnum as normalize, animationEnumValue} from '../lib/style/animation-enum-values.js';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine, parseDeclarations, supportsDeclaration} from '../lib/style/computed-style.js';

const duration = 'animation-duration', delay = 'animation-delay', count = 'animation-iteration-count';
test('numeric animation longhands validate typed values before replacing declarations', () => {
  const {window, document} = parseHTMLDocument('<div></div>');
  try {
    const style = document.querySelector('div').style;
    for (const [name, valid, invalid] of [
      [duration, '500ms', ['-3s', '0', 'infinite', '1s 2s', 'initial, 1s', '1s, initial', '1px', '1%', '(1s)', '"1s"']],
      [delay, '-5ms', ['infinite', '0', '1s 2s 3s', 'initial, -3s', '-3s, initial', '1px']],
      [count, '4.5', ['auto', '-2', '3 4', 'initial, 4', '4, initial', '4s', '2%', '(2)']],
    ]) {
      for (const value of invalid) {
        style.setProperty(name, valid);
        style.setProperty(name, value);
        expect(style.getPropertyValue(name)).toBe(valid);
        expect(supportsDeclaration(name, value)).toBeFalse();
        expect(parseDeclarations(`${name}:${valid};${name}:${value}`).get(name).value).toBe(valid);
      }
      expect(supportsDeclaration(name, valid)).toBeTrue();
      expect(supportsDeclaration(name, 'var(--timing)')).toBeTrue();
    }
    expect(normalize(duration, String.raw`1e2M\53 , .5S`)).toBe('100ms, 0.5s');
    expect(normalize(delay, ' -0s/**/, +2e-1s ')).toBe('0s, 0.2s');
    expect(normalize(count, 'INFINITE, 2.5e1, 0')).toBe('infinite, 25, 0');
    expect(normalize(duration, 'AUTO')).toBe('auto');
    expect(normalize(duration, 'INHERIT')).toBe('inherit');
  } finally {window.happyDOM.close();}
});

test('animation calculations preserve CSS types, operator whitespace and range semantics', () => {
  for (const [name, value, expected] of [
    [duration, 'calc(2 * 3s)', 'calc(6s)'], [duration, 'calc(-3s)', 'calc(-3s)'],
    [duration, 'max(1s, 500ms)', 'calc(1s)'], [delay, 'min(-1s, -500ms)', 'calc(-1s)'],
    [duration, 'clamp(1s, 5s, 3s)', 'calc(3s)'], [duration, 'round(up, 1.2s, 1s)', 'calc(2s)'],
    [duration, 'calc(1s * (2s / 1s))', 'calc(2s)'], [count, 'calc(3 * 2)', 'calc(6)'],
    [duration, 'calc(sign(2px - 10px) * 2s)', 'calc(-2s)'],
  ]) {
    expect(normalize(name, value)).toBe(expected);
    expect(supportsDeclaration(name, value)).toBeTrue();
  }
  for (const [name, values] of [
    [duration, ['calc(1s + 1px)', 'calc(1s+ 2s)', 'calc(1s +2s)', 'calc(1s/**/+/**/2s)', 'calc(1s / 1s)', 'calc(2)', 'min(1s,)', 'min(1s, 2px)', 'calc(1s, 2s)', 'round(up 1s, 1s)']],
    [count, ['calc(1s)', 'calc(2%)', 'calc(2 + 1s)']],
  ]) for (const value of values) expect(normalize(name, value)).toBeNull();
  // Relative math stays parseable until the engine has its container context.
  const relative = 'calc(10s + (sign(2cqw - 10px) * 5s))';
  expect(normalize(duration, relative)).toBe(relative);
  expect(normalize(duration, 'calc(' + '('.repeat(140) + '1s' + ')'.repeat(140) + ')')).toBeNull();
});

test('computed animation values use seconds, inherit and reset correctly after substitution', () => {
  const {window, document} = parseHTMLDocument(`<div id="parent" style="animation-duration:500ms;animation-delay:-250ms;animation-iteration-count:2.5"><div id="child" style="animation-duration:inherit;animation-delay:inherit;animation-iteration-count:inherit"></div></div><div id="math" style="animation-duration:calc(2 * 3s);animation-delay:calc(1s - 2s);animation-iteration-count:calc(2 * 3)"></div><div id="bad" style="animation:move 1s 2s 3;animation-duration:var(--bad);--bad:-2s;animation-delay:initial;animation-iteration-count:unset"></div><div id="negative" style="animation-duration:calc(-2s);animation-iteration-count:calc(-3)"></div>`);
  try {
    const engine = new StyleEngine().compute(document);
    const values = id => [duration, delay, count].map(name => animationEnumValue(engine.get(document.getElementById(id)), name));
    expect(values('child')).toEqual(['0.5s', '-0.25s', '2.5']);
    expect(values('math')).toEqual(['6s', '-1s', '6']);
    expect(engine.get(document.getElementById('math')).cssAnimationLonghands).toEqual({duration:['6s'],delay:['-1s'],iterationCount:['6']});
    expect(values('bad')).toEqual(['0s', '0s', '1']);
    expect(values('negative')).toEqual(['0s', '0s', '0']);
  } finally {window.happyDOM.close();}
});
