import {test,expect} from 'bun:test';
import {transformModule} from '../lib/renderer/module-transform.js';
import {rewriteModuleSource} from '../lib/renderer/script-rewrite.js';

async function evaluate(source,rewrite) {
  const {code,requests}=transformModule(rewrite?rewriteModuleSource(source):source);
  const exports={},loader={exports,namespaces:[{answer:42}],meta:{url:'https://module.test/default.js'},
    linked:Promise.resolve(),importDynamic:async()=>({answer:42}),exportStar(){}};
  const member=(object,key,call)=>{const value=object[key];return call&&typeof value==='function'?value.bind(object):value;};
  await new Function('$buninu$member',`return ${code}`)(member)(loader);
  return {exports,requests};
}

test('default export expression grouping survives module and member-read preparation',async()=>{
  const cases=[
    ['export default (42);',42],
    ['export default ((({answer:42}).answer));',42],
    ['const object={answer:42}; export default object.answer;',42],
    ['const object={answer:42}; export default (object.answer)',42],
    ['export /* keywords */ default /* opening */ (/* value */42/* end */);',42],
    ['export default (1,42);',42],
    ['export default (await import("virtual:answer")).answer;',42],
    ['export default (import /* gap */ .meta.url);','https://module.test/default.js'],
    ['import {answer} from "virtual:answer"; export default ((answer));',42],
    ['export default (42)\nexport const following=1;',42],
    ['export default (42) // comment after expression\nexport const following=1;',42],
    ['#! /usr/bin/env bun\nexport default (42);',42],
  ];
  for(const rewrite of [false,true])for(const [source,value]of cases) {
    const {exports}=await evaluate(source,rewrite);
    expect(exports.default).toBe(value);
    if(source.includes('following'))expect(exports.following).toBe(1);
  }
});

test('default functions and classes retain their callable values and named export bindings',async()=>{
  for(const rewrite of [false,true]) {
    for(const source of ['export default function(){return ({answer:42}).answer;}',
      'export default (function(){return ({answer:42}).answer;});',
      'export default function named(){return ({answer:42}).answer;} export {named};']) {
      const {exports}=await evaluate(source,rewrite);
      expect(exports.default()).toBe(42);
      if(exports.named)expect(exports.named).toBe(exports.default);
    }
    for(const source of ['export default class{value(){return 42;}}',
      'export default (class{value(){return 42;}});',
      'export default class Named{value(){return 42;}} export {Named};']) {
      const {exports}=await evaluate(source,rewrite);
      expect(new exports.default().value()).toBe(42);
      if(exports.Named)expect(exports.Named).toBe(exports.default);
    }
  }
});
