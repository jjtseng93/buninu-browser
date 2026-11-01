// A Windows-only envelope around unchanged Wayland bytes and FD argument order.
// ACKs keep mapping names alive until the receiver has opened its own handles.
export class MappingConnection {
 constructor(resources,removed=()=>{}){
  this.resources=resources;this.removed=removed;this.fds=[];this.input=Buffer.alloc(0);this.wire=Buffer.alloc(0);
  this.output=[];this.queuedBytes=0;this.pending=new Map();this.next=1;this.closed=false;
 }
 attach(socket){this.socket=socket;this.flush()}
 packet(meta,data=Buffer.alloc(0)){
  const json=Buffer.from(JSON.stringify(meta)),body=Buffer.alloc(8+json.length+data.length);
  body.writeUInt32LE(4+json.length+data.length);body.writeUInt32LE(json.length,4);json.copy(body,8);data.copy(body,8+json.length);
  if(this.queuedBytes+body.length>4*1024*1024)throw Error('Output queue limit');
  this.output.push(body);this.queuedBytes+=body.length;this.flush();
 }
 send(bytes,fds=[]){
  if(this.closed)return;
  if(this.pending.size>=256)throw Error('Resource ACK queue limit');
  const held=[];
  try{
   for(const fd of fds)held.push(this.resources.sendResource(fd));
   const id=this.next++;if(held.length)this.pending.set(id,held);
   this.packet({version:1,id,resources:held.map(h=>h.descriptor)},bytes);
  }catch(e){for(const h of held)h.release();this.close();throw e}
 }
 flush(){
  try { while(!this.closed&&this.socket&&this.output.length){
   const b=this.output[0],n=this.socket.write(b);if(n<0){this.close();return}if(!n)return;
   this.queuedBytes-=n;if(n<b.length){this.output[0]=b.subarray(n);return}this.output.shift();
  }} catch(error){this.error=error;this.close()}
 }
 receive(bytes){
  try{
   this.wire=Buffer.concat([this.wire,bytes]);
   if(this.wire.length>2*1024*1024)throw Error('Input queue limit');
   while(this.wire.length>=8){
    const size=this.wire.readUInt32LE(),jsonSize=this.wire.readUInt32LE(4);
    if(size<4||size>1024*1024||jsonSize>65536||jsonSize>size-4)throw Error('Invalid envelope');
    if(this.wire.length<size+4)return;
    const meta=JSON.parse(this.wire.subarray(8,8+jsonSize).toString()),data=this.wire.subarray(8+jsonSize,size+4);
    this.wire=this.wire.subarray(size+4);
    if(meta.version!==1)throw Error('Unknown mapping transport version');
    if(meta.ack!==undefined){
     const held=this.pending.get(meta.ack);if(!held||data.length)throw Error('Invalid resource ACK');
     this.pending.delete(meta.ack);for(const h of held)h.release();continue;
    }
    if(!Number.isSafeInteger(meta.id)||!Array.isArray(meta.resources)||meta.resources.length>256)throw Error('Invalid resource packet');
    for(const d of meta.resources)this.fds.push(this.resources.receiveResource(d));
    if(meta.resources.length)this.packet({version:1,ack:meta.id});
    this.input=Buffer.concat([this.input,data]);
    if(this.input.length>1024*1024||this.fds.length>256)throw Error('Wayland queue limit');
    this.onData?.();if(this.closed)return;
   }
  }catch(error){this.error=error;this.close()}
 }
 poll(){this.flush()}
 close(){
  if(this.closed)return;this.closed=true;try{this.socket?.end()}catch{}
  for(const held of this.pending.values())for(const h of held)h.release();this.pending.clear();
  for(const fd of this.fds)this.resources.closeResource(fd);this.fds=[];this.output=[];this.queuedBytes=0;
  try{this.onClose?.()}finally{this.removed()}
 }
}
