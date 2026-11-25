// Address complete slices within one image. Each slice can use the regular
// bilinear sampler after mapping the logical texture coordinates into its tile.
export function volumeSampler(key,arrayTexture) {
  const dim='_sw_dim_'+key, wrap='_sw_wrap_'+key, fetch='_sw_volumeTexel_'+key;
  const border='_sw_border_'+key, slice='_sw_slice_'+key;
  return `uniform shader ${key}; uniform float4 ${dim}; uniform float4 ${wrap}; uniform float ${border};
float _sw_wrap_${key}_axis(float p,float n,float mode){
 if(mode==1)return mod(p,n);
 if(mode==2){float r=mod(p,2*n);return r<n?r:2*n-1-r;}
 return clamp(p,0,n-1);
}
float4 ${fetch}(float3 p){
 float3 n=${dim}.xyz;
 p=float3(_sw_wrap_${key}_axis(p.x,n.x,${wrap}.x),_sw_wrap_${key}_axis(p.y,n.y,${wrap}.y),_sw_wrap_${key}_axis(p.z,n.z,${arrayTexture?'0':wrap+'.z'}));
 float2 tile=float2(mod(p.z,${dim}.w),floor(p.z/${dim}.w));
 return float4(${key}.eval(tile*(n.xy+${border})+p.xy+0.5));
}
float4 _sw_fetch_${key}(int3 p,int level){return ${fetch}(float3(p));}
int3 _sw_size_${key}(int level){return int3(${dim}.xyz);}
float _sw_linear_${key}_axis(float p,float n,float mode){
 if(mode==1)return mod(p,n);
 if(mode==2){float r=mod(p+0.5,2*n);return clamp(min(r,2*n-r)-0.5,0,n-1);}
 return clamp(p,0,n-1);
}
float4 ${slice}(float z,float2 xy){
 float2 n=${dim}.xy;
 float2 tile=float2(mod(z,${dim}.w),floor(z/${dim}.w))*(n+${border})+0.5;
 if(${border}==0 && (xy.x>n.x-1 || xy.y>n.y-1)){
  float2 a=floor(xy),b=mod(a+1,n),f=fract(xy);
  float4 x0=mix(float4(${key}.eval(tile+a)),float4(${key}.eval(tile+float2(b.x,a.y))),f.x);
  float4 x1=mix(float4(${key}.eval(tile+float2(a.x,b.y))),float4(${key}.eval(tile+b)),f.x);
  return mix(x0,x1,f.y);
 }
 return float4(${key}.eval(tile+xy));
}
float4 _sw_sample_${key}(float3 uv){
 float3 n=${dim}.xyz,p=uv*n;
 ${arrayTexture?'p.z=floor(uv.z+0.5)+0.5;':''}
 if(${wrap}.w==0)return ${fetch}(floor(p));
 p-=0.5;
 float2 xy=float2(_sw_linear_${key}_axis(p.x,n.x,${wrap}.x),_sw_linear_${key}_axis(p.y,n.y,${wrap}.y));
 float z=floor(p.z);
 float lo=_sw_wrap_${key}_axis(z,n.z,${arrayTexture?'0':wrap+'.z'});
 float4 a=${slice}(lo,xy);
 ${arrayTexture?'return a;':`float hi=_sw_wrap_${key}_axis(z+1,n.z,${wrap}.z);
 return mix(a,${slice}(hi,xy),fract(p.z));`}
}`;
}
