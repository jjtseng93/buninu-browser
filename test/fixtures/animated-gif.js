// Tiny deterministic GIF encoder for tests; clear between pixels keeps LZW at 3 bits.
export function animatedGif({width=1,height=1,loop=0,frames=[
 {pixels:[0],delay:10},{pixels:[1],delay:20}]}={}) {
 const out=[...Buffer.from('GIF89a'),width&255,width>>8,height&255,height>>8,0x81,0,0,
  255,0,0,0,255,0,0,0,255,0,0,0];
 const word=n=>[n&255,n>>8];
 if(loop!==null)out.push(33,255,11,...Buffer.from('NETSCAPE2.0'),3,1,...word(loop),0);
 for(const f of frames){
  const codes=f.pixels.flatMap(n=>[4,n]);codes.push(5);
  const data=[];let bits=0,value=0;
  for(const code of codes){value|=code<<bits;bits+=3;if(bits>=8){data.push(value&255);value>>=8;bits-=8}}
  if(bits)data.push(value&255);
  out.push(33,249,4,((f.disposal??1)<<2)|(f.transparent!==undefined?1:0),
   ...word(f.delay??10),f.transparent??0,0,44,...word(f.x??0),...word(f.y??0),
   ...word(f.width??width),...word(f.height??height),0,2,data.length,...data,0);
 }
 out.push(59);return Buffer.from(out);
}
