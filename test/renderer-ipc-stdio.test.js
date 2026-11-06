import { expect, test } from 'bun:test';
import { rendererStdio } from '../lib/renderer/ipc-stdio.js';

test('other platforms do not inspect or change descriptors', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    expect(rendererStdio(false, { platform, readdir() { throw Error('must not inspect'); } }))
      .toEqual(['ignore', 'inherit', 'inherit']);
  }
});
test('Android reserves tracing descriptors without inheriting parent handles', () => {
  const opts = { platform: 'android', readdir: () => ['0','1','2','3','4','7'], readlink: path =>
    path.endsWith('/7') ? '/sys/kernel/tracing/trace_marker' : '/secret/parent-file' };
  expect(rendererStdio(true, opts)).toEqual(['ignore','pipe','pipe','ignore','ignore','ignore','ignore','ignore']);
  expect(rendererStdio(false, { ...opts, readlink: () => '/dev/null' })).toHaveLength(3);
});
test('closed or inaccessible descriptors preserve normal startup', () => {
  expect(rendererStdio(false, { platform:'android', readdir() { throw Error('denied'); } })).toHaveLength(3);
  expect(rendererStdio(false, { platform:'android', readdir:()=>['3'], readlink() { throw Error('closed'); } })).toHaveLength(3);
});
test('native Bun IPC still delivers structured messages with the selected stdio', async () => {
  let message;
  const child = Bun.spawn([process.execPath, '-e', 'process.send({ok:true});setTimeout(()=>process.exit(),100)'], {
    env: {}, stdio: rendererStdio(false), serialization: 'advanced', ipc(value) { message = value; },
  });
  try { expect(await child.exited).toBe(0); expect(message).toEqual({ok:true}); }
  finally { child.kill(); }
}, 5000);
