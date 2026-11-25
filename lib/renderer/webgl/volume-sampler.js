// Texture levels are tiled in a 2D CPU image. Interpolate texels in volume
// coordinates so filtering cannot bleed into an adjacent tile.
export function volumeSampler(key,arrayTexture) {
  const dim='_sw_dim_'+key, wrap='_sw_wrap_'+key, fetch='_sw_volumeTexel_'+key;
  return `uniform shader ${key}; uniform float4 ${dim}; uniform float4 ${wrap};
float _sw_wrap_${key}_axis(float p,float n,float mode){
 if(mode==1)return mod(p,n);
 if(mode==2){float r=mod(p,2*n);return r<n?r:2*n-1-r;}
 return clamp(p,0,n-1);
}
float4 ${fetch}(float3 p){
 float3 n=${dim}.xyz;
 p=float3(_sw_wrap_${key}_axis(p.x,n.x,${wrap}.x),_sw_wrap_${key}_axis(p.y,n.y,${wrap}.y),_sw_wrap_${key}_axis(p.z,n.z,${arrayTexture?'0':wrap+'.z'}));
 float2 tile=float2(mod(p.z,${dim}.w),floor(p.z/${dim}.w));
 return float4(${key}.eval(tile*n.xy+p.xy+0.5));
}
float4 _sw_fetch_${key}(int3 p,int level){return ${fetch}(float3(p));}
int3 _sw_size_${key}(int level){return int3(${dim}.xyz);}
float4 _sw_sample_${key}(float3 uv){
 float3 p=uv*${dim}.xyz;
 ${arrayTexture?'p.z=floor(uv.z+0.5)+0.5;':''}
 if(${wrap}.w==0)return ${fetch}(floor(p));
 p-=0.5;float3 f=fract(p);p=floor(p);
 float4 lo=mix(mix(${fetch}(p),${fetch}(p+float3(1,0,0)),f.x),mix(${fetch}(p+float3(0,1,0)),${fetch}(p+float3(1,1,0)),f.x),f.y);
 ${arrayTexture?'return lo;':`p.z+=1;float4 hi=mix(mix(${fetch}(p),${fetch}(p+float3(1,0,0)),f.x),mix(${fetch}(p+float3(0,1,0)),${fetch}(p+float3(1,1,0)),f.x),f.y);return mix(lo,hi,f.z);`}
}`;
}
