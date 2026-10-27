import {expect, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {createServer, createConnection} from 'node:net';
import {PacketReader, PacketWriter} from '../lib/renderer/compositor-channel.js';

class DelayedSocket extends EventEmitter {
  destroyed = false;
  writes = [];
  throwAt = -1;
  write(chunk, callback) {
    if (this.writes.length === this.throwAt) throw Error('write failed');
    this.writes.push({chunk, callback});
    return false;
  }
  complete(index, error) { this.writes[index].callback(error); }
  destroy() { this.destroyed = true; return this; }
  finishClose() { this.emit('close'); }
}

function tracked(bytes) {
  const pixels = new Uint8Array(bytes);
  const buffer = pixels.buffer, transfer = buffer.transfer.bind(buffer);
  let releases = 0;
  buffer.transfer = size => { releases++; return transfer(size); };
  return {pixels, get releases() { return releases; }};
}

test('owned pixels stay borrowed until write completion and packets cannot interleave', () => {
  const socket = new DelayedSocket(), writer = new PacketWriter(socket);
  const owned = tracked(32); owned.pixels.fill(57);
  const unowned = Uint8Array.of(1, 2, 3);
  writer.send({id:1}, owned.pixels, {takeOwnership:true});
  writer.send({type:'frame'});
  writer.send({id:2}, unowned);
  unowned.fill(99); // The default send snapshots an unowned input immediately.
  expect(socket.writes).toHaveLength(1);
  expect(owned.releases).toBe(0);
  const wire = [Buffer.from(socket.writes[0].chunk)];
  socket.complete(0);
  expect(socket.writes[1].chunk).toBe(owned.pixels);
  expect(owned.releases).toBe(0);
  wire.push(Buffer.from(socket.writes[1].chunk));
  socket.complete(1);
  expect(owned.releases).toBe(1);
  expect(owned.pixels.byteLength).toBe(0);
  wire.push(Buffer.from(socket.writes[2].chunk));
  socket.complete(2);
  wire.push(Buffer.from(socket.writes[3].chunk));
  socket.complete(3);
  const received = [];
  new PacketReader((message,pixels) => received.push([message,[...pixels]])).push(Buffer.concat(wire));
  expect(received).toEqual([[{id:1},Array(32).fill(57)],[{type:'frame'},[]],[{id:2},[1,2,3]]]);
  expect([...unowned]).toEqual([99,99,99]);
  expect(writer.bytes).toBe(0);
  writer.close(); socket.finishClose();
  expect(owned.releases).toBe(1);
});

test('backpressure releases queued and rejected frames but waits for an active native write', () => {
  const socket = new DelayedSocket(), writer = new PacketWriter(socket, 250);
  const active = tracked(100), queued = tracked(40), rejected = tracked(180);
  writer.send({id:1},active.pixels,{takeOwnership:true});
  writer.send({id:2},queued.pixels,{takeOwnership:true});
  expect(() => writer.send({id:3},rejected.pixels,{takeOwnership:true})).toThrow('backpressure');
  expect(socket.destroyed).toBe(true);
  expect([active.releases,queued.releases,rejected.releases]).toEqual([0,1,1]);
  const closed = tracked(1);
  expect(() => writer.send({id:4},closed.pixels,{takeOwnership:true})).toThrow('closed');
  expect(closed.releases).toBe(1);
  socket.finishClose();
  expect(active.releases).toBe(1);
  socket.complete(0); // Late write callbacks must not send or release again.
  expect(socket.writes).toHaveLength(1);
  expect([active.releases,queued.releases,rejected.releases]).toEqual([1,1,1]);
  expect(writer.bytes).toBe(0);
});

test('synchronous write throws and asynchronous errors close partially sent packets', () => {
  for (const failure of ['header-throw','body-throw','body-callback','disconnect']) {
    const socket = new DelayedSocket(), writer = new PacketWriter(socket);
    const active = tracked(32), queued = tracked(24);
    if (failure === 'header-throw') socket.throwAt = 0;
    const send = () => writer.send({id:1},active.pixels,{takeOwnership:true});
    if (failure === 'header-throw') {
      expect(send).toThrow('write failed');
    } else {
      send();
      writer.send({id:2},queued.pixels,{takeOwnership:true});
      if (failure === 'body-throw') socket.throwAt = 1;
      socket.complete(0);
      if (failure === 'body-callback') socket.complete(1, Error('connection lost'));
      if (failure === 'disconnect') socket.destroy();
    }
    // Throw/destroy alone does not prove a pending native write has released
    // its input. The close event is the portable completion boundary.
    if (failure !== 'body-callback') expect(active.releases).toBe(0);
    socket.finishClose();
    expect(active.releases).toBe(1);
    if (failure !== 'header-throw') expect(queued.releases).toBe(1);
    for (let i=0; i<socket.writes.length; i++) socket.complete(i, Error('late callback'));
    expect(active.releases).toBe(1);
    expect(writer.bytes).toBe(0);
    expect(socket.destroyed).toBe(true);
  }
});

test('rejected owned serialization releases bytes without damaging an untouched stream', () => {
  const socket = new DelayedSocket(), writer = new PacketWriter(socket);
  const invalid = tracked(8), message = {}; message.self = message;
  expect(() => writer.send(message,invalid.pixels,{takeOwnership:true})).toThrow();
  expect(invalid.releases).toBe(1);
  expect(socket.destroyed).toBe(false);
  expect(socket.writes).toHaveLength(0);
  const shared = new Uint8Array(new SharedArrayBuffer(8));
  expect(() => writer.send({},shared,{takeOwnership:true})).toThrow('private ArrayBuffer');
  expect(shared.byteLength).toBe(8);
  writer.send({ok:true}); socket.complete(0);
  writer.close(); socket.finishClose();
});

test('synchronous write callbacks drain many queued messages without recursion or double release', () => {
  const socket = new DelayedSocket(), writer = new PacketWriter(socket);
  const first = tracked(8);
  writer.send({id:1},first.pixels,{takeOwnership:true});
  for (let i=0;i<2000;i++) writer.send({id:i+2});
  socket.write = (chunk,callback) => { callback(); return true; };
  socket.complete(0);
  expect(first.releases).toBe(1);
  expect(writer.bytes).toBe(0);
  writer.close(); socket.finishClose();
});

async function socketPair(receive) {
  let accepted;
  const ready = new Promise(resolve => { accepted = resolve; });
  const server = createServer(socket => {
    socket.setNoDelay(true); socket.pause();
    socket.on('data',receive);
    socket.on('error',()=>{});
    accepted(socket);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const client = createConnection({host:'127.0.0.1',port:server.address().port});
  client.setNoDelay(true);
  await new Promise((resolve,reject) => { client.once('connect',resolve);client.once('error',reject); });
  const peer = await ready;
  return {client,peer,server,close() {client.destroy();peer.destroy();server.close();}};
}

test('large frames survive a paused receiver with queued control and copied messages', async () => {
  const received = [], expected = [], deferred = Promise.withResolvers();
  const reader = new PacketReader((message,pixels) => {
    received.push([message,Bun.hash(pixels)]);
    pixels.buffer.transfer(0);
    if (received.length === 5) deferred.resolve();
  });
  const pair = await socketPair(chunk => {try { reader.push(chunk); } catch(error) {deferred.reject(error);}});
  const writer = new PacketWriter(pair.client);
  const first = tracked(8*1024*1024), last = tracked(8*1024*1024);
  const copied = new Uint8Array(8*1024*1024);
  first.pixels.fill(11); copied.fill(22); last.pixels.fill(33);
  try {
    for (const [message,pixels,owned] of [[{id:1},first.pixels,true],[{type:'frame'},null,false],
      [{id:2},copied,false],[{type:'frame',sequence:2},null,false],[{id:3},last.pixels,true]]) {
      expected.push([message,Bun.hash(pixels ?? new Uint8Array())]);
      writer.send(message,pixels,owned ? {takeOwnership:true} : undefined);
    }
    copied.fill(99);
    await Bun.sleep(80);
    expect(last.releases).toBe(0);
    pair.peer.resume();
    await deferred.promise;
    for (let i=0; i<100 && last.releases===0; i++) await Bun.sleep(5);
    expect(received).toEqual(expected);
    expect([first.releases,last.releases]).toEqual([1,1]);
    expect(copied.byteLength).toBe(8*1024*1024);
    expect(writer.bytes).toBe(0);
  } finally { writer.close(); pair.close(); }
},10000);

test('disconnecting a paused real socket releases in-flight and queued owned frames', async () => {
  const pair = await socketPair(()=>{}), writer = new PacketWriter(pair.client);
  const closed = new Promise(resolve => pair.client.once('close',resolve));
  const first = tracked(8*1024*1024), second = tracked(8*1024*1024);
  try {
    writer.send({id:1},first.pixels,{takeOwnership:true});
    writer.send({id:2},second.pixels,{takeOwnership:true});
    await Bun.sleep(40);
    expect(second.releases).toBe(0);
    pair.peer.destroy(); await closed;
    expect([first.releases,second.releases]).toEqual([1,1]);
    expect(writer.bytes).toBe(0);
  } finally {writer.close();pair.close();}
},10000);
