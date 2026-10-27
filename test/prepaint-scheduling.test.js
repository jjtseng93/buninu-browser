import {expect, test} from 'bun:test';

for (const scenario of ['loading', 'loading-scroll', 'pending-frame', 'video']) {
  test(`prepaint scheduling preserves visible work and eventual idle expansion: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath,
      new URL('./fixtures/prepaint-scheduling.js', import.meta.url).pathname, scenario], {stdout:'pipe', stderr:'pipe'});
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({code, error}).toEqual({code:0, error:''});
    expect(output).toContain(`prepaint ${scenario} passed`);
  }, 15000);
}
