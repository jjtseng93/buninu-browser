import {test,expect} from 'bun:test';
import {cacheSpecifiedValue} from '../lib/style/css-specified-value-cache.js';
import {normalizeTableValue,computedTableSpacing} from '../lib/style/table-values.js';
import {normalizeBorderValue,computedBorderWidth} from '../lib/style/border-values.js';
import {normalizeSizingValue,computedSizingValue} from '../lib/style/sizing-values.js';

test('specified grammar caching separates property, source text and pending substitution',()=>{
  let calls=0;
  const normalize=cacheSpecifiedValue((name,input,pending)=>{calls++;return `${name}:${pending?'yes':'no'}:${input}`;});
  expect(normalize('width','var(--x)')).toBe('width:yes:var(--x)');
  expect(normalize('width','var(--x)')).toBe('width:yes:var(--x)');
  expect(calls).toBe(1);
  expect(normalize('width','var(--x)',false)).toBe('width:no:var(--x)');
  expect(normalize('height','var(--x)')).toBe('height:yes:var(--x)');
  expect(normalize('width','VAR(--x)')).toBe('width:yes:VAR(--x)');
  expect(calls).toBe(4);
  // NULs and digits must not turn boundaries between key fields ambiguous.
  expect(normalize('a','1\0b')).toBe('a:yes:1\0b');
  expect(normalize('a1','\0b')).toBe('a1:yes:\0b');
  expect(normalize('a','1\0b')).toBe('a:yes:1\0b');
  expect(calls).toBe(6);
});

test('specified grammar caching retains only immutable results and preserves conversions and errors',()=>{
  let calls=0;
  const normalize=cacheSpecifiedValue((_name,input)=>{
    calls++;
    if(input==='invalid')return null;
    if(input==='unrelated')return undefined;
    if(input==='mutable')return {value:input};
    if(input==='error')throw new Error('parse failure');
    return String(input);
  });
  expect(normalize('width','invalid')).toBeNull();
  expect(normalize('width','invalid')).toBeNull();
  expect(calls).toBe(1);
  expect(normalize('width','unrelated')).toBeUndefined();
  expect(normalize('width','unrelated')).toBeUndefined();
  expect(calls).toBe(3);
  const first=normalize('width','mutable');first.value='changed';
  expect(normalize('width','mutable')).toEqual({value:'mutable'});
  expect(calls).toBe(5);
  expect(()=>normalize('width','error')).toThrow('parse failure');
  expect(()=>normalize('width','error')).toThrow('parse failure');
  expect(calls).toBe(7);
  let conversions=0;
  const object={toString(){return String(++conversions);}};
  expect(normalize('width',object)).toBe('1');
  expect(normalize('width',object)).toBe('2');
  expect(calls).toBe(9);
});

test('specified grammar caches bound retained history and skip oversized inputs and outputs',()=>{
  let calls=0;
  const normalize=cacheSpecifiedValue((_name,input)=>{calls++;return input==='big-result'?'x'.repeat(1025):input;});
  normalize('width','old');normalize('width','old');
  expect(calls).toBe(1);
  for(let i=0;i<512;i++)normalize('width',String(i));
  normalize('width','511');
  expect(calls).toBe(513);
  normalize('width','old');
  expect(calls).toBe(514);
  for(const input of ['x'.repeat(513),'big-result']) {
    normalize('width',input);normalize('width',input);
  }
  const longName='w'.repeat(129);
  normalize(longName,'1px');normalize(longName,'1px');
  expect(calls).toBe(520);
});

test('cached specified values keep invalid, pending and relative values distinct from computed values',()=>{
  const cases=[
    [normalizeTableValue,'border-spacing','0','0px'],
    [normalizeTableValue,'table-layout','FIXED','fixed'],
    [normalizeTableValue,'border-spacing','-1px',null],
    [normalizeTableValue,'border-spacing','calc(1in + 2em)','calc(2em + 96px)'],
    [normalizeBorderValue,'border','1px SOLID red','1px solid red'],
    [normalizeBorderValue,'border-width','2em','2em'],
    [normalizeBorderValue,'border-style','solid dashed','solid dashed'],
    [normalizeBorderValue,'border-color','currentcolor','currentcolor'],
    [normalizeBorderValue,'border','solid solid',null],
    [normalizeSizingValue,'width','-1px',null],
    [normalizeSizingValue,'width','calc(50% - 2em)','calc(50% - 2em)'],
    [normalizeSizingValue,'max-width','none','none'],
    [normalizeSizingValue,'width','none',null],
    [normalizeSizingValue,'width','var(--日本)','var(--日本)'],
  ];
  for(let repeat=0;repeat<3;repeat++)for(const [normalize,name,input,expected] of cases)
    expect(normalize(name,input)).toBe(expected);
  for(const [normalize,name] of [[normalizeTableValue,'border-spacing'],[normalizeBorderValue,'border'],[normalizeSizingValue,'width']]) {
    expect(normalize(name,'var(--x)')).toBe('var(--x)');
    expect(normalize(name,'var(--x)',false)).toBeNull();
    expect(normalize(name,'var(--x)')).toBe('var(--x)');
    expect(normalize('not-a-property','var(--x)')).toBeUndefined();
  }
  for(const scale of [10,20,10]) {
    const resolve=value=>value==='1em'?scale:NaN;
    expect(computedTableSpacing(normalizeTableValue('border-spacing','2em'),resolve)).toEqual([2*scale,2*scale]);
    expect(computedBorderWidth(normalizeBorderValue('border-width','2em'),resolve)).toBe(2*scale);
    expect(computedSizingValue(normalizeSizingValue('width','calc(2em + 1px)'),resolve)).toBe(2*scale+1);
  }
});
