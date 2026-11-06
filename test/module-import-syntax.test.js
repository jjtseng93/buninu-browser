import {test,expect} from 'bun:test';
import {transformModule} from '../lib/renderer/module-transform.js';

async function evaluateModule(source,{namespaces=[],meta={url:'https://module.test/source.js'}}={}) {
  const transformed=transformModule(source),calls=[],exports={};
  const loader={exports,namespaces,meta,linked:Promise.resolve(),
    async importDynamic(specifier,options){calls.push([specifier,options]);return {value:42};},
    exportStar(namespace){for(const name of Object.keys(namespace))if(name!=='default'&&!Object.hasOwn(exports,name))
      Object.defineProperty(exports,name,{enumerable:true,get:()=>namespace[name]});},
  };
  await (0,eval)(transformed.code)(loader);
  return {exports,calls,requests:transformed.requests};
}

test('module dynamic imports and metadata preserve all JavaScript whitespace and comment forms',async()=>{
  const gaps=['',' ','\t','\v','\f','\n','\r','\r\n','\u00a0','\u1680',
    ...Array.from({length:11},(_,index)=>String.fromCharCode(0x2000+index)),
    '\u2028','\u2029','\u202f','\u205f','\u3000','\ufeff','/* gap */','// gap\n',' /**/ \n /**/ '];
  for(const gap of gaps) {
    const {exports,calls,requests}=await evaluateModule(`
      export const dependency=await import${gap}('virtual:dependency', {with:{type:'json'}});
      export const address=import${gap}. /* property */ meta.url;
    `);
    expect(exports.dependency).toEqual({value:42});
    expect(exports.address).toBe('https://module.test/source.js');
    expect(calls).toEqual([['virtual:dependency',{with:{type:'json'}}]]);
    expect(requests).toEqual([]);
  }
});

test('module import syntax in nested expressions is rewritten without changing literals or property names',async()=>{
  const {exports,calls}=await evaluateModule(`
    const object={import(value){return value+1;}};
    export const literal='import("literal") and import.meta';
    export const pattern=/import\\s*\\(/.source;
    export const method=object.import(3);
    export const nested=await (async()=>({value:(await import/**/('virtual:nested')).value,url:import\n.meta.url}))();
    export const interpolated=\`value=\${(await import('virtual:template')).value}\`;
  `);
  expect(exports.literal).toBe('import("literal") and import.meta');
  expect(exports.pattern).toBe('import\\s*\\(');
  expect(exports.method).toBe(4);
  expect(exports.nested).toEqual({value:42,url:'https://module.test/source.js'});
  expect(exports.interpolated).toBe('value=42');
  expect(calls.map(([specifier])=>specifier)).toEqual(['virtual:nested','virtual:template']);
});

test('static-only module imports and reexports retain live bindings',async()=>{
  const namespace={default:2,value:3,extra:5};
  const {exports,requests,calls}=await evaluateModule(`
    import def,{value as alias}from'./dependency.js';
    import*as whole from'./dependency.js';
    import'./side-effect.js';
    export {alias};
    export*from'./dependency.js';
    export const initial=def+alias;
    export function read(){return whole.value+alias;}
  `,{namespaces:[namespace,{}]});
  expect(requests).toEqual([{specifier:'./dependency.js',type:null},{specifier:'./side-effect.js',type:null}]);
  expect(exports.initial).toBe(5);
  expect(exports.alias).toBe(3);
  expect(exports.extra).toBe(5);
  namespace.value=7;namespace.extra=11;
  expect(exports.alias).toBe(7);
  expect(exports.read()).toBe(14);
  expect(exports.extra).toBe(11);
  expect(calls).toEqual([]);
});

test('escaped import keywords and metadata remain syntax errors',()=>{
  for(const source of ['export const x=\\u0069mport("x")','export const x=im\\u0070ort.meta',
    'export const x=import.m\\u0065ta','export const x=import\\\n("x")'])
    expect(()=>transformModule(source)).toThrow();
});
