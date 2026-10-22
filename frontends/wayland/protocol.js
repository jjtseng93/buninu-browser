// Adapted from buninu-land (MIT; LICENSE-land); XML files unchanged.
// Interpret upstream XML with Bun's built-in parser at runtime; no generated bindings.
import { readFileSync } from 'node:fs';
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const attrs = node => Object.fromEntries(Object.entries(node).filter(([k]) => k.startsWith('@')).map(([k,v]) => [k.slice(1), v]));
export const interfaces = new Map();
for (const file of ['wayland', 'xdg-shell']) {
  const xml = Bun.XML.parse(readFileSync(new URL(`./protocols/${file}.xml`, import.meta.url), 'utf8'));
  for (const node of list(xml.protocol.interface)) {
    const spec = { ...attrs(node) };
    for (const [tag, key] of [['request', 'requests'], ['event', 'events']])
      spec[key] = list(node[tag]).map(message => ({ ...attrs(message), args: list(message.arg).map(attrs) }));
    interfaces.set(spec.name, spec);
  }
}
export function decode(spec, bytes, fds) {
  let offset = 8, fdOffset = 0;
  const values = [];
  const word = () => { if (offset + 4 > bytes.length) throw Error('Truncated argument'); const v = bytes.readUInt32LE(offset); offset += 4; return v; };
  for (const arg of spec.args) {
    if (arg.type === 'fd') { if (fdOffset === fds.length) return null; values.push(fds[fdOffset++]); continue; }
    if (arg.type === 'new_id' && !arg.interface) {
      const n = word(); if (!n || offset + n > bytes.length || bytes[offset + n - 1]) throw Error('Invalid interface string');
      values.push(bytes.toString('utf8', offset, offset + n - 1)); offset += (n + 3) & ~3;
      values.push(word(), word()); continue;
    }
    const v = word();
    if (arg.type === 'string' || arg.type === 'array') {
      if (offset + v > bytes.length) throw Error('Truncated array/string');
      if (arg.type === 'string' && v && bytes[offset + v - 1]) throw Error('Unterminated string');
      values.push(arg.type === 'string' ? (v ? bytes.toString('utf8', offset, offset + v - 1) : null) : bytes.subarray(offset, offset + v));
      offset += (v + 3) & ~3;
    } else values.push(arg.type === 'fixed' ? (v | 0) / 256 : arg.type === 'int' ? v | 0 : v);
  }
  if (offset !== bytes.length) throw Error('Invalid message size');
  fds.splice(0, fdOffset);
  return values;
}
export function encodeRequest(id, iface, name, values) {
  const requests=interfaces.get(iface).requests, opcode=requests.findIndex(e=>e.name===name);
  if(opcode<0)throw Error(`Unknown request ${iface}.${name}`);
  const parts=[Buffer.alloc(8)],fds=[];
  const word=v=>{const b=Buffer.alloc(4);b.writeUInt32LE(Number(v)>>>0);parts.push(b);};
  const bytes=(value,string)=>{const b=string?Buffer.from(value==null?'':value+'\0'):Buffer.from(value);const p=Buffer.alloc(4+((b.length+3)&~3));p.writeUInt32LE(b.length);b.copy(p,4);parts.push(p);};
  let i=0;
  for(const arg of requests[opcode].args){
    const v=values[i++];
    if(arg.type==='fd'){fds.push(v);continue;}
    if(arg.type==='new_id'&&!arg.interface){bytes(v,true);word(values[i++]);word(values[i++]);}
    else if(arg.type==='string'||arg.type==='array')bytes(v,arg.type==='string');
    else word(arg.type==='fixed'?Math.round(v*256):v);
  }
  const data=Buffer.concat(parts);if(data.length>65535)throw Error('Wayland message too large');
  data.writeUInt32LE(id);data.writeUInt32LE((data.length<<16)|opcode,4);return {data,fds};
}
