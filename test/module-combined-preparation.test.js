import {test,expect} from 'bun:test';
import {prepareModuleSource} from '../lib/renderer/module-preparation.js';
import {transformModule} from '../lib/renderer/module-transform.js';
import {rewriteModuleSource} from '../lib/renderer/script-rewrite.js';

// Retain the separate, public rewrite pipeline as a differential oracle.
const separate=source=>transformModule(rewriteModuleSource(source));
const combined=source=>prepareModuleSource(source,'ses');

test('combined module preparation preserves the separate rewrites across overlapping source boundaries',()=>{
  const expressions=[
    'object.answer','object.inner.answer','object[other.key]',
    'object[other.keys[index.value]]','(object,other).answer',
    '(object).method(1)','object.method().answer','new object.Constructor(1)',
    '(object.method)(1)','object["method"](1)','(object)[(other.key)]',
    'object /* receiver */ . /* key */ answer','object[ /* key */ other.key /* end */ ]',
    'object?.inner.answer','object.method?.(1)','object.method`template`',
    'import.meta.url','import /* keyword */ .meta[other.key]',
    '(await import(other.source)).answer','(await import(((other.source)))).answer',
    '({object, [object.answer]: other.answer})',
    '(()=>{const object={answer:1};return object.answer})()',
    '(()=>{try{throw object}catch(object){return object.answer}})()',
  ];
  for(const expression of expressions)for(const exported of ['const result=','default ']) {
    const source=`import {object,other,index} from './dependency.js';export ${exported}(${expression});`;
    const expected=separate(source),actual=combined(source);
    expect(actual).toEqual(expected);
    expect(()=>new Function(`return ${actual.code}`)).not.toThrow();
  }
  for(const source of [
    '#!/usr/bin/env bun\nimport {object} from "./dependency.js";export default object.answer;',
    'import {object} from "./dependency.js";export {object};export * from "./other.js";',
    'import object from "./dependency.json" with {type:"json"};export default object.answer;',
    'export default function(){return object.answer}',
    'import {object} from "./dependency.js";export default function named(){return object.answer} export {named};',
    'export default (function(){return object.answer});',
    'export default class{value(){return object.answer}}',
    'const object={answer:42}\nobject.answer\nexport default (object.answer)',
    'export default object.answer // trailing comment without a semicolon',
    'const f=()=>{return object.answer}\nexport default f()',
    'const n=41;export const result=eval("n+1");',
    'export const result=(()=>{let n=1;eval("n+=2");return n})();',
    'export const result=(async function(){}).constructor("return 42")();',
    'export const result=Object.getPrototypeOf(function*(){}).constructor("yield 42")();',
    'export const result=(async()=>{})["constructor"]("return 42")();',
    'import {$buninu$member} from "./dependency.js";export const result=object.answer;',
    'class A{get answer(){return 42}}export default class extends A{value(){return super.answer}}',
    'class A{#value=1;get answer(){return this.#value}}export default new A().answer;',
  ])expect(combined(source)).toEqual(separate(source));
});

test('combined module execution preserves receiver/key evaluation order and live imported bindings',async()=>{
  const source=`
    import {object, key} from './dependency.js';
    export const origin=import.meta.url;
    export const result=object[key()](3);
    export const dynamic=(await import((object.source))).answer;
    export function read(){return object.answer;}
    export function shadow(object){return object.answer;}
    export const shorthand={object};
    export const mutate=()=>{object.answer=9;return object.answer;};
    export default (object.answer);
  `;
  for(const prepare of [separate,combined]) {
    const events=[],exports={},object={answer:4,source:'virtual:dynamic',
      method(value){events.push(['method',this===object,value]);return this.answer+value;}};
    const namespace={object,key(){events.push(['key']);return 'method';}};
    const loader={exports,namespaces:[namespace],linked:Promise.resolve(),meta:{url:'https://module.test/main.js'},
      async importDynamic(specifier){events.push(['import',specifier]);return {answer:42};},exportStar(){}};
    const member=(receiver,key,call=false)=>{
      events.push(['member',key,call]);
      const value=receiver[key];
      return call&&typeof value==='function'?value.bind(receiver):value;
    };
    await new Function('$buninu$member',`return ${prepare(source).code}`)(member)(loader);
    expect(exports.origin).toBe('https://module.test/main.js');
    expect(exports.result).toBe(7);
    expect(exports.dynamic).toBe(42);
    expect(exports.default).toBe(4);
    expect(exports.shorthand.object).toBe(object);
    expect(events.filter(event=>event[0]==='key')).toHaveLength(1);
    expect(events.find(event=>event[0]==='method')).toEqual(['method',true,3]);
    expect(events.findIndex(event=>event[0]==='key')).toBeLessThan(events.findIndex(event=>event[0]==='method'));
    expect(events.filter(event=>event[0]==='import')).toEqual([['import','virtual:dynamic']]);
    expect(exports.mutate()).toBe(9);
    expect(exports.read()).toBe(9);
    expect(exports.shadow({answer:17})).toBe(17);
    namespace.object={answer:23};
    expect(exports.read()).toBe(23);
    expect(exports.default).toBe(4);
  }
});

test('combined preparation retains exact output for a larger module with many nested member reads',()=>{
  const lines=['import {object} from "./dependency.js";'];
  for(let index=0;index<192;index++)lines.push(`
    export function read${index}(other={answer:${index}}){
      const keys=["answer"];
      return {value:object[keys[0]],other:other.answer,nested:object.inner.method(other.answer),
        url:import.meta.url,local:((object)=>object.answer)(other)};
    }`);
  const source=lines.join('\n');
  expect(combined(source)).toEqual(separate(source));
});

test('combined preparation preserves module parse errors and host preparation',()=>{
  for(const source of ['export const = 1','export default (1','import {x} from "x"; const x=1',
    'export const x=\\u0069mport("x")','return object.answer;']) {
    let expected;
    try{separate(source);}catch(error){expected=error;}
    expect(expected).toBeInstanceOf(SyntaxError);
    let actual;
    try{combined(source);}catch(error){actual=error;}
    expect(actual).toBeInstanceOf(SyntaxError);
    expect(actual.message).toBe(expected.message);
  }
  const source='export default (({answer:42}).answer);';
  expect(prepareModuleSource(source,'host')).toEqual(transformModule(source));
  expect(prepareModuleSource(source,'host').code).not.toContain('$buninu$member');
});
