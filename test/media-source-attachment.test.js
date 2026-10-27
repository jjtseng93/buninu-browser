import {expect, test} from 'bun:test';

test('only the currently attached MediaSource can change media state across src, srcObject and documents', async () => {
  const child=Bun.spawn([process.execPath,new URL('./fixtures/media-source-attachment.js',import.meta.url).pathname],{
    stdout:'pipe',stderr:'pipe',
  });
  const [out,error,code]=await Promise.all([
    new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
  ]);
  expect({code,error}).toEqual({code:0,error:''});
  expect(out).toContain('MediaSource attachment isolation passed');
},15000);

for(const action of ['src','attribute','load'])test(`explicit ${action} reselects media while passive base changes preserve it`,async()=>{
  const child=Bun.spawn([process.execPath,new URL('./fixtures/media-resource-reselection.js',import.meta.url).pathname,action],{
    stdout:'pipe',stderr:'pipe',
  });
  const [out,error,code]=await Promise.all([
    new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
  ]);
  expect({code,error}).toEqual({code:0,error:''});
  expect(out).toContain(`Media resource reselection ${action} passed`);
},15000);

test('MediaSource attachment queues sourceopen without a playback decoder', async () => {
  const child=Bun.spawn([process.execPath,new URL('./fixtures/media-source-no-decoder.js',import.meta.url).pathname],{
    stdout:'pipe',stderr:'pipe',
  });
  const [out,error,code]=await Promise.all([
    new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
  ]);
  expect({code,error}).toEqual({code:0,error:''});
  expect(out).toContain('Decoder-less MediaSource attachment passed');
},15000);
