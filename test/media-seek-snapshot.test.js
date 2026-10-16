import { expect, test } from 'bun:test';

test('seeking uses media bytes appended after the current decoder was opened', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/media-seek-snapshot.js', import.meta.url).pathname],
    { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(stdout).toContain('latest video snapshot seek passed');
}, 30_000);
