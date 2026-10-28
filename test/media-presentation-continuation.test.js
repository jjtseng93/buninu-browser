import { test, expect } from 'bun:test';

for (const scenario of ['success', 'pause', 'controls', 'seek', 'source', 'format', 'worker-failure', 'epoch', 'no-growth']) {
  test(`presentation continuation: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath,
      new URL('./fixtures/media-presentation-continuation.js', import.meta.url).pathname, scenario],
    { stdout: 'pipe', stderr: 'pipe' });
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, error }).toEqual({ code: 0, error: '' });
    expect(out).toContain(`continuation ${scenario} passed`);
  }, 15000);
}
