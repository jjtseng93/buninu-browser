import { expect, test } from 'bun:test';

for (const mode of ['plain', 'ses']) {
  test(`duplicate class keys preserve candidate matching and ancestor counts (${mode})`, async () => {
    const child = Bun.spawn([process.execPath, new URL('./fixtures/duplicate-style-keys.js', import.meta.url).pathname, mode],
      { stdout: 'pipe', stderr: 'pipe' });
    const [exit, stdout, stderr] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: '', stderr: '' });
  }, 10_000);
}
