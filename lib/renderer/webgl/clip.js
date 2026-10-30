// Homogeneous clipping preserves attributes before perspective division.
export function clipTriangles(vertices, indices, stride) {
 // Most meshes are wholly inside the frustum. Keep their indexed vertices;
 // expanding every triangle here duplicates vertices and allocates six sets
 // of clipping polygons despite not changing the geometry.
 let inside=true;
 for(let i=0;i<vertices.length&&inside;i+=stride){
  const w=vertices[i+3];
  for(let c=0;c<stride;c++)if(!Number.isFinite(vertices[i+c])){inside=false;break;}
  if(w<0||Math.abs(vertices[i])>w||Math.abs(vertices[i+1])>w||Math.abs(vertices[i+2])>w)inside=false;
 }
 if(inside)return {vertices,indices};
 const output=[],outIndices=[];
 const distance=(v,plane)=>v[3]+(plane&1?-1:1)*v[plane>>1];
 for(let t=0;t+2<indices.length;t+=3){let polygon=indices.slice(t,t+3).map(i=>Array.from(vertices.subarray(i*stride,(i+1)*stride)));
  if(polygon.some(v=>!v.every(Number.isFinite)))continue;
  for(let plane=0;plane<6&&polygon.length;plane++){
   const next=[];let a=polygon.at(-1),da=distance(a,plane);
   for(const b of polygon){const db=distance(b,plane);if((da>=0)!==(db>=0)){const w=da/(da-db);next.push(a.map((v,i)=>v+(b[i]-v)*w));}if(db>=0)next.push(b);a=b;da=db;}polygon=next;
  }
  for(let i=1;i+1<polygon.length;i++)for(const v of [polygon[0],polygon[i],polygon[i+1]]){outIndices.push(output.length/stride);output.push(...v);}
 }
 return {vertices:new Float32Array(output),indices:outIndices};
}
