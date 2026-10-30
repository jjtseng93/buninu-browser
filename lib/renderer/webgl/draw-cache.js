// Exact draw reuse: geometry and shading are independent of other objects'
// depth. Keep a geometric depth map with the image; reapply live depth on hits.
export class DrawCache {
 constructor(){this.entries=new Map();this.bytes=0;this.ids=new WeakMap();this.next=0;}
 id(object){let id=this.ids.get(object);if(!id){id=++this.next;this.ids.set(object,id);}return id;}
 key(program,samplers,settings,size,inputs,indices){
  const hash=new Bun.CryptoHasher('sha256');
  hash.update(JSON.stringify([this.id(program.vertex),this.id(program.fragment),size,
   settings.vp,[...settings.enabled].sort(),settings.depthFunc,settings.writeDepth,settings.front,settings.cull,
   [...program.values],samplers.map(s=>[s.version,s.width,s.height,s.mag,s.min,s.wrapS,s.wrapT])]));
  for(const [name,data]of inputs){hash.update(name);hash.update(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));}
  hash.update(new Uint32Array(indices));return hash.digest('hex');
 }
 get(key){const entry=this.entries.get(key);if(entry){this.entries.delete(key);this.entries.set(key,entry);}return entry;}
 put(key,pixels,left,top,width,height,depth){
  const bytes=pixels.byteLength+(depth?.byteLength??0);if(!key||bytes>32*1024*1024)return false;
  const previous=this.entries.get(key);if(previous){this.bytes-=previous.bytes;this.entries.delete(key);}
  while(this.bytes+bytes>32*1024*1024||this.entries.size>=64){const first=this.entries.keys().next().value,old=this.entries.get(first);this.bytes-=old.bytes;this.entries.delete(first);}
  this.entries.set(key,{pixels,left,top,width,height,depth,bytes});this.bytes+=bytes;return true;
 }
 clear(){this.entries.clear();this.bytes=0;}
}
