import {compileCPUFragment,compileCPUVertex,runCPUVertices} from './cpu-fragment.js';
import {translate,components} from './shaders.js';
export function compileStage(kit,source,stage) {
 const t=translate(source,stage),decl=[],init=[],outputs=[];
 const cpu=stage==='fragment'?compileCPUFragment(t):null,cpuVertex=stage==='vertex'?compileCPUVertex(t):null;
 if(stage==='vertex'){
  decl.push('float4 gl_Position;');
  for(const a of t.attributes){decl.push(`uniform shader _sw_a_${a.name};`);init.push(`${a.name}=${a.type==='float'?'float':'float'+a.size}(_sw_a_${a.name}.eval(float2(_sw_coord.x,0.5))${a.size<4?'.'+'xyzw'.slice(0,a.size):''});`);}
  outputs.push(...['x','y','z','w'].map(c=>'gl_Position.'+c));
  for(const v of t.varyings)outputs.push(...Array.from({length:v.size},(_,i)=>v.size===1?v.name:v.name+'.'+'xyzw'[i]));
  const groups=[];for(let i=0;i<outputs.length;i+=3)groups.push(`if(int(_sw_coord.y)==${i/3})return half4(${[...outputs.slice(i,i+3),...Array(Math.max(0,3-(outputs.length-i))).fill('0')].join(',')},1);`);
  t.code=decl.join('\n')+'\n'+t.code+`\nhalf4 main(float2 _sw_coord){${t.init}${init.join('')}_sw_run();${groups.join('')}return half4(0);}`;
  t.rows=Math.ceil(outputs.length/3);t.outputCount=outputs.length;
 }else{
  const output=t.output||'gl_FragColor';decl.push(`float4 gl_FragCoord; bool gl_FrontFacing;${output==='gl_FragColor'?'float4 gl_FragColor;':''}uniform shader _sw_coverage;`);
  for(const v of t.varyings){decl.push(`uniform shader _sw_v_${v.name};`);init.push(`${v.name}=${v.type==='float'?'float':'float'+v.size}(_sw_v_${v.name}.eval(p)${v.size<4?'.'+'xyzw'.slice(0,v.size):''});`);}
  const derivatives=[];
  // Probe only the prefix that computes derivatives when every derivative is
  // in main's top-level statements. Re-running lighting/tone mapping four
  // times cannot affect those inputs. Other control flow keeps the full path.
  const main=t.code.indexOf('void _sw_run('),body=main<0?-1:t.code.indexOf('{',main);
  const positions=[...t.code.matchAll(/\b(?:dFdx|dFdy)\s*\(/g)].map(m=>m.index);
  let cutoff=-1;
  if(body>=0&&positions.length){let depth=0,valid=true,last=positions.at(-1);
    for(let i=body;i<=last;i++){if(t.code[i]==='{')depth++;if(t.code[i]==='}')depth--;if(positions.includes(i)&&depth!==1)valid=false;}
    if(positions[0]<body)valid=false;
    if(valid)cutoff=t.code.indexOf(';',last);
  }
  let probe=cutoff>=0?t.code.slice(main,cutoff+1).replace('void _sw_run','void _sw_probe')+'}':'';
  t.code=t.code.replace(/\b(dFdx|dFdy)\s*\(/g,(_,op)=>{const name='_sw_derivative'+derivatives.length;derivatives.push({name,op});return name+'(';});
  if(probe){let i=0;probe=probe.replace(/\b(?:dFdx|dFdy)\s*\(/g,()=>derivatives[i++].name+'(');t.code+='\n'+probe;}
  const helpers=derivatives.map(({name})=>`float4 ${name}_value; float4 ${name}_delta;`+Array.from({length:4},(_,i)=>{
    const n=i+1,type=n===1?'float':'float'+n,tail=n<4?','+Array(4-n).fill('0').join(','):'';
    return `${type} ${name}(${type} v){${name}_value=float4(v${tail});return ${name}_delta.${'xyzw'.slice(0,n)};}`;
  }).join('')).join('\n');
  const load=`gl_FragCoord=float4(p.x,hit.y,hit.z,1);gl_FrontFacing=hit.x>0;${t.init}${init.join('')}_sw_run();`;
  const samples=['float2 q=floor(p/2)*2+0.5;',...derivatives.map(d=>`${d.name}_delta=float4(0);`)];
  if(derivatives.length){
    for(let i=0;i<4;i++){
      samples.push(`${probe?'_sw_probe_sample':'_sw_sample'}(q+float2(${i%2},${i>>1}));`);
      for(const d of derivatives)samples.push(`float4 ${d.name}_${i}=${d.name}_value;`);
    }
    for(const d of derivatives)samples.push(`${d.name}_delta=${d.op==='dFdx'?`(mod(floor(p.y),2)==0?${d.name}_1-${d.name}_0:${d.name}_3-${d.name}_2)`:`-(mod(floor(p.x),2)==0?${d.name}_2-${d.name}_0:${d.name}_3-${d.name}_1)`};`);
  }
  const probeLoad=probe?`void _sw_probe_sample(float2 p){float4 hit=_sw_coverage.eval(p);${load.replace('_sw_run();','_sw_probe();')}}`:'';
  t.code=decl.join('\n')+'\n'+helpers+'\n'+t.code+'\n'+probeLoad+`\nvoid _sw_sample(float2 p){float4 hit=_sw_coverage.eval(p);${load}}\nhalf4 main(float2 p){if(_sw_coverage.eval(p).a==0)return half4(0);${samples.join('')}_sw_sample(p);return half4(${output}.rgb*${output}.a,${output}.a);}`;

 }
 t.code=t.code.replace(/\bgl_(\w+)/g,'_sw_gl_$1');
 let log='';const effect=kit.RuntimeEffect.Make(t.code,s=>log+=s);if(!effect)throw Object.assign(Error(log),{shader:t.code});return {...t,effect,cpu,cpuVertex};
}
export function shader(kit,compiled,values,children){
 const e=compiled.effect,data=new Float32Array(e.getUniformFloatCount());
 for(let i=0;i<e.getUniformCount();i++){const name=e.getUniformName(i),info=e.getUniform(i),u=compiled.uniforms.find(u=>u.key===name);let val=values.get(u?.name??name);if(val===undefined)continue;val=typeof val==='number'?[val]:val;data.set(Array.from(val).slice(0,info.columns*info.rows),info.slot);}
 return e.makeShaderWithChildren(data,children);
}
export function floatImage(kit,width,height,data){return kit.MakeImage({width,height,colorType:kit.ColorType.RGBA_F32,alphaType:kit.AlphaType.Premul,colorSpace:kit.ColorSpace.SRGB},new Uint8Array(data.buffer,data.byteOffset,data.byteLength),width*16);}
export function imageShader(kit,img,matrix){return img.makeShaderOptions(kit.TileMode.Clamp,kit.TileMode.Clamp,kit.FilterMode.Nearest,kit.MipmapMode.None,matrix);}
export function runVertices(kit,compiled,values,attrs,count){
 if(compiled.cpuVertex)return runCPUVertices(compiled,values,attrs,count);
 const images=[],children=[];let surface,mem,paint,sh;
 try{
  for(const a of compiled.attributes){const data=new Float32Array(count*4),input=attrs.get(a.name);for(let i=0;i<count;i++){data[i*4+3]=1;if(input)for(let c=0;c<a.size;c++)data[i*4+c]=input[i*a.size+c]??0;}const img=floatImage(kit,count,1,data);images.push(img);children.push(imageShader(kit,img));}
  mem=kit.Malloc(Float32Array,count*compiled.rows*4);surface=kit.MakeRasterDirectSurface({width:count,height:compiled.rows,colorType:kit.ColorType.RGBA_F32,alphaType:kit.AlphaType.Premul,colorSpace:kit.ColorSpace.SRGB},mem,count*16);
  if(!surface)throw Error('Cannot allocate vertex surface');
  sh=shader(kit,compiled,values,children);paint=new kit.Paint();paint.setShader(sh);paint.setBlendMode(kit.BlendMode.Src);surface.getCanvas().drawPaint(paint);surface.flush();
  const raw=mem.toTypedArray(),out=new Float32Array(count*compiled.outputCount);
  for(let i=0;i<count;i++)for(let c=0;c<compiled.outputCount;c++)out[i*compiled.outputCount+c]=raw[(Math.floor(c/3)*count+i)*4+c%3];return out;
 }finally{paint?.delete();sh?.delete();surface?.delete();if(mem)kit.Free(mem);for(const c of children)c.delete();for(const i of images)i.delete();}
}
