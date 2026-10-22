// Adapted from buninu-land/lib/transport.js (MIT; LICENSE-land).
// Linux 64-bit ABI. Only libc is loaded. recvmsg is required for SCM_RIGHTS;
// Bun's stream sockets do not expose ancillary file descriptors.
import { dlopen, ptr } from 'bun:ffi';

if (!['arm64', 'x64'].includes(process.arch) || !['linux', 'android'].includes(process.platform)) throw Error('Requires 64-bit Linux or Android');
const signature = (args, returns = 'i32') => ({ args, returns });
let library;
let errnoSymbol;
// Same architecture-specific libc names as buninu-linux's /lib/dlopen.js.
const muslLibc = `libc.musl-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`;
const candidates = process.platform === 'android'
  ? [['libc.so', '__errno']]
  : [
      ['libc.so.6', '__errno_location'],
      [muslLibc, '__errno_location'],
      [`/lib/${muslLibc}`, '__errno_location'],
      ['libc.so', '__errno_location'],
      ['libc.so', '__errno'],
    ];
const failures = [];
for (const [name, symbol] of candidates) {
  try { library = dlopen(name, {
    connect: signature(['i32','ptr','u32']), socket: signature(['i32','i32','i32']),
    recvmsg: signature(['i32','ptr','i32'], 'i64'), sendmsg: signature(['i32','ptr','i32'], 'i64'),
    dup: signature(['i32']), send: signature(['i32','ptr','u64','i32'], 'i64'), close: signature(['i32']),
    [symbol]: signature([], 'ptr'),
  }); errnoSymbol = symbol; break; }
  catch (error) { failures.push(`${name} (${symbol}): ${error.message}`); }
}
if (!library) throw Error(`Cannot load libc on ${process.platform}:\n${failures.join('\n')}`);
export const libc = library.symbols;
import { toArrayBuffer } from 'bun:ffi';
export const errno = () => new Int32Array(toArrayBuffer(libc[errnoSymbol](), 0, 4))[0];
const retry = () => [4,11].includes(errno());
export class Connection {
  constructor(fd, removed) {
    this.fd = fd; this.removed = removed; this.fds = []; this.input = Buffer.alloc(0); this.output = []; this.queuedBytes = 0;
    this.data = Buffer.alloc(65536); this.control = Buffer.alloc(4096); this.iov = Buffer.alloc(16); this.msg = Buffer.alloc(56);
    this.iov.writeBigUInt64LE(BigInt(ptr(this.data))); this.iov.writeBigUInt64LE(BigInt(this.data.length), 8);
    this.msg.writeBigUInt64LE(BigInt(ptr(this.iov)), 16); this.msg.writeBigUInt64LE(1n, 24);
    this.msg.writeBigUInt64LE(BigInt(ptr(this.control)), 32);
  }
  send(bytes, fds = []) {
    if (this.closed) return;
    const owned = [];
    try { for (const fd of fds) { const copy = libc.dup(fd); if (copy < 0) throw Error('Cannot duplicate outgoing FD'); owned.push(copy); } }
    catch (e) { for (const fd of owned) libc.close(fd); throw e; }
    this.output.push({ bytes, fds: owned }); this.queuedBytes += bytes.length;
    if (this.queuedBytes > 4*1024*1024) this.close();
  }
  flush() {
    for (let round = 0; round < 64 && this.output.length; round++) {
      const item = this.output[0];
      let n;
      if (item.fds.length) {
        const iov = Buffer.alloc(16), msg = Buffer.alloc(56);
        const size = 16 + item.fds.length * 4, control = Buffer.alloc(Math.ceil(size / 8) * 8);
        iov.writeBigUInt64LE(BigInt(ptr(item.bytes))); iov.writeBigUInt64LE(BigInt(item.bytes.length), 8);
        control.writeBigUInt64LE(BigInt(size)); control.writeInt32LE(1,8); control.writeInt32LE(1,12);
        item.fds.forEach((fd,i) => control.writeInt32LE(fd,16+i*4));
        msg.writeBigUInt64LE(BigInt(ptr(iov)),16); msg.writeBigUInt64LE(1n,24);
        msg.writeBigUInt64LE(BigInt(ptr(control)),32); msg.writeBigUInt64LE(BigInt(control.length),40);
        n = Number(libc.sendmsg(this.fd,msg,0x4000));
      } else n = Number(libc.send(this.fd,item.bytes,item.bytes.length,0x4000));
      if (n < 0) { if (!retry()) this.close(); return; }
      if (!n) return this.close();
      // SCM_RIGHTS is delivered with the first successfully sent byte, even on partial writes.
      for (const fd of item.fds) libc.close(fd); item.fds = [];
      this.queuedBytes -= n;
      if (n === item.bytes.length) this.output.shift(); else item.bytes = item.bytes.subarray(n);
    }
  }
  poll() {
    if (this.closed) return;
    try {
      for (let round = 0; round < 16; round++) {
        this.msg.writeBigUInt64LE(BigInt(this.control.length), 40); this.msg.writeUInt32LE(0, 48);
        const n = Number(libc.recvmsg(this.fd, this.msg, 0x40000000));
        if (n < 0) { if (retry()) break; return this.close(); }
        if (!n) return this.close();
        const end = Number(this.msg.readBigUInt64LE(40));
        for (let p = 0; p + 16 <= end;) {
          const size = Number(this.control.readBigUInt64LE(p)); if (size < 16 || p + size > end) throw Error('Invalid ancillary data');
          if (this.control.readInt32LE(p+8) === 1 && this.control.readInt32LE(p+12) === 1)
            for (let q = p + 16; q + 4 <= p + size; q += 4) this.fds.push(this.control.readInt32LE(q));
          p += Math.ceil(size / 8) * 8;
        }
        if (this.msg.readUInt32LE(48) & 8) throw Error('Truncated ancillary data');
        this.input = Buffer.concat([this.input, this.data.subarray(0,n)]);
        if (this.input.length > 1024*1024 || this.fds.length > 256) throw Error('Client queue limit');
        this.onData();
      }
      this.flush();
    } catch (e) { console.error(`Wayland client: ${e.message}`);
      // Flush queued requests before disconnecting.
      this.flush();
      this.close(); }
  }
  close() {
    if (this.closed) return; this.closed = true; libc.close(this.fd);
    for (const item of this.output) for (const fd of item.fds) libc.close(fd);
    this.output = []; this.queuedBytes = 0;
    for (const fd of this.fds) libc.close(fd); this.fds = []; this.onClose?.(); this.removed();
  }
}

export function connectUnix(path) {
  if (Buffer.byteLength(path)>107 || path.includes('\0')) throw Error('Invalid Wayland socket path');
  const fd=libc.socket(1,1|0x800|0x80000,0);
  if(fd<0)throw Error(`socket: errno ${errno()}`);
  const address=Buffer.alloc(110); address.writeUInt16LE(1);address.write(path,2);
  if(libc.connect(fd,address,Buffer.byteLength(path)+3)<0){const code=errno();libc.close(fd);throw Error(`connect ${path}: errno ${code}`);}
  return new Connection(fd,()=>{});
}
