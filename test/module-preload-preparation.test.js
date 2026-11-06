import { expect, test } from 'bun:test';

test('only executable module roots prepare before CSS and their results are reused', async () => {
  // Isolate lockdown and page globals from other tests in the runner.
  const child = Bun.spawn([
    process.execPath,
    Bun.fileURLToPath(new URL('./fixtures/module-preload-preparation.js', import.meta.url)),
  ], { stdout: 'pipe', stderr: 'pipe' });
  let timer;
  try {
    const result = Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const [code, output, error] = await Promise.race([
      result,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(Error('Module preparation fixture timed out'));
        }, 15000);
      }),
    ]);
    expect(code, error).toBe(0);
    expect(output).toContain('module preload preparation passed');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
}, 20000);
