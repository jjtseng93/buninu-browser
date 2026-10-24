import {inflateSync} from 'node:zlib';

// QSB v9 stores QDataStream shader keys followed by length-prefixed source and
// entrypoint QByteArrays. Reflection is intentionally opaque; validate complete
// GLSL records rather than depending on its changing private schema.
export function fragmentSource(bytes) {
  bytes=Buffer.from(bytes);
  if(bytes.subarray(0,256).toString().trimStart().startsWith('#version'))return bytes.toString();
  const limit=8*1024*1024;
  if(bytes.length<8||bytes.readUInt32BE(0)>limit)throw Error('Invalid or oversized QSB');
  const data=inflateSync(bytes.subarray(4),{maxOutputLength:limit});
  if(data.length!==bytes.readUInt32BE(0)||data.length<8||data.readUInt32BE(0)!==9||data.readUInt32BE(4)!==4)throw Error('Only QSB v9 fragment packages are supported');
  const candidates=[];
  for(let p=20;p<data.length;p++) {
    if(data[p]!==35||data.subarray(p,p+8).toString()!=='#version')continue;
    const size=data.readUInt32BE(p-4),end=p+size;
    if(data.readUInt32BE(p-20)!==1||data.readUInt32BE(p-8)!==0||size>limit||end+8>data.length)continue;
    const version=data.readUInt32BE(p-16),flags=data.readUInt32BE(p-12);
    if(flags!==0||version<150||version>460)continue;
    if(data.readUInt32BE(end)!==4||data.subarray(end+4,end+8).toString()!=='main')continue;
    const source=data.subarray(p,end).toString();
    if(!source.startsWith(`#version ${version}`)||source.includes('\0'))continue;
    candidates.push({version,source});p=end+7;
  }
  if(!candidates.length)throw Error('QSB has no supported standard desktop GLSL fragment');
  return candidates.sort((a,b)=>a.version-b.version)[0].source;
}
