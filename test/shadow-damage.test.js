import {expect, test} from 'bun:test';
import {buildDisplayList} from '../lib/paint/display-list.js';

function shadowList(spread, dpr = 1) {
  return buildDisplayList({boxes: [{nodeId: 1, x: 100, y: 100, width: 20, height: 100,
    style: {boxShadow: [{x: 0, y: 0, spread, blur: 30, color: 'black'}]}}], fragments: []},
    null, null, null, null, dpr).items;
}

test('shadow bounds cover the raster blur tail and discard shapes shrunk away by spread', () => {
  expect(shadowList(-10)).toEqual([]);
  expect(shadowList(-30)).toEqual([]);
  for (const dpr of [.3, .75, 1, 1.5, 2]) {
    const shadow = shadowList(0, dpr)[0];
    const tail = Math.round(30 * dpr) * 1.5 / dpr;
    expect(shadow.bounds.x).toBeLessThanOrEqual(100 - tail);
    expect(shadow.bounds.y).toBeLessThanOrEqual(100 - tail);
    expect(shadow.bounds.x + shadow.bounds.width).toBeGreaterThanOrEqual(120 + tail);
    expect(shadow.bounds.y + shadow.bounds.height).toBeGreaterThanOrEqual(200 + tail);
  }
});

test('partial shadow repaint matches full pixels through transforms, clips and DPR', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/shadow-damage.js', import.meta.url).pathname],
    {stdout: 'pipe', stderr: 'pipe'});
  // A negative-spread regression used to trap the damage closure in a loop.
  // Keep that failure bounded and do not leave a renderer running on timeout.
  const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
  try {
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe('');
    expect(exit).toBe(0);
  } finally { clearTimeout(timer); }
}, 30_000);
