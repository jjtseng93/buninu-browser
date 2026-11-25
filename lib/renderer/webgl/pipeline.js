import {compileCPUFragment,compileCPUVertex,runCPUVertices} from './cpu-fragment.js';
import {translate,components} from './shaders.js';
function skInputType(variable) {
 const base=variable.type==='int'||variable.type.startsWith('ivec')?'int':'float';
 return variable.size===1?base:base+variable.size;
}
// RuntimeEffect evaluates derivative helper lanes by calling the GLSL entry
// point again. Each invocation starts with its own initialized shader globals.
function restoreGlobals(code){
 const resets=[];
 let start=0,depth=0;
 for(let i=0;i<code.length;i++){
  const c=code[i];
  if(c==='{'){depth++;continue;}
  if(c==='}'){if(--depth===0)start=i+1;continue;}
  if(depth||c!==';')continue;
  const decl=code.slice(start,i).trim();start=i+1;
  const match=/^(?!const\b|uniform\b)\w+\s+(\w+[\s\S]*)$/.exec(decl);
  if(!match)continue;
  let from=0,parens=0;
  for(let j=0;j<=match[1].length;j++){
   const token=match[1][j];
   if(token==='('||token==='[')parens++;
   if(token===')'||token===']')parens--;
   if(j===match[1].length||token===','&&!parens){
    const assignment=match[1].slice(from,j).trim();
    if(/^\w+\s*=/.test(assignment))resets.push(assignment+';');
    from=j+1;
   }
  }
 }
 return resets.join('');
}
// Helper lanes need the input of each derivative, but work following the
// last such call (often lighting or texture filtering) is only needed once.
function derivativePrefix(stage,derivatives,decl){
 const code=stage.code;
 const header=/\b\w+\s+(\w+)\s*\([^;{}()]*\)\s*\{/g;
 const callers=new Map(),needed=new Set(derivatives.map(d=>d.name));
 let main,mainStart;
 for(let m;(m=header.exec(code));){
  const start=header.lastIndex;
  let end=start,braces=1;
  for(;end<code.length&&braces;end++){
   if(code[end]==='{')braces++;
   if(code[end]==='}')braces--;
  }
  if(braces)return '';
  const body=code.slice(start,end-1);
  if(m[1]==='_sw_run'){main=body;mainStart=start;}
  for(const call of body.matchAll(/\b(\w+)\s*\(/g)){
   const name=call[1];
   if(!callers.has(name))callers.set(name,new Set());
   callers.get(name).add(m[1]);
  }
  header.lastIndex=end;
 }
 if(main===undefined)return '';
 // Follow all overloads conservatively. Set iteration visits newly added names.
 for(const name of needed)for(const caller of callers.get(name)??[])needed.add(caller);
 // Where a single assignment calls a derivative in divergent control flow,
 // helper lanes need to enter the same call as the covered pixel. Otherwise
 // a skipped lane reuses the preceding lane's captured operand. Restrict
 // the saved predicate to entry-point sites that execute at most once.
 if(!/\b(?:for|while|do)\b/.test(main)){
  const edits=[];
  for(const conditional of main.matchAll(/\bif\s*\(/g)){
   const begin=conditional.index+conditional[0].length;
   let close=begin,depth=1;
   for(;close<main.length&&depth;close++){
    if(main[close]==='(')depth++;
    if(main[close]===')')depth--;
   }
   const assignment=/^\s*(?:\{\s*)?\w+(?:\.\w+)*\s*=\s*(\w+)\s*\(/.exec(main.slice(close));
   if(!assignment||!needed.has(assignment[1]))continue;
   const name='_sw_branch'+edits.length;
   const condition=main.slice(begin,close-1);
   decl.push(`bool ${name}_value;bool ${name}(bool value){if(!_sw_helperLane)${name}_value=value;return ${name}_value;}`);
   edits.push({begin,end:close-1,text:`${name}(${condition})`});
  }
  if(edits.length){
   const end=mainStart+main.length;
   for(const edit of edits.reverse())main=main.slice(0,edit.begin)+edit.text+main.slice(edit.end);
   stage.code=code.slice(0,mainStart)+main+code.slice(end);
   stage.derivativeBranches=true;
  }
 }
 let first=-1,last=-1;
 for(const call of main.matchAll(/\b(\w+)\s*\(/g))if(needed.has(call[1])){
  if(first<0)first=call.index;
  last=call.index;
 }
 if(last<0)return 'void _sw_probe(){}';
 // A scalar uniform is constant across the quad. When its branch encloses
 // every derivative (including calls through other functions), the decision
 // can be made before preparing any helper samples.
 const guarded=/\bif\s*\(\s*((\w+)\s*([<>]=?|[!=]=)\s*(-?(?:\d+\.?\d*|\.\d+)))\s*\)\s*\{/g;
 const scalarUniforms=new Set(stage.uniforms.filter(u=>u.type==='float'&&!u.array).map(u=>u.key));
 let candidate;
 for(const match of main.matchAll(guarded)){
  if(match.index+match[0].length>first)break;
  if(scalarUniforms.has(match[2]))candidate=match;
 }
 if(candidate){
  const [statement,predicate,name]=candidate;
  // An earlier comparison cannot declare a local variable. Decline all
  // other earlier uses in main, including comma-separated declarations.
  const possiblyShadowed=new RegExp('\\b'+name+'\\b(?!\\s*(?:[<>]|==|!=))').test(main.slice(0,candidate.index));
  let depth=1;
  for(let i=candidate.index+statement.length;!possiblyShadowed&&depth&&i<=last;i++){
   if(main[i]==='{')depth++;
   else if(main[i]==='}')depth--;
  }
  if(!possiblyShadowed&&depth){
   stage.derivativeGuard=predicate;
   const key=stage.uniforms.find(u=>u.key===name).name;
   const threshold=Math.fround(Number(candidate[4]));
   const compare={
    '<':v=>v<threshold, '<=':v=>v<=threshold, '>':v=>v>threshold,
    '>=':v=>v>=threshold, '==':v=>v===threshold, '!=':v=>v!==threshold,
   }[candidate[3]];
   stage.needsDerivativeLanes=values=>{
    const input=values.get(key);
    const value=Math.fround(typeof input==='number'?input:input?.[0]??0);
    // Non-finite and subnormal behavior may depend on the shader backend.
    if(!Number.isFinite(value)||!Number.isFinite(threshold)||
       value!==0&&Math.abs(value)<1.17549435e-38||threshold!==0&&Math.abs(threshold)<1.17549435e-38)return true;
    return compare(value);
   };
  }
 }
 let braces=0,parens=0;
 for(let i=0;i<main.length;i++){
  switch(main[i]){
   case '{':braces++;break;
   case '}':braces--;break;
   case '(':parens++;break;
   case ')':parens--;break;
   case ';':
    if(i>last&&!braces&&!parens&&main.slice(i+1).trim())
     return 'void _sw_probe(){'+main.slice(0,i+1)+'}';
  }
 }
 return '';
}
export function compileStage(kit,source,stage,rawColor=false) {
 const t=translate(source,stage),decl=[],init=[],outputs=[];
 t.rawColor=rawColor;
 if(stage==='vertex')for(const name of ['gl_VertexID','gl_InstanceID'])if(new RegExp('\\b'+name+'\\b').test(t.code)){
  t.attributes.push({name,type:'int',size:1,builtin:true});
  t.code='int '+name+';\n'+t.code;
 }
 // Numeric lowering consumes the GLSL translation before the SkSL entry point
 // below adds raster plumbing. Reflection-only users never need the CPU code.
 const numericInput={...t};
 if(stage==='vertex'){
  decl.push('float4 gl_Position;');
  for(const a of t.attributes){
   const columns=a.type.startsWith('mat')?Math.sqrt(a.size):1,rows=a.size/columns;
   const parts=[];
   for(let col=0;col<columns;col++){
    const key='_sw_a_'+(a.key??a.name)+(columns===1?'':'_'+col);
    decl.push(`uniform shader ${key};`);
    parts.push(key+'.eval(float2(_sw_coord.x,0.5))'+(rows<4?'.'+'xyzw'.slice(0,rows):''));
   }
   const type=columns===1?skInputType(a):'float'+columns+'x'+columns;
   init.push(`${a.name}=${type}(${parts.join(',')});`);
  }
  outputs.push(...['x','y','z','w'].map(c=>'gl_Position.'+c));
  t.flatComponents=[];
  for(const v of t.varyings)for(let i=0;i<v.size;i++){
   if(v.flat)t.flatComponents.push(outputs.length);
   outputs.push(v.size===1?v.name:v.name+'.'+'xyzw'[i]);
  }
  const groups=[];for(let i=0;i<outputs.length;i+=3)groups.push(`if(int(_sw_coord.y)==${i/3})return half4(${[...outputs.slice(i,i+3),...Array(Math.max(0,3-(outputs.length-i))).fill('0')].join(',')},1);`);
  t.code=decl.join('\n')+'\n'+t.code+`\nhalf4 main(float2 _sw_coord){${t.init}${init.join('')}_sw_run();${groups.join('')}return half4(0);}`;
  t.rows=Math.ceil(outputs.length/3);t.outputCount=outputs.length;
 }else{
  const output=t.output||'gl_FragColor';decl.push(`float4 gl_FragCoord; bool gl_FrontFacing;${output==='gl_FragColor'?'float4 gl_FragColor;':''}uniform shader _sw_coverage;`);
  for(const v of t.varyings){decl.push(`uniform shader _sw_v_${v.key??v.name};`);init.push(`${v.name}=${skInputType(v)}(_sw_v_${v.key??v.name}.eval(inputPoint)${v.size<4?'.'+'xyzw'.slice(0,v.size):''});`);}
  const discard=/\bdiscard\s*;/.test(t.code);
  t.discard=discard;
  if(discard){decl.push('bool _sw_discarded;');t.code=t.code.replace(/\bdiscard\s*;/g,'_sw_discarded=true;');}
  const pack=name=>rawColor?`half4(${name})`:`half4(${name}.rgb*${name}.a,${name}.a)`;
  // A floating-point render surface can carry the discard bit alongside RGBA.
  // Escape the two tag values so a legal fragment color can always be recovered.
  const taggedDiscard=discard&&rawColor;
  if(taggedDiscard)decl.push('uniform float _sw_untagged; half4 _sw_encode(half4 c){if(_sw_untagged==0 && (c.a==-2 || c.a==-3))c.a=-3;return c;}');
  const color=name=>taggedDiscard?'_sw_encode('+pack(name)+')':pack(name);
  let result=`return ${color(output)};`;
  if(t.outputs.length>1){
   decl.push('uniform float _sw_output;');
   result=t.outputs.map((name,slot)=>`if(int(_sw_output)==${slot})return ${color(name)};`).join('')+'return half4(0);';
  }
  const derivatives=[];
  t.code=t.code.replace(/\b(dFdx|dFdy|fwidth)\s*\(/g,(_,op)=>{const name='_sw_derivative'+derivatives.length;derivatives.push({name,op});return name+'(';});
  const probe=derivatives.length?derivativePrefix(t,derivatives,decl):'';
  if(probe)t.code+='\n'+probe;
  const helpers=derivatives.map(({name})=>`float4 ${name}_value; float4 ${name}_delta;`+Array.from({length:4},(_,i)=>{
    const n=i+1,type=n===1?'float':'float'+n,tail=n<4?','+Array(4-n).fill('0').join(','):'';
    return `${type} ${name}(${type} v){${name}_value=float4(v${tail});return ${name}_delta.${'xyzw'.slice(0,n)};}`;
  }).join('')).join('\n');
  const resets=derivatives.length?restoreGlobals(t.code):'';
  // Ordinary tiles supply screen x via the raster coordinate. Packed MSAA
  // lanes use coverage.r for signed (x+4), and alpha 2/3 for row parity.
  // The offset keeps helper lanes just outside the viewport unambiguous.
  const load=`${resets}gl_FragCoord=float4(hit.a>1?abs(hit.x)-4:p.x,hit.y,hit.z,1);gl_FrontFacing=hit.x>0;${t.init}${init.join('')}_sw_run();`;
  t.derivativeInputs=derivatives.length>0;
  const samples=[];
  if(t.derivativeInputs){
    if(t.derivativeBranches)decl.unshift('bool _sw_helperLane;');
    decl.push('uniform float _sw_tileHeight;');
    // Each covered pixel owns the two helper lanes of its own primitive.
    // Sample the extrapolated inputs even when a different triangle covers
    // the adjacent pixel, or when the neighbor falls outside the viewport.
    samples.push('float4 centerHit=_sw_coverage.eval(p);float sx=mod(floor(centerHit.a>1?abs(centerHit.x)-4:p.x),2)==0?1:-1;float sy=centerHit.a>1?(centerHit.a==2?1:-1):(mod(floor(p.y),2)==0?1:-1);');
    if(t.derivativeGuard)samples.unshift('if('+t.derivativeGuard+'){');
    for(const d of derivatives)samples.push(`${d.name}_delta=float4(0);`);
    const helper=probe?'_sw_probe_sample':'_sw_sample';
    for(const [index, point] of ['p','p+float2(sx,0)','p+float2(0,sy)'].entries()){
      if(t.derivativeBranches)samples.push('_sw_helperLane='+(index?'true;':'false;'));
      samples.push(`${helper}(${point},p+float2(0,${index}*_sw_tileHeight));`);
      for(const d of derivatives)samples.push(`float4 ${d.name}_${index}=${d.name}_value;`);
    }
    if(t.derivativeBranches)samples.push('_sw_helperLane=false;');
    for(const d of derivatives){
      const dx=`((${d.name}_1-${d.name}_0)*sx)`;
      const dy=`((${d.name}_0-${d.name}_2)*sy)`;
      samples.push(`${d.name}_delta=${d.op==='dFdx'?dx:d.op==='dFdy'?dy:`abs(${dx})+abs(${dy})`};`);
    }
    if(t.derivativeGuard)samples.push('}');
  }
  const entry='(float2 p,float2 inputPoint){float4 hit=_sw_coverage.eval(inputPoint);';
  const probeLoad=probe?'void _sw_probe_sample'+entry+load.replace('_sw_run();','_sw_probe();')+'}':'';
  t.code=decl.join('\n')+'\n'+helpers+'\n'+t.code+'\n'+probeLoad+`\nvoid _sw_sample${entry}${load}}\nhalf4 main(float2 p){if(_sw_coverage.eval(p).a==0)return half4(0);${samples.join('')}${discard?'_sw_discarded=false;':''}_sw_sample(p,p);${discard?`if(_sw_discarded)return ${taggedDiscard?'half4(0,0,0,-2)':'half4(0)'};`:''}${result}}`;

 }
 t.code=t.code.replace(/\bgl_(\w+)/g,'_sw_gl_$1');
 let log='';let effect=kit.RuntimeEffect.Make(t.code,s=>log+=s);
 if(!effect&&log.includes('index expression must be constant')){
  const lowered=lowerUniformIndices(t.code,t.uniforms,log);
  if(lowered!==t.code){
   t.code=lowered;log='';effect=kit.RuntimeEffect.Make(t.code,s=>log+=s);
  }
 }
 if(!effect)throw Object.assign(Error(log),{shader:t.code});
 // Tiling reuses the same program for many draws. Reflect the WASM effect
 // once, while its layout is immutable, instead of querying it on every tile.
 const count=effect.getUniformCount(),uniformFloats=effect.getUniformFloatCount();
 const slots=[];
 for(let i=0;i<count;i++){
  const key=effect.getUniformName(i),offset=effect.getUniform(i).slot;
  if(i)slots[i-1].end=offset;
  slots.push({name:t.uniforms.find(u=>u.key===key)?.name??key,offset,end:uniformFloats});
 }
 const compiled={...t,effect,cpu:null,cpuVertex:null,slots,uniformFloats};
 if(stage==='vertex'||t.outputs.length<=1){
  const key=stage==='vertex'?'cpuVertex':'cpu';
  const lower=stage==='vertex'?compileCPUVertex:compileCPUFragment;
  Object.defineProperty(compiled,key,{configurable:true,enumerable:true,get(){
   const value=lower(numericInput);
   Object.defineProperty(compiled,key,{value,configurable:true,enumerable:true,writable:true});
   return value;
  }});
 }
 return compiled;
}

// Runtime effects require a constant subscript where GLSL ES allows a dynamic
// uniform read. Lower only the expressions the SkSL compiler actually rejects.
function lowerUniformIndices(code,uniforms,log){
 const lines=code.split('\n'), edits=new Map(), helpers=new Map();
 for(const m of log.matchAll(/^error: (\d+): index expression must be constant\n([^\n]*)\n( *)((?:\^)+)/gm)){
  const row=Number(m[1])-1,line=lines[row];
  if(!line)continue;
  const display=m[2], abbreviated=display.startsWith('...')?3:0;
  const excerpt=display.slice(abbreviated).replace(/\.\.\.$/,'');
  const offset=line.indexOf(excerpt);
  if(offset<0||line.indexOf(excerpt,offset+1)>=0)continue;
  const start=offset+m[3].length-abbreviated, end=start+m[4].length;
  const subscript=/^(\w+)\s*\[([\s\S]+)\]$/.exec(line.slice(start,end));
  const u=subscript&&uniforms.find(u=>u.key===subscript[1]&&u.array&&!u.elements);
  if(!u||u.size>256)continue;
  if(!helpers.has(u.key)){
   const declaration=new RegExp('\\buniform (\\w+) '+u.key+'\\['+u.size+'\\];').exec(code);
   if(!declaration)continue;
   const cases=Array.from({length:u.size-1},(_,i)=>'if(i=='+i+')return '+u.key+'['+i+'];');
   helpers.set(u.key,[declaration[0],declaration[1]+' _sw_read_'+u.key+'(int i){'+cases.join('')+'return '+u.key+'['+(u.size-1)+'];}']);
  }
  if(!edits.has(row))edits.set(row,[]);
  edits.get(row).push({start,end,text:'_sw_read_'+u.key+'('+subscript[2]+')'});
 }
 for(const [row,changes] of edits){
  for(const {start,end,text} of changes.sort((a,b)=>b.start-a.start))lines[row]=lines[row].slice(0,start)+text+lines[row].slice(end);
 }
 let lowered=lines.join('\n');
 for(const [declaration,helper] of helpers.values())lowered=lowered.replace(declaration,declaration+'\n'+helper);
 return lowered;
}
export function shader(kit,compiled,values,children){
 const data=new Float32Array(compiled.uniformFloats);
 for(const {name,offset,end} of compiled.slots){
  const value=values.get(name);
  if(typeof value==='number')data[offset]=value;
  else if(value!=null)for(let i=0;i<Math.min(value.length,end-offset);i++)data[offset+i]=value[i];
 }
 return compiled.effect.makeShaderWithChildren(data,children);
}
export function floatImage(kit,width,height,data){return kit.MakeImage({width,height,colorType:kit.ColorType.RGBA_F32,alphaType:kit.AlphaType.Premul,colorSpace:kit.ColorSpace.SRGB},new Uint8Array(data.buffer,data.byteOffset,data.byteLength),width*16);}
export function imageShader(kit,img,matrix){return img.makeShaderOptions(kit.TileMode.Clamp,kit.TileMode.Clamp,kit.FilterMode.Nearest,kit.MipmapMode.None,matrix);}
export function runVertices(kit,compiled,values,attrs,count,textureChildren=()=>[],samplers=[]){
 if(compiled.cpuVertex)return runCPUVertices(compiled,values,attrs,count,samplers);
 if(count>4096){
  const out=new Float32Array(count*compiled.outputCount);
  for(let start=0;start<count;start+=4096){
   const end=Math.min(count,start+4096),slice=new Map();
   for(const a of compiled.attributes)if(attrs.has(a.name))slice.set(a.name,attrs.get(a.name).subarray(start*a.size,end*a.size));
   out.set(runVertices(kit,compiled,values,slice,end-start,textureChildren),start*compiled.outputCount);
  }
  return out;
 }
 const images=[],children=[];let surface,mem,paint,sh;
 try{
  for(const a of compiled.attributes){
   const columns=a.type.startsWith('mat')?Math.sqrt(a.size):1,rows=a.size/columns,input=attrs.get(a.name);
   for(let col=0;col<columns;col++){
    const data=new Float32Array(count*4);
    for(let i=0;i<count;i++){
     data[i*4+3]=1;
     if(input)for(let c=0;c<rows;c++)data[i*4+c]=input[i*a.size+col*rows+c]??0;
    }
    const img=floatImage(kit,count,1,data);images.push(img);children.push(imageShader(kit,img));
   }
  }
  children.push(...textureChildren());
  mem=kit.Malloc(Float32Array,count*compiled.rows*4);surface=kit.MakeRasterDirectSurface({width:count,height:compiled.rows,colorType:kit.ColorType.RGBA_F32,alphaType:kit.AlphaType.Premul,colorSpace:kit.ColorSpace.SRGB},mem,count*16);
  if(!surface)throw Error('Cannot allocate vertex surface');
  sh=shader(kit,compiled,values,children);paint=new kit.Paint();paint.setShader(sh);paint.setBlendMode(kit.BlendMode.Src);surface.getCanvas().drawPaint(paint);surface.flush();
  const raw=mem.toTypedArray(),out=new Float32Array(count*compiled.outputCount);
  for(let i=0;i<count;i++)for(let c=0;c<compiled.outputCount;c++)out[i*compiled.outputCount+c]=raw[(Math.floor(c/3)*count+i)*4+c%3];return out;
 }finally{paint?.delete();sh?.delete();surface?.delete();if(mem)kit.Free(mem);for(const c of children)c.delete();for(const i of images)i.delete();}
}
