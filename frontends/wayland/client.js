import {join,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {openSync,closeSync,ftruncateSync,unlinkSync,writeSync} from 'node:fs';
import {connectUnix} from './transport.js';
import {interfaces,decode,encodeRequest} from './protocol.js';

export class WaylandClient {
  constructor(path) {
    const display=process.env.WAYLAND_DISPLAY || 'wayland-0';
    this.connection=connectUnix(path || (isAbsolute(display)?display:join(process.env.XDG_RUNTIME_DIR||tmpdir(),display)));
    this.objects=new Map();this.nextId=2;this.globals=new Map();this.waiters=new Set();
    this.objects.set(1,{iface:'wl_display',event:(name,args)=>{
      if(name==='error')throw Error(`Wayland error ${args.join(': ')}`);
      if(name==='delete_id')this.objects.delete(args[0]);
    }});
    this.connection.onData=()=>this.receive();
    this.connection.onClose=()=>{clearInterval(this.timer);for(const reject of this.waiters)reject(Error('Wayland disconnected'));this.waiters.clear();this.onClose?.();};
    this.timer=setInterval(()=>this.connection.poll(),4);
  }
  object(iface,event=()=>{}) {const id=this.nextId++;this.objects.set(id,{iface,event});return id;}
  request(id,name,...args) {const object=this.objects.get(id);if(!object)throw Error(`Unknown object ${id}`);const packet=encodeRequest(id,object.iface,name,args);this.connection.send(packet.data,packet.fds);this.connection.flush();}
  receive() {
    const c=this.connection;
    while(!c.closed&&c.input.length>=8){
      const id=c.input.readUInt32LE(0),header=c.input.readUInt32LE(4),size=header>>>16,opcode=header&65535;
      if(size<8||size%4)throw Error('Invalid event size');if(c.input.length<size)return;
      const object=this.objects.get(id),spec=interfaces.get(object?.iface)?.events[opcode];
      if(!spec)throw Error(`Unknown event ${id}:${opcode}`);
      const args=decode(spec,c.input.subarray(0,size),c.fds);if(args===null)return;
      c.input=c.input.subarray(size);object.event(spec.name,args);
    }
  }
  sync() {return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{this.waiters.delete(fail);reject(Error('Wayland roundtrip timeout'));},5000);
    const fail=e=>{clearTimeout(timer);reject(e);};this.waiters.add(fail);
    const id=this.object('wl_callback',()=>{clearTimeout(timer);this.waiters.delete(fail);resolve();});this.request(1,'sync',id);
  });}
  async initialize() {
    this.registry=this.object('wl_registry',(event,[name,iface,version])=>{
      if(event==='global')this.globals.set(iface,{name,version});
      else for(const [key,value]of this.globals)if(value.name===name)this.globals.delete(key);
    });this.request(1,'get_registry',this.registry);await this.sync();
    this.compositor=this.bind('wl_compositor',4);this.shm=this.bind('wl_shm',1);
    this.shell=this.bind('xdg_wm_base',1,(event,[serial])=>{if(event==='ping')this.request(this.shell,'pong',serial);});
    await this.sync();return this;
  }
  bind(iface,version,event) {const global=this.globals.get(iface);if(!global)throw Error(`Compositor lacks ${iface}`);const id=this.object(iface,event);this.request(this.registry,'bind',global.name,iface,Math.min(version,global.version),id);return id;}
  close(){this.connection.close();}
}

export class WaylandWindow {
  constructor(client,{width=800,height=600,title='Buninu Browser'}={}) {
    this.client=client;this.width=width;this.height=height;this.buffers=[];this.configured=false;this.framePending=false;
    const c=client;
    this.surface=c.object('wl_surface');c.request(c.compositor,'create_surface',this.surface);
    this.xdg=c.object('xdg_surface',(event,[serial])=>{
      if(event!=='configure')return;c.request(this.xdg,'ack_configure',serial);this.configured=true;
      if(this.pendingSize){[this.width,this.height]=this.pendingSize;this.pendingSize=null;}
      this.onConfigure?.(this.width,this.height);
    });c.request(c.shell,'get_xdg_surface',this.xdg,this.surface);
    this.toplevel=c.object('xdg_toplevel',(event,args)=>{
      if(event==='configure')this.pendingSize=[args[0]||this.width,args[1]||this.height];
      if(event==='close')this.onClose?.();
    });c.request(this.xdg,'get_toplevel',this.toplevel);c.request(this.toplevel,'set_title',title);c.request(this.toplevel,'set_app_id','org.buninu.browser');c.request(this.surface,'commit');
  }
  get available(){return this.configured&&!this.framePending&&this.buffers.filter(b=>b.busy).length<2;}
  present(bytes,width,height) {
    if(!this.available||width!==this.width||height!==this.height)return false;
    const c=this.client,size=width*height*4,parts=Array.isArray(bytes)?bytes:[bytes];if(parts.reduce((sum,part)=>sum+part.length,0)!==size)throw Error('Invalid raw pixel length');
    for(const b of [...this.buffers])if(!b.busy&&(b.width!==width||b.height!==height))this.disposeBuffer(b);
    let b=this.buffers.find(b=>!b.busy);
    if(!b){
      const path=join(process.env.XDG_RUNTIME_DIR||tmpdir(),`buninu-shm-${process.pid}-${crypto.randomUUID()}`);
      const fd=openSync(path,'wx+',0o600);unlinkSync(path);
      try{ftruncateSync(fd,size);
        b={fd,width,height,busy:false};const pool=c.object('wl_shm_pool');c.request(c.shm,'create_pool',pool,fd,size);
        b.id=c.object('wl_buffer',(event)=>{if(event==='release'){b.busy=false;this.onReady?.();}});
        c.request(pool,'create_buffer',b.id,0,width,height,width*4,1);c.request(pool,'destroy');this.buffers.push(b);
      }catch(e){closeSync(fd);throw e;}
    }
    let position=0;for(const part of parts){let written=0;while(written<part.length){const n=writeSync(b.fd,part,written,part.length-written,position);if(!n)throw Error('Short SHM write');written+=n;position+=n;}}
    b.busy=true;this.framePending=true;
    const callback=c.object('wl_callback',()=>{this.framePending=false;this.onReady?.();});
    c.request(this.surface,'attach',b.id,0,0);c.request(this.surface,'damage',0,0,width,height);c.request(this.surface,'frame',callback);c.request(this.surface,'commit');return true;
  }
  disposeBuffer(b){this.client.request(b.id,'destroy');closeSync(b.fd);this.buffers.splice(this.buffers.indexOf(b),1);}
  close(){if(this.closed)return;this.closed=true;for(const b of [...this.buffers])this.disposeBuffer(b);this.client.request(this.toplevel,'destroy');this.client.request(this.xdg,'destroy');this.client.request(this.surface,'destroy');}
}
