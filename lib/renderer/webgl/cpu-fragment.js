// Optional numeric CPU lowering for the straight-line GLSL/SkSL subset. The
// shader is first validated by CanvasKit; unsupported syntax keeps that path.
// Only tokens parsed below generate code. Source identifiers never become JS
// identifiers, property accesses or host calls. No page text is evaluated.
// Keep the host compiler before SES replaces Function with its compartment
// evaluator. Only our validated numeric IR reaches it; GLSL identifiers and
// source snippets are never interpolated into the generated JavaScript.
const NumericFunction = Function;
const scalar=new Set(['float','int','bool','void','half']);
const qualifiers=new Set(['const','in','out','inout','uniform','highp','mediump','lowp']);
class Parser {
 constructor(source){this.t=source.match(/[A-Za-z_]\w*|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|==|!=|<=|>=|&&|\|\||\+=|-=|\*=|\/=|\+\+|--|[{}()[\].,;?:+*/%<>=!-]/g)??[];this.i=0;this.types=new Set([...scalar,'shader',...Array.from({length:3},(_,i)=>'float'+(i+2)),...Array.from({length:3},(_,i)=>'float'+(i+2)+'x'+(i+2))]);this.structs=new Map();this.functions=new Map();this.globals=[];if(this.t.length>60000)throw Error('shader token budget');}
 peek(){return this.t[this.i];}pop(){if(this.i>=this.t.length)throw Error('Unexpected shader end');return this.t[this.i++];}
 take(t){if(this.peek()===t){this.i++;return true;}return false;}need(t){if(!this.take(t))throw Error('Expected '+t+' got '+this.peek());}
 type(){const q=[];while(qualifiers.has(this.peek()))q.push(this.pop());const type=this.pop();if(!this.types.has(type))throw Error('Unknown type '+type);return {type,q};}
 dimensions(type){if(this.take('[')){const n=Number(this.pop());this.need(']');if(!Number.isInteger(n)||n<1||n>64)throw Error('array bound');return {array:type,size:n};}return type;}
 parse(){while(this.i<this.t.length){if(this.take(';'))continue;if(this.take('struct')){const name=this.pop();this.need('{');const fields=[];while(!this.take('}')){const t=this.type(),n=this.pop(),type=this.dimensions(t.type);this.need(';');fields.push({name:n,type});}this.need(';');this.structs.set(name,fields);this.types.add(name);continue;}
  const t=this.type(),name=this.pop();if(this.take('(')){const args=[];if(!this.take(')')){do{const p=this.type(),n=this.pop();args.push({name:n,type:this.dimensions(p.type),q:p.q});}while(this.take(','));this.need(')');}const body=this.statement();const f={name,type:t.type,args,body};const list=this.functions.get(name)??[];list.push(f);this.functions.set(name,list);
  }else{this.globals.push(...this.declarations(t,name));this.need(';');}}
  return this;
 }
 declarations(t,name){const out=[];do{const type=this.dimensions(t.type),value=this.take('=')?this.expr(2):null;out.push({kind:'decl',type,q:t.q,name,value});if(!this.take(','))break;name=this.pop();}while(true);return out;}
 statement(){this.nesting=(this.nesting??0)+1;if(this.nesting>256)throw Error('shader nesting budget');try{return this.statementBody();}finally{this.nesting--;}}
 statementBody(){if(this.take('{')){const body=[];while(!this.take('}'))body.push(this.statement());return {kind:'block',body};}
  if(this.take('return')){const value=this.peek()===';'?null:this.expr();this.need(';');return {kind:'return',value};}
  if(this.take('if')){this.need('(');const cond=this.expr();this.need(')');const yes=this.statement(),no=this.take('else')?this.statement():null;return {kind:'if',cond,yes,no};}
  if(this.take('discard')){this.need(';');return {kind:'discard'};}
  if(this.types.has(this.peek())||qualifiers.has(this.peek())){const t=this.type(),name=this.pop(),body=this.declarations(t,name);this.need(';');return {kind:'decls',body};}
  if(this.take(';'))return {kind:'block',body:[]};
  const value=this.expr();this.need(';');return {kind:'expr',value};
 }
 expr(min=0){this.nesting=(this.nesting??0)+1;if(this.nesting>256)throw Error('shader nesting budget');try{return this.expressionBody(min);}finally{this.nesting--;}}
 expressionBody(min){let t=this.pop(),left;if(t==='('){left=this.expr();this.need(')');}else if(['-','+','!'].includes(t))left={kind:'unary',op:t,value:this.expr(14)};else if(/^\d|^\./.test(t))left={kind:'number',value:Number(t)};else left={kind:'id',name:t};
  const prec={'=':1,'+=':1,'-=':1,'*=':1,'/=':1,'?':2,'||':3,'&&':4,'==':5,'!=':5,'<':6,'>':6,'<=':6,'>=':6,'+':7,'-':7,'*':8,'/':8,'%':8};
  while(this.i<this.t.length){const op=this.peek();if(op==='('){this.pop();const args=[];if(!this.take(')')){do{args.push(this.expr(2));}while(this.take(','));this.need(')');}left={kind:'call',callee:left,args};continue;}
   if(op==='.'||op==='['){this.pop();const key=op==='.'?this.pop():this.expr();if(op==='[')this.need(']');left={kind:op==='.'?'field':'index',object:left,key};continue;}
   const p=prec[op];if(p===undefined||p<min)break;this.pop();if(op==='?'){const yes=this.expr();this.need(':');left={kind:'ternary',cond:left,yes,no:this.expr(p)};}else left={kind:'binary',op,left,right:this.expr(p+(p===1?0:1))};
  }return left;
 }
}
class Compiler {
 constructor(parsed,varyings,uniforms){Object.assign(this,{parsed,varyings,uniforms});this.lines=[];this.n=0;this.scopes=[new Map()];this.depth=0;this.derivatives=[];this.samplerNames=[];this.controlDepth=0;this.mainStatement=null;this.derivativeStatement=null;}
 line(s){this.lines.push(s);if(this.lines.length>50000)throw Error('shader instruction budget');}
 size(type){
  this.sizes??=new Map();if(this.sizes.has(type))return this.sizes.get(type);
  this.typeDepth=(this.typeDepth??0)+1;if(this.typeDepth>32)throw Error('shader type depth');
  try{let n;if(typeof type==='object')n=type.size*this.size(type.array);
   else if(this.parsed.structs.has(type))n=this.parsed.structs.get(type).reduce((n,f)=>n+this.size(f.type),0);
   else {const ns=type.match(/\d/g);n=type==='void'?0:ns?ns.reduce((n,v)=>n*Number(v),1):1;}
   if(n>1024)throw Error('shader value size');this.sizes.set(type,n);return n;
  }finally{this.typeDepth--;}
 }
 value(type,parts){return {type,parts};}
 variable(type,initial){const names=Array.from({length:this.size(type)},()=>`r${++this.n}`);for(let i=0;i<names.length;i++)this.line(`let ${names[i]}=${initial?.[i]??0};`);return this.value(type,names);}
 lookup(name){for(let i=this.scopes.length-1;i>=0;i--)if(this.scopes[i].has(name))return this.scopes[i].get(name);if(name==='true'||name==='false')return this.value('bool',[name]);throw Error('Unknown shader identifier '+name);}
 assign(to,from,op='='){if(to.parts.length!==from.parts.length&&from.parts.length!==1)throw Error('assignment shape');const tmp=this.variable(to.type,to.parts.map((_,i)=>from.parts[i%from.parts.length]));for(let i=0;i<to.parts.length;i++)this.line(`${to.parts[i]}${op}${tmp.parts[i]};`);return to;}
 expr(e){if(e.kind==='number')return this.value('float',[String(e.value)]);if(e.kind==='id')return this.lookup(e.name);
  if(e.kind==='field'){const a=this.expr(e.object);if(this.parsed.structs.has(a.type)){let offset=0;for(const f of this.parsed.structs.get(a.type)){const n=this.size(f.type);if(f.name===e.key)return this.value(f.type,a.parts.slice(offset,offset+n));offset+=n;}throw Error('struct field');}
   const chars=e.key.split(''),index=c=>'xyzw'.includes(c)?'xyzw'.indexOf(c):'rgba'.includes(c)?'rgba'.indexOf(c):'stpq'.indexOf(c);if(chars.some(c=>index(c)<0||index(c)>=a.parts.length))throw Error('swizzle');return this.value(chars.length===1?'float':'float'+chars.length,chars.map(c=>a.parts[index(c)]));}
  if(e.kind==='index'){const a=this.expr(e.object),index=this.expr(e.key).parts[0],n=typeof a.type==='object'?this.size(a.type.array):a.type.includes('x')?Number(a.type.at(-1)):1,type=typeof a.type==='object'?a.type.array:n>1?'float'+n:'float';
   if(/^\d+$/.test(index))return this.value(type,a.parts.slice(Number(index)*n,(Number(index)+1)*n));
   return this.value(type,Array.from({length:n},(_,j)=>a.parts.filter((_,i)=>i%n===j).map((v,i,all)=>i===all.length-1?v:`(${index}===${i}?${v}:`).join('')+')'.repeat(a.parts.length/n-1)));}
  if(e.kind==='unary'){const a=this.expr(e.value);return this.variable(e.op==='!'?'bool':a.type,a.parts.map(x=>`(${e.op}${x})`));}
  if(e.kind==='ternary'){
   const c=this.expr(e.cond),outer=this.lines;this.lines=[];this.controlDepth++;
   const a=this.expr(e.yes),yes=this.lines;this.lines=[];const b=this.expr(e.no),no=this.lines;this.lines=outer;this.controlDepth--;
   if(a.parts.length!==b.parts.length)throw Error('conditional shape');const out=this.variable(a.type);
   this.line(`if(${c.parts[0]}){`);for(const line of yes)this.line(line);this.assign(out,a);this.line('}else{');for(const line of no)this.line(line);this.assign(out,b);this.line('}');return out;
  }
  if(e.kind==='binary'){const a=this.expr(e.left);if(['=','+=','-=','*=','/='].includes(e.op))return this.assign(a,this.expr(e.right),e.op);if(e.op==='&&'||e.op==='||'){
    const out=this.variable('bool',[a.parts[0]]);this.line(`if(${e.op==='||'?'!':''}${out.parts[0]}){`);this.controlDepth++;this.assign(out,this.expr(e.right));this.controlDepth--;this.line('}');return out;
   }const b=this.expr(e.right),n=Math.max(a.parts.length,b.parts.length);if(e.op==='*'&&(String(a.type).includes('x')||String(b.type).includes('x')))return this.matrix(a,b);
   return this.variable(n===1?(['==','!=','<=','>=','<','>','&&','||'].includes(e.op)?'bool':a.type):'float'+n,Array.from({length:n},(_,i)=>`(${a.parts[i%a.parts.length]}${e.op}${b.parts[i%b.parts.length]})`));}
  if(e.kind==='call'){if(e.callee.kind==='field'&&e.callee.key==='eval'){const s=this.expr(e.callee.object),uv=this.expr(e.args[0]);return this.sampleTexture(s,uv);}
   if(e.callee.kind!=='id')throw Error('shader callee');const name=e.callee.name;
   if(name==='dFdx'||name==='dFdy'){
    if(this.controlDepth||this.depth!==1||(this.derivativeStatement!==null&&this.derivativeStatement!==this.mainStatement))throw Error('nonlocal derivative');
    this.derivativeStatement=this.mainStatement;
    const before=this.derivatives.length,a=this.expr(e.args[0]);if(this.derivatives.length!==before)throw Error('nested derivative');const id=this.derivatives.length;this.derivatives.push({name,size:a.parts.length});for(let i=0;i<a.parts.length;i++)this.line(`captured[${id*4+i}]=${a.parts[i]};`);return this.value(a.type,a.parts.map((_,i)=>`delta[${id*4+i}]`));}
   const args=e.args.map(a=>this.expr(a));
   if(this.parsed.types.has(name))return this.construct(name,args);
   const builtin=this.builtin(name,args);if(builtin)return builtin;
   const candidates=this.parsed.functions.get(name)??[],fn=candidates.find(f=>f.args.length===args.length&&f.args.every((a,i)=>this.size(a.type)===args[i].parts.length));if(!fn)throw Error('Unsupported function '+name);return this.call(fn,args);
  }throw Error('Unsupported expression '+e.kind);
 }
 construct(type,args){let parts=args.flatMap(a=>a.parts),n=this.size(type);if(n===1)return this.variable(type,[type==='bool'?`!!(${parts[0]})`:type==='int'?`Math.trunc(${parts[0]})`:parts[0]]);
  if(parts.length===1){if(type.includes('x')){const dim=Number(type.at(-1));parts=Array.from({length:n},(_,i)=>i%(dim+1)===0?parts[0]:'0');}else parts=Array(n).fill(parts[0]);}
  if(parts.length<n)throw Error('constructor shape');return this.variable(type,parts.slice(0,n));
 }
 matrix(a,b){const am=String(a.type).includes('x'),bm=String(b.type).includes('x');if(am&&bm)throw Error('matrix matrix subset');const m=am?a:b,v=am?b:a,n=Math.sqrt(m.parts.length);if(v.parts.length!==n)throw Error('matrix shape');return this.variable('float'+n,Array.from({length:n},(_,row)=>Array.from({length:n},(_,col)=>`(${m.parts[am?col*n+row:row*n+col]}*${v.parts[col]})`).join('+')));}
 builtin(name,args){const a=args[0],b=args[1],c=args[2],n=Math.max(...args.map(a=>a.parts.length)),type=n===1?'float':'float'+n;
  const at=(a,i)=>a.parts[i%a.parts.length],each=fn=>this.variable(type,Array.from({length:n},(_,i)=>fn(i)));
  if(['abs','sqrt','exp','log','floor','ceil','sin','cos','tan','asin','acos','sign'].includes(name))return each(i=>`Math.${name}(${at(a,i)})`);
  if(name==='atan')return each(i=>b?`Math.atan2(${at(a,i)},${at(b,i)})`:`Math.atan(${at(a,i)})`);
  if(name==='exp2')return each(i=>`Math.pow(2,${at(a,i)})`);
  if(name==='log2')return each(i=>`Math.log2(${at(a,i)})`);
  if(name==='inversesqrt')return each(i=>`(1/Math.sqrt(${at(a,i)}))`);
  if(name==='pow')return each(i=>`Math.pow(${at(a,i)},${at(b,i)})`);
  if(name==='min'||name==='max')return each(i=>`Math.${name}(${at(a,i)},${at(b,i)})`);
  if(name==='clamp')return each(i=>`Math.max(${at(b,i)},Math.min(${at(c,i)},${at(a,i)}))`);
  if(name==='mix')return each(i=>`(${at(a,i)}*(1-${at(c,i)})+${at(b,i)}*${at(c,i)})`);
  if(name==='mod')return each(i=>`(${at(a,i)}-${at(b,i)}*Math.floor(${at(a,i)}/${at(b,i)}))`);
  if(name==='fract')return each(i=>`(${at(a,i)}-Math.floor(${at(a,i)}))`);
  if(name==='step')return each(i=>`(${at(b,i)}<${at(a,i)}?0:1)`);
  if(name==='smoothstep'){const t=this.variable(type,Array.from({length:n},(_,i)=>`Math.max(0,Math.min(1,(${at(c,i)}-${at(a,i)})/(${at(b,i)}-${at(a,i)})))`));return this.variable(type,t.parts.map(v=>`(${v}*${v}*(3-2*${v}))`));}
  if(name==='dot')return this.variable('float',[a.parts.map((v,i)=>`(${v}*${b.parts[i]})`).join('+')]);
  if(name==='length'||name==='normalize'){const len=this.variable('float',[`Math.sqrt(${a.parts.map(v=>`(${v}*${v})`).join('+')})`]).parts[0];return name==='length'?this.value('float',[len]):this.variable(a.type,a.parts.map(v=>`(${v}/${len})`));}
  if(name==='cross')return this.variable('float3',[0,1,2].map(i=>`(${a.parts[(i+1)%3]}*${b.parts[(i+2)%3]}-${a.parts[(i+2)%3]}*${b.parts[(i+1)%3]})`));
  if(name==='reflect'){const dot=a.parts.map((v,i)=>`(${v}*${b.parts[i]})`).join('+');return this.variable(a.type,a.parts.map((v,i)=>`(${v}-2*(${dot})*${b.parts[i]})`));}
  const op={lessThan:'<',lessThanEqual:'<=',greaterThan:'>',greaterThanEqual:'>=',equal:'===',notEqual:'!=='}[name];if(op)return each(i=>`(${at(a,i)}${op}${at(b,i)})`);
  return null;
 }
 sampleTexture(s,uv){const id=Number(s.parts[0]);if(!Number.isInteger(id))throw Error('dynamic sampler');const out=this.variable('float4');this.line(`sampleTexture(textures[${id}],${uv.parts[0]},${uv.parts[1]},texel);`);for(let i=0;i<4;i++)this.line(`${out.parts[i]}=texel[${i}]${i<3?"*texel[3]":""};`);return out;}
 stmt(s,ret,label){if(s.kind==='block'){this.scopes.push(new Map());for(const node of s.body){if(this.depth===1)this.mainStatement=node;this.stmt(node,ret,label);}this.scopes.pop();}
  else if(s.kind==='decls'){for(const d of s.body){const init=d.value?this.expr(d.value):null;const v=this.variable(d.type,init?.parts);this.scopes.at(-1).set(d.name,v);}}
  else if(s.kind==='expr')this.expr(s.value);
  else if(s.kind==='if'){const c=this.expr(s.cond);this.line(`if(${c.parts[0]}){`);this.controlDepth++;this.stmt(s.yes,ret,label);if(s.no){this.line('}else{');this.stmt(s.no,ret,label);}this.controlDepth--;this.line('}');}
  else if(s.kind==='return'){if(s.value)this.assign(ret,this.expr(s.value));this.line(`break ${label};`);}
  else if(s.kind==='discard')throw Error('discard requires native shader');
  else throw Error('Unsupported statement');
 }
 call(fn,args){if(++this.depth>32)throw Error('shader call depth');const ret=this.variable(fn.type),label='L'+(++this.n);this.line(`${label}:{`);this.scopes.push(new Map());
  for(let i=0;i<args.length;i++)this.scopes.at(-1).set(fn.args[i].name,fn.args[i].q.some(q=>q==='out'||q==='inout')?args[i]:this.variable(fn.args[i].type,args[i].parts));
  this.stmt(fn.body,ret,label);this.scopes.pop();this.line('}');this.depth--;return ret;
 }
 compile(init,outputNames=['gl_FragColor']){
  const uniformSlots=[];const global=this.scopes[0];
  for(const d of this.parsed.globals){if(d.type==='shader'){global.set(d.name,this.value('shader',[String(this.samplerNames.length)]));this.samplerNames.push(d.name);continue;}
   const v=this.variable(d.type);global.set(d.name,v);
   if(d.q.includes('uniform')){const offset=uniformSlots.length;for(let i=0;i<v.parts.length;i++){uniformSlots.push([d.name,i]);this.line(`${v.parts[i]}=uniforms[${offset+i}];`);}}
   else if(d.value)this.assign(v,this.expr(d.value));
  }
  const initParser=new Parser('void _init(){'+init+'}').parse();if(init)this.stmt(initParser.functions.get('_init')[0].body,this.value('void',[]),'unused');
  const mutable=this.parsed.globals.filter(d=>d.type!=='shader'&&!d.q.includes('uniform')&&!d.q.includes('const')&&!this.varyings.some(v=>v.name===d.name)).flatMap(d=>this.lookup(d.name).parts);
  this.line(`const initialGlobals=[${mutable.join(',')}];`);
  const declarations=this.lines.join('\n');this.lines=[];
  mutable.forEach((v,i)=>this.line(`let ${v}=initialGlobals[${i}];`));
  for(let k=0;k<this.varyings.length;k++){const v=this.lookup(this.varyings[k].name);for(let c=0;c<v.parts.length;c++)this.line(`let ${v.parts[c]}=varyings[${k}][index+${c}];`);}
  const coord=global.get('gl_FragCoord');if(coord)coord.parts.forEach((v,i)=>this.line(`${v}=${['fx','fy','z','1'][i]};`));const face=global.get('gl_FrontFacing');if(face)this.line(`${face.parts[0]}=front;`);
  const start=this.lines.length;this.call(this.parsed.functions.get('_sw_run')[0],[]);
  const body=this.lines.join('\n'),outputs=outputNames.flatMap(name=>{const value=global.get(name);if(!value)throw Error('shader output');return value.parts;});
  const output=outputs.map((v,i)=>`result[${i}]=${v};`).join('');
  // The CPU JIT can skip the remainder of main for derivative helper lanes.
  // Find the last derivative capture in the emitted straight-line code.
  let shaderBody=body;
  if(this.derivatives.length){const end=Math.max(...[...body.matchAll(/captured\[\d+\]=[^;]+;/g)].map(m=>m.index+m[0].length));if(end>0)shaderBody=body.slice(0,end)+'if(collect)return;'+body.slice(end);}
  const code=`"use strict";${declarations}\nreturn function shade(index,fx,fy,z,front,collect){${shaderBody}\n${output}};`;
  const make=new NumericFunction('uniforms','varyings','delta','captured','result','textures','sampleTexture','texel',code);
  // Specialization leaves uniforms as numeric literals inside the function,
  // allowing the JS JIT to fold lighting/material constants across pixels.
  // Cache factories, not bound images/arrays, so draw resources are not retained.
  const localBody=shaderBody.replace(/let r\d+=initialGlobals\[\d+\];/g,'').replace(/let (r\d+=varyings\[)/g,'$1');
  const localDecl=declarations.replace(/const initialGlobals=\[[^;]*;/,'');
  const literalCode=`"use strict";return function shade(index,fx,fy,z,front,collect){${localDecl}\n${localBody}\n${output}};`;
  return {make,uniformSlots,samplers:this.samplerNames,derivatives:this.derivatives,code,literalCode,factories:new Map()};
 }
}
export function compileCPUFragment(translated){try{
 const output=translated.output||'gl_FragColor';
 const parsed=new Parser((output==='gl_FragColor'?'float4 gl_FragColor;':'')+'float4 gl_FragCoord;bool gl_FrontFacing;'+translated.code).parse();
 return new Compiler(parsed,translated.varyings,translated.uniforms).compile(translated.init,[output]);
}catch{return null;}}

export function compileCPUVertex(translated){try{
 const parsed=new Parser('float4 gl_Position;'+translated.code).parse();
 const cpu=new Compiler(parsed,translated.attributes,translated.uniforms).compile(translated.init,['gl_Position',...translated.varyings.map(v=>v.name)]);
 return cpu.samplers.length||cpu.derivatives.length?null:cpu;
}catch{return null;}}
function bindShader(compiled,cpu,values,inputs,delta,captured,result,textures,texel,specialize=true){
 const uniforms=new Float64Array(cpu.uniformSlots.length);
 for(let i=0;i<uniforms.length;i++){const [name,index]=cpu.uniformSlots[i],spec=compiled.uniforms.find(u=>u.key===name),value=values.get(spec?.name??name);uniforms[i]=Math.fround(typeof value==='number'?(index===0?value:0):value?.[index]??0);}
 // Model matrices often change on every draw. Reuse one compiled vertex
 // function instead of compiling another JS function for each moved object.
 if(!specialize)return cpu.make(uniforms,inputs,delta,captured,result,textures,sampleTexture,texel);
 const number=n=>Object.is(n,-0)?'-0':String(n),key=Array.from(uniforms,number).join(',');let factory=cpu.factories.get(key);
 if(!factory){const literal=cpu.literalCode.replace(/uniforms\[(\d+)\]/g,(_,i)=>number(uniforms[Number(i)]));factory=new NumericFunction('uniforms','varyings','delta','captured','result','textures','sampleTexture','texel',literal);cpu.factories.set(key,factory);if(cpu.factories.size>16)cpu.factories.delete(cpu.factories.keys().next().value);}
 return factory(uniforms,inputs,delta,captured,result,textures,sampleTexture,texel);
}
export function runCPUVertices(compiled,values,attributes,count){
 const inputs=compiled.attributes.map(a=>{const padded=new Float32Array(count*4),source=attributes.get(a.name);for(let i=0;i<count;i++){padded[i*4+3]=1;if(source)for(let c=0;c<a.size;c++)padded[i*4+c]=source[i*a.size+c];}return padded;});
 const result=new Float64Array(compiled.outputCount),out=new Float32Array(count*compiled.outputCount);
 const run=bindShader(compiled,compiled.cpuVertex,values,inputs,null,null,result,[],null,false);
 for(let i=0;i<count;i++){run(i*4,0,0,0,true,false);out.set(result,i*compiled.outputCount);}
 return out;
}

function sampleTexture(t,x,y,out){
 if(!t?.pixels){out[0]=out[1]=out[2]=0;out[3]=1;return;}
 const wrap=(n,size,mode)=>mode===10497?((n%size)+size)%size:mode===33648?(()=>{const v=((n%(2*size))+2*size)%(2*size);return v<size?v:2*size-v-1;})():Math.max(0,Math.min(size-1,n));
 const offset=(x,y)=>(wrap(y,t.height,t.wrapT)*t.width+wrap(x,t.width,t.wrapS))*4;
 if(t.mag===9728){const p=offset(Math.floor(x),Math.floor(y));for(let c=0;c<4;c++)out[c]=t.pixels[p+c]/255;return;}
 x-=.5;y-=.5;const ix=Math.floor(x),iy=Math.floor(y),dx=x-ix,dy=y-iy;
 const a=offset(ix,iy),b=offset(ix+1,iy),c=offset(ix,iy+1),d=offset(ix+1,iy+1);
 for(let k=0;k<4;k++)out[k]=((t.pixels[a+k]*(1-dx)+t.pixels[b+k]*dx)*(1-dy)+(t.pixels[c+k]*(1-dx)+t.pixels[d+k]*dx)*dy)/255;
}
export function runCPUFragment(compiled,values,samplers,coverage,varyings,width,height,left,top,canvasHeight){
 const cpu=compiled.cpu;if(!cpu)return null;
 const textures=cpu.samplers.map(name=>samplers.find(s=>s.key===name));
 const delta=new Float64Array(cpu.derivatives.length*4),captured=new Float64Array(delta.length),result=new Float64Array(4),texel=new Float64Array(4),out=new Uint8Array(width*height*4);
 const shade=bindShader(compiled,cpu,values,varyings,delta,captured,result,textures,texel),samples=new Float64Array(delta.length*4);
 function sample(x,y,collect){x=Math.max(0,Math.min(width-1,x));y=Math.max(0,Math.min(height-1,y));const i=(y*width+x)*4;shade(i,left+x+.5,canvasHeight-top-y-.5,coverage[i+2],coverage[i]>0,collect);}
 for(let qy=0;qy<height;qy+=2)for(let qx=0;qx<width;qx+=2){
  let covered=false;for(let lane=0;lane<4;lane++){const x=qx+(lane&1),y=qy+(lane>>1);if(x<width&&y<height&&coverage[(y*width+x)*4+3])covered=true;}if(!covered)continue;
  if(cpu.derivatives.length){delta.fill(0);for(let lane=0;lane<4;lane++){sample(qx+(lane&1),qy+(lane>>1),true);samples.set(captured,lane*delta.length);}}
  for(let lane=0;lane<4;lane++){const x=qx+(lane&1),y=qy+(lane>>1);if(x>=width||y>=height)continue;const i=(y*width+x)*4;if(!coverage[i+3])continue;
   for(let d=0;d<cpu.derivatives.length;d++){const horizontal=cpu.derivatives[d].name==='dFdx',a=horizontal?(lane>>1)*2:lane&1,b=a+(horizontal?1:2);for(let c=0;c<cpu.derivatives[d].size;c++){const k=d*4+c;delta[k]=(samples[b*delta.length+k]-samples[a*delta.length+k])*(horizontal?1:-1);}}
   sample(x,y,false);const alpha=Math.max(0,Math.min(1,result[3]));for(let c=0;c<3;c++)out[i+c]=Math.round(Math.max(0,Math.min(1,result[c]))*alpha*255);out[i+3]=Math.round(alpha*255);
  }
 }
 return out;
}
