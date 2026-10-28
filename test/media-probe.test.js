import { expect, test } from 'bun:test';

for (const scenario of ['initial-shared', 'initial-growth', 'initial-source', 'initial-rejected', 'audio-only',
  'refresh-growth', 'pipe-change', 'failed-retry', 'mime-change', 'epoch', 'epoch-inflight', 'moving-snapshot']) {
  test(`media metadata probe: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, new URL('./fixtures/media-probe.js', import.meta.url).pathname, scenario],
      { stdout: 'pipe', stderr: 'pipe' });
    try {
      const [out, error, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ code, error }).toEqual({ code: 0, error: '' });
      expect(out).toContain(`media probe ${scenario} passed`);
    } finally { child.kill(); }
  }, 10000);
}
