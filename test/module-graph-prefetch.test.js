import { expect, test } from 'bun:test';

test('module graph prefetch preserves execution order, cycles, TLA, failure and cancellation', async () => {
  const child = Bun.spawn([
    process.execPath,
    Bun.fileURLToPath(new URL('./fixtures/module-graph-prefetch.js', import.meta.url)),
  ], { stdout: 'pipe', stderr: 'pipe' });
  let timer;
  try {
    const finished = Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const [code, output, error] = await Promise.race([
      finished,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(Error('Module graph fixture timed out'));
        }, 25000);
      }),
    ]);
    expect(code, error).toBe(0);
    expect(output).toContain('module graph prefetch passed');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
}, 30000);
