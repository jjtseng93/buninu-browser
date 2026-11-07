import {expect, test} from 'bun:test';
import {parseHTMLDocument} from '../lib/happy-dom/parser.js';
import {StyleEngine} from '../lib/style/computed-style.js';

test('setter values and normalized properties keep per-element variables and inherited font bases', () => {
  const {document, window} = parseHTMLDocument('<main id="parent"><div id="box"></div></main>');
  try {
    const parent = document.getElementById('parent'), box = document.getElementById('box');
    const sheets = ['#parent{font-size:20px;color:rgb(12,34,56);line-height:1.25;font-weight:600}',
      '#box{font-size:var(--size);color:inherit;line-height:inherit;width:3em;'
      + 'padding-inline:1em 2em;direction:rtl;transform:translate(1em,2em);z-index:7;opacity:var(--alpha)}'];
    for (const [size, expected] of [['2em',40], ['10px',10], ['2em',40]]) {
      parent.style.setProperty('--size', size);
      parent.style.setProperty('--alpha', 'calc(50% + 25%)');
      const style = new StyleEngine().compute(document, sheets).get(box);
      expect(style).toMatchObject({fontSize:expected, fontWeight:600, color:'rgba(12, 34, 56, 1)',
        lineHeightFactor:1.25, lineHeight:expected * 1.25, width:expected * 3, zIndex:7, opacity:0.75,
        direction:'rtl', transform:{x:expected,y:expected * 2}});
      expect(style.padding).toEqual([0,expected,0,expected * 2]);
    }
  } finally {window.happyDOM.abort();}
});

test('invalid substituted shorthands do not restore earlier values and CSS-wide values still apply', () => {
  const {document, window} = parseHTMLDocument('<main id="parent"><div id="box"></div></main>');
  try {
    const parent = document.getElementById('parent'), box = document.getElementById('box');
    const sheets = ['#parent{font-size:20px;color:blue;width:80px;padding:6px;border:2px solid green}',
      '#box{color:red;font-size:32px;width:77px;padding:4px;border:3px solid red}',
      '#box{color:var(--value);font-size:var(--value);width:var(--value);padding:var(--value);border:var(--value)}'];
    parent.style.setProperty('--value', 'solid solid');
    let style = new StyleEngine().compute(document, sheets).get(box);
    expect(style).toMatchObject({fontSize:20,color:'rgba(0, 0, 255, 1)',width:'auto'});
    expect(style.padding).toEqual([0,0,0,0]);
    expect(style.borderWidths).toEqual([0,0,0,0]);
    for (const value of ['initial','unset','inherit']) {
      parent.style.setProperty('--value', value);
      style = new StyleEngine().compute(document, sheets).get(box);
      expect(style.fontSize).toBe(value === 'initial' ? 16 : 20);
      expect(style.color).toBe(value === 'initial' ? 'rgba(0, 0, 0, 1)' : 'rgba(0, 0, 255, 1)');
      expect(style.width).toBe(value === 'inherit' ? 80 : 'auto');
      expect(style.padding).toEqual(Array(4).fill(value === 'inherit' ? 6 : 0));
      expect(style.borderWidths).toEqual(Array(4).fill(value === 'inherit' ? 2 : 0));
    }
  } finally {window.happyDOM.abort();}
});

test('SVG setter values retain currentColor and recompute alongside normalized background and opacity', () => {
  const {document, window} = parseHTMLDocument('<svg id="parent" xmlns="http://www.w3.org/2000/svg"><path id="shape"/></svg>');
  try {
    const parent = document.getElementById('parent'), shape = document.getElementById('shape');
    const sheets = ['#parent{font-size:20px}', '#shape{color:inherit;fill:currentColor;stroke:currentColor;'
      + 'stroke-width:var(--size);fill-opacity:25%;stroke-linecap:round;background-color:currentColor;opacity:var(--alpha)}'];
    for (const [color, expected, size, width] of [['red','rgba(255, 0, 0, 1)','1em',20], ['blue','rgba(0, 0, 255, 1)','2px',2]]) {
      parent.style.color = color;
      parent.style.setProperty('--size', size);
      parent.style.setProperty('--alpha', '50%');
      const style = new StyleEngine().compute(document, sheets).get(shape);
      expect(style).toMatchObject({color:expected,fill:'currentcolor',stroke:'currentcolor',strokeWidth:width,
        fillOpacity:0.25,strokeLinecap:'round',backgroundColor:expected,opacity:0.5});
    }
  } finally {window.happyDOM.abort();}
});
