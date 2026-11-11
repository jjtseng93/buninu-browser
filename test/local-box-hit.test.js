import {test, expect} from 'bun:test';
import {localBoxHit} from '../lib/input/hit-test.js';

test('geometry lookup preserves first local box and follows new hit lists', () => {
  const text = {nodeId:3}, first = {nodeId:3,localRect:{x:10}}, later = {nodeId:3,localRect:{x:40}};
  const hits = Object.freeze([text, first, later]);
  expect(localBoxHit({hits}, 3)).toBe(first);
  expect(localBoxHit({hits}, 4)).toBeUndefined();
  // Image-only display-list replacement can share the same geometry array.
  expect(localBoxHit({hits, images:[]}, 3)).toBe(first);
  expect(localBoxHit({hits:Object.freeze([later])}, 3)).toBe(later);
  expect(localBoxHit({hits:Object.freeze([])}, 3)).toBeUndefined();
  expect(localBoxHit(null, 3)).toBeUndefined();
});

test('mutable synthetic hit lists remain live', () => {
  const hits = [], list = {hits};
  expect(localBoxHit(list, 1)).toBeUndefined();
  const hit = {nodeId:1,localRect:{x:1}};
  hits.push(hit);
  expect(localBoxHit(list, 1)).toBe(hit);
  hits.length = 0;
  expect(localBoxHit(list, 1)).toBeUndefined();
});
