import {expect, test} from 'bun:test';

test('video-only refills retain audio until its own EOF or epoch boundary, including pending output requests', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/media-track-refill.js', import.meta.url).pathname], {
    stdout:'pipe', stderr:'pipe',
  });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({code, error}).toEqual({code:0, error:''});
  expect(out).toContain('track-independent refill integration passed');
}, 15_000);

for (const action of ['seek', 'pause', 'navigate']) {
  test(`a failed audio refill cancelled by ${action} does not fail the current playback`, async () => {
    const child = Bun.spawn([process.execPath,
      new URL('./fixtures/media-refill-cancel.js', import.meta.url).pathname, action], {
      stdout:'pipe', stderr:'pipe',
    });
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({code, error}).toEqual({code:0, error:''});
    expect(out).toContain(`${action} ignores an obsolete refill rejection`);
  }, 15_000);
}
