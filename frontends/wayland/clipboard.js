// A standard wl_data_device text client. Only explicit copy/paste transfers bytes.
import {readSync, writeSync} from 'node:fs';
import {libc} from './transport.js';
const mimeTypes=['text/plain;charset=utf-8','text/plain','UTF8_STRING','STRING'];
const limit=1024*1024;
export class WaylandClipboard {
  constructor(client) {
    this.client=client;this.serial=0;this.offers=new Map();this.sources=new Set();this.closed=false;
    const c=client;
    this.manager=c.bind('wl_data_device_manager',1);
    const seat=c.bind('wl_seat',1);
    this.device=c.object('wl_data_device',(event,args)=>{
      if(event==='data_offer') {
        const id=args[0],types=new Set();this.offers.set(id,types);
        c.objects.set(id,{iface:'wl_data_offer',event:(name,[mime])=>{if(name==='offer')types.add(mime);}});
      }
      if(event==='selection') {
        this.selection=args[0];
        for(const id of this.offers.keys())if(id!==this.selection){c.request(id,'destroy');this.offers.delete(id);c.objects.delete(id);}
      }
    });c.request(this.manager,'get_data_device',this.device,seat);
  }
  async transfer(fd,bytes) {
    const chunks=[];let length=0,offset=0;const deadline=Date.now()+2500;
    try {
      libc.fcntl(fd,4,libc.fcntl(fd,3,0)|2048);
      while(!this.closed&&Date.now()<deadline) {
        try {
          if(bytes) {
            if(offset===bytes.length)return;
            offset+=writeSync(fd,bytes,offset,bytes.length-offset);
          } else {
            const chunk=Buffer.alloc(65536),n=readSync(fd,chunk,0,chunk.length,null);
            if(!n)return Buffer.concat(chunks).toString();
            length+=n;if(length>limit)throw Error('Clipboard exceeds limit');chunks.push(chunk.subarray(0,n));
          }
        } catch(error) {if(!['EAGAIN','EINTR','EWOULDBLOCK'].includes(error.code))throw error;}
        await Bun.sleep(4);
      }
      throw Error('Clipboard transfer interrupted or timed out');
    } finally {libc.close(fd);}
  }
  async write(text) {
    if(this.closed||!this.serial)throw Error('Clipboard requires focused Wayland input');
    const bytes=Buffer.from(text);if(bytes.length>limit)throw Error('Clipboard exceeds limit');
    const c=this.client;
    const source=c.object('wl_data_source',(name,args)=>{
      if(name==='send') {
        if(!mimeTypes.includes(args[0]))libc.close(args[1]);
        else this.transfer(args[1],bytes).catch(()=>{});
      }
      if(name==='cancelled') {c.request(source,'destroy');this.sources.delete(source);}
    });
    this.sources.add(source);
    c.request(this.manager,'create_data_source',source);
    for(const mime of mimeTypes)c.request(source,'offer',mime);
    c.request(this.device,'set_selection',source,this.serial);
    await c.sync();
  }
  async read() {
    if(this.closed)throw Error('Clipboard closed');
    const types=this.offers.get(this.selection),mime=mimeTypes.find(type=>types?.has(type));
    if(!mime)return '';
    const fds=new Int32Array(2);if(libc.pipe2(fds,2048|0x80000)<0)throw Error('Cannot create clipboard pipe');
    try{this.client.request(this.selection,'receive',mime,fds[1]);}
    catch(error){libc.close(fds[0]);throw error;}
    finally{libc.close(fds[1]);}
    return this.transfer(fds[0]);
  }
  close(){this.closed=true;}
}

// The standard data device belongs to every Wayland frontend, not QML.
export function attachClipboard(client,done) {
  if(!client.globals.has('wl_data_device_manager'))return;
  const clipboard=new WaylandClipboard(client);
  client.clipboard=clipboard;
  done.finally(()=>clipboard.close());
  return clipboard;
}
