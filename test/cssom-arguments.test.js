import {afterAll, beforeAll, expect, test} from 'bun:test';
import {RendererHost} from '../lib/renderer/host.js';

let host;
beforeAll(async () => {
  host = new RendererHost({timeout: 20000});
  await host.start();
  await host.call('resize', 400, 300, 1);
  await host.call('loadDocument', {
    url: 'https://test.local/', contentType: 'text/html',
    source: '<!doctype html><style>body{margin:0}#hit{position:absolute;left:10px;top:10px;width:100px;height:100px}</style><div id="hit"></div>',
  });
  await host.call('whenLoaded');
});
afterAll(() => host?.close());
const evaluate = async source => JSON.parse(await host.call('evaluate', `JSON.stringify((()=>{${source}})())`));

test('CSS.escape distinguishes missing arguments from undefined and uses DOMString', async () => {
  const result = await evaluate(`
    let missing, symbol, boxed;
    try { CSS.escape(); } catch (e) { missing = e instanceof TypeError; }
    try { CSS.escape(Symbol()); } catch (e) { symbol = e instanceof TypeError; }
    try { CSS.escape(Object(Symbol())); } catch (e) { boxed = e instanceof TypeError; }
    return {missing, symbol, boxed, length: CSS.escape.length,
      undefinedValue: CSS.escape(undefined), nullValue: CSS.escape(null),
      big: CSS.escape(12n), surrogates: CSS.escape('\uD800x\uDFFF'),
      nul: CSS.escape('a\0b')};
  `);
  expect(result).toEqual({missing: true, symbol: true, boxed: true, length: 1,
    undefinedValue: 'undefined', nullValue: 'null', big: '\\31 2',
    surrogates: '\uD800x\uDFFF', nul: 'a\uFFFDb'});
});

test('CSS.escape converts with string hint and preserves user exceptions', async () => {
  expect(await evaluate(`
    const order = [], token = new TypeError('author error');
    const escaped = CSS.escape({toString(){order.push('toString'); return {};},
      valueOf(){order.push('valueOf'); return 'a b';}});
    let hint, identical;
    CSS.escape({[Symbol.toPrimitive](value){hint = value; return 'ok';}});
    try { CSS.escape({toString(){throw token;}}); } catch(e) { identical = e === token; }
    return {order, escaped, hint, identical};
  `)).toEqual({order: ['toString', 'valueOf'], escaped: 'a\\ b', hint: 'string', identical: true});
});

test('point queries reject non-finite and non-number-convertible arguments in page realm', async () => {
  const rows = await evaluate(`
    const rows = [];
    for (const name of ['elementFromPoint', 'elementsFromPoint']) {
      for (const args of [[], [0], [undefined,0], [0,undefined], [NaN,0], [0,Infinity],
        [-Infinity,0], ['Infinity',0], [1n,0], [0,Object(1n)], [Symbol(),0],
        [{[Symbol.toPrimitive](){return {}; }},0]]) {
        try { document[name](...args); rows.push(false); }
        catch(e) { rows.push(e instanceof TypeError); }
      }
    }
    return rows;
  `);
  expect(rows).toHaveLength(24);
  expect(rows.every(Boolean)).toBe(true);
});

test('point queries convert x before y, preserve exceptions, and keep fractional hits', async () => {
  expect(await evaluate(`
    const order = [], token = new TypeError('author error');
    const x = {[Symbol.toPrimitive](hint){order.push('x:'+hint);return 20.5;}};
    const y = {valueOf(){order.push('y');return 20.25;}};
    const first = document.elementFromPoint(x,y).id;
    let identical, skipped = true;
    try { document.elementsFromPoint({valueOf(){throw token;}},
      {valueOf(){skipped=false;return 0;}}); } catch(e) { identical=e===token; }
    try { document.elementFromPoint(NaN,{valueOf(){skipped=false;return 0;}}); } catch(e) {}
    return {order, first, identical, skipped,
      coerced: document.elementsFromPoint('20.5','20.25')[0].id,
      origin: document.elementFromPoint(null,false).localName,
      outside: document.elementFromPoint(-1,0)};
  `)).toEqual({order: ['x:number','y'], first: 'hit', identical: true,
    skipped: true, coerced: 'hit', origin: 'html', outside: null});
});

test('detached documents validate coordinates but never hit the active document', async () => {
  expect(await evaluate(`
    const detached=document.implementation.createHTMLDocument();
    const exceptions=[];
    for(const name of ['elementFromPoint','elementsFromPoint']) {
      try { detached[name](0,NaN); exceptions.push(false); }
      catch(e) { exceptions.push(e instanceof TypeError); }
    }
    return {exceptions, one:detached.elementFromPoint(20,20),
      many:detached.elementsFromPoint(20,20)};
  `)).toEqual({exceptions: [true,true], one: null, many: []});
});
