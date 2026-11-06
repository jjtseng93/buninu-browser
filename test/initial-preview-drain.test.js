import {test, expect} from 'bun:test';

test('initial preview scheduling drains ready stylesheet responses and respects newer navigation', async () => {
  const child = Bun.spawn([process.execPath, Bun.fileURLToPath(new URL('./fixtures/initial-preview-drain.js', import.meta.url))], {
    stdout:'pipe', stderr:'pipe',
  });
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({code, error}).toEqual({code:0, error:''});
  expect(out).toContain('initial preview scheduling passed');
}, 20_000);
