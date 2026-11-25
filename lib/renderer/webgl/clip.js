// Homogeneous clipping preserves attributes before perspective division.
export function clipTriangles(vertices, indices, stride, flatComponents=[]) {
 const count=vertices.length/stride, codes=new Uint8Array(count);
 let allInside=true, common=63;
 for(let i=0;i<count;i++){
  const at=i*stride,w=vertices[at+3];let code=0;
  for(let c=0;c<3;c++){
   const v=vertices[at+c];
   if(v < -w)code|=1<<(2*c);
   if(v > w)code|=2<<(2*c);
  }
  for(let c=0;c<4;c++)if(!Number.isFinite(vertices[at+c])){code=64;break;}
  codes[i]=code;common&=code;if(code)allInside=false;
 }
 if(allInside)return {vertices,indices};
 if(common)return {vertices,indices:[]};
 const outIndices=[],remap=new Int32Array(count).fill(-1);
 let output=new Float32Array(0),used=0;
 function reserve(extra){
  if(used+extra<=output.length)return;
  const capacity=Math.max(used+extra,Math.min(1024*stride,vertices.length),2*output.length);
  const next=new Float32Array(capacity);next.set(output);output=next;
 }
 function original(i){
  if(remap[i]<0){
   reserve(stride);remap[i]=used/stride;
   for(let c=0;c<stride;c++)output[used++]=vertices[i*stride+c];
  }
  return remap[i];
 }
 // Intersecting a convex triangle with each plane adds at most one vertex.
 // Keep two scratch polygons per draw; only final vertices round to float32.
 let polygon,scratch;
 for(let t=0;t+2<indices.length;t+=3){
  const a=indices[t],b=indices[t+1],c=indices[t+2];
  const ca=codes[a],cb=codes[b],cc=codes[c],planes=ca|cb|cc;
  if(planes&64||ca&cb&cc)continue;
  if(!planes){outIndices.push(original(a),original(b),original(c));continue;}
  if(!polygon){polygon=new Float64Array(9*stride);scratch=new Float64Array(9*stride);}
  let length=3;
  for(let i=0;i<3;i++){
   const offset=indices[t+i]*stride;
   for(let j=0;j<stride;j++)polygon[i*stride+j]=vertices[offset+j];
  }
  for(let plane=0;plane<6&&length;plane++){
   if(!(planes&(1<<plane)))continue;
   // Leave room for one intersection per edge even for degenerate input
   // whose coordinates lie within roundoff of several clipping planes.
   if(2*length*stride>scratch.length)scratch=new Float64Array(2*length*stride);
   const axis=plane>>1,sign=plane&1?-1:1;
   let prev=(length-1)*stride,da=polygon[prev+3]+sign*polygon[prev+axis],end=0;
   for(let pos=0;pos<length*stride;pos+=stride){
    const db=polygon[pos+3]+sign*polygon[pos+axis];
    if((da>=0)!==(db>=0)){
     const w=da/(da-db);
     for(let j=0;j<stride;j++)scratch[end++]=polygon[prev+j]+(polygon[pos+j]-polygon[prev+j])*w;
    }
    if(db>=0)for(let j=0;j<stride;j++)scratch[end++]=polygon[pos+j];
    prev=pos;da=db;
   }
   length=end/stride;
   const swapped=polygon;polygon=scratch;scratch=swapped;
  }
  if(length<3)continue;
  reserve(length*stride);
  const first=used/stride;
  for(let v=0;v<length;v++){
   const start=used;
   for(let j=0;j<stride;j++)output[used++]=polygon[v*stride+j];
   // Triangulating a clipped polygon changes which vertex is last. Flat
   // inputs still come from the original primitive's provoking vertex.
   for(const component of flatComponents)output[start+component]=vertices[c*stride+component];
  }
  for(let i=1;i+1<length;i++)outIndices.push(first,first+i,first+i+1);
 }
 return {vertices:output.subarray(0,used),indices:outIndices};
}
