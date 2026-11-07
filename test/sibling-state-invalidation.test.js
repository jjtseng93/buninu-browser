import {expect, test} from 'bun:test';
import {sheetTraits} from '../lib/style/selector-traits.js';

test('cached sibling prefixes record their own and ancestor feature dependencies', () => {
  const traits=sheetTraits('.on [data-ready] .a + .b .target{} [style] .x ~ .y .leaf{}');
  expect([...traits.siblingStateFeatures].sort()).toEqual(['.a','.b','.on','.x','.y','[data-ready','[style'].sort());
  expect(traits.siblingStateFeatures.has('.target')).toBeFalse();
  expect(sheetTraits('.on .a + .b .target{}').siblingStateFeatures.has('[style')).toBeFalse();
});

test('renderer keeps sibling-prefix caches correct across ancestor and mixed mutations', async () => {
  const child=Bun.spawn([process.execPath,Bun.fileURLToPath(new URL('./fixtures/sibling-state-invalidation.js',import.meta.url))],{stdout:'pipe',stderr:'pipe'});
  const [code,out,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({code,error}).toEqual({code:0,error:''});
  expect(out).toContain('sibling state invalidation passed');
},20000);
