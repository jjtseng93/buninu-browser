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
 constructor(source){this.t=source.match(/[A-Za-z_]\w*|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|==|!=|<=|>=|&&|\|\||\+=|-=|\*=|\/=|\+\+|--|[{}()[\].,;?:+*/%<>=!-]/g)??[];this.i=0;this.types=new Set([...scalar,'shader','int2','int3','int4',...Array.from({length:3},(_,i)=>'float'+(i+2)),...Array.from({length:3},(_,i)=>'float'+(i+2)+'x'+(i+2))]);this.structs=new Map();this.functions=new Map();this.globals=[];if(this.t.length>60000)throw Error('shader token budget');}
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
  if(this.take('for')){
   this.need('(');this.need('int');const name=this.pop();this.need('=');
   const sign=this.take('-')?-1:1,first=sign*Number(this.pop());
   this.need(';');this.need(name);const inclusive=this.take('<=');if(!inclusive)this.need('<');
   const end=Number(this.pop())+Number(inclusive);this.need(';');this.need(name);
   let step=1;
   if(this.take('+='))step=Number(this.pop());else this.need('++');
   this.need(')');
   if(!Number.isSafeInteger(first)||!Number.isSafeInteger(end)||!Number.isSafeInteger(step)||step<=0||Math.ceil((end-first)/step)>64)throw Error('unsupported loop bounds');
   return {kind:'counted',name,first,end,step,body:this.statement()};
  }
  if(this.take('break')){this.need(';');return {kind:'break'};}
  if(this.take('continue')){this.need(';');return {kind:'continue'};}
  if(this.take('discard')){this.need(';');return {kind:'discard'};}
  if(this.types.has(this.peek())||qualifiers.has(this.peek())){const t=this.type(),name=this.pop(),body=this.declarations(t,name);this.need(';');return {kind:'decls',body};}
  if(this.take(';'))return {kind:'block',body:[]};
  const value=this.expr();this.need(';');return {kind:'expr',value};
 }
 expr(min=0){this.nesting=(this.nesting??0)+1;if(this.nesting>256)throw Error('shader nesting budget');try{return this.expressionBody(min);}finally{this.nesting--;}}
 expressionBody(min){let t=this.pop(),left;if(t==='('){left=this.expr();this.need(')');}else if(['-','+','!'].includes(t))left={kind:'unary',op:t,value:this.expr(14)};else if(/^\d|^\./.test(t))left={kind:'number',value:Number(t),type:/^\d+$/.test(t)?'int':'float'};else left={kind:'id',name:t};
  const prec={'=':1,'+=':1,'-=':1,'*=':1,'/=':1,'?':2,'||':3,'&&':4,'==':5,'!=':5,'<':6,'>':6,'<=':6,'>=':6,'+':7,'-':7,'*':8,'/':8,'%':8};
  while(this.i<this.t.length){const op=this.peek();if(op==='('){this.pop();const args=[];if(!this.take(')')){do{args.push(this.expr(2));}while(this.take(','));this.need(')');}left={kind:'call',callee:left,args};continue;}
   if(op==='.'||op==='['){this.pop();const key=op==='.'?this.pop():this.expr();if(op==='[')this.need(']');left={kind:op==='.'?'field':'index',object:left,key};continue;}
   const p=prec[op];if(p===undefined||p<min)break;this.pop();if(op==='?'){const yes=this.expr();this.need(':');left={kind:'ternary',cond:left,yes,no:this.expr(p)};}else left={kind:'binary',op,left,right:this.expr(p+(p===1?0:1))};
  }return left;
 }
}
// The numeric compiler emits one scalar instruction per line. Its loops are
// already unrolled. Keep simultaneous vector assignments as snapshots unless
// both the snapshot and its source stay unchanged for the rest of the call.
function simplifyKernel(lines, outputs) {
 const assignment=/^(let )?(r\d+)([+*/-]?=)([^;]+);$/;
 const registers=/\br\d+\b/g;
 const statements=lines.map(line=>assignment.exec(line));
 const lastWrite=new Map(), aliases=new Map(), needed=new Set(outputs);
 for(let i=0;i<lines.length;i++){
  if(statements[i])lastWrite.set(statements[i][2],i);
 }
 const resolve=register=>aliases.get(register)??register;
 const simplified=[];
 for(let i=0;i<lines.length;i++){
  const match=statements[i];
  if(!match){simplified.push(lines[i].replace(registers,resolve));continue;}
  const [,declaration='',dest,op,rhs]=match;
  const value=rhs.replace(registers,resolve);
  if(declaration && lastWrite.get(dest)===i && !needed.has(dest)){
   const constant=/^(?:true|false|\d+(?:\.\d+)?)$/.test(value);
   const stable=/^r\d+$/.test(value) && (lastWrite.get(value)??-1)<=i;
   if(constant||stable){aliases.set(dest,value);continue;}
  }
  simplified.push(declaration+dest+op+value+';');
 }
 // Scalar assignments have pure right-hand sides. Sampling, discard, control
 // flow and derivative captures are separate instructions and always survive.
 const kept=[];
 for(let i=simplified.length-1;i>=0;i--){
  const line=simplified[i], match=assignment.exec(line);
  if(match&&!needed.has(match[2]))continue;
  for(const register of (match?match[4]:line).match(registers)??[])needed.add(register);
  kept.push(line);
 }
 return kept.reverse().join('\n');
}

class Compiler {
 constructor(parsed,varyings,uniforms){Object.assign(this,{parsed,varyings,uniforms});this.lines=[];this.n=0;this.scopes=[new Map()];this.depth=0;this.derivatives=[];this.samplerNames=[];this.branchCount=0;}
 line(s){this.lines.push(s);if(this.lines.length>50000)throw Error('shader instruction budget');}
 // Helper lanes follow the covered pixel into branches containing a derivative.
 // Branches that only compute its operand still use each lane's own inputs.
 finishBranch(site,condition,before){
  if(this.derivatives.length===before)return;
  const slot=this.branchCount++;
  this.lines[site]=`if(collect===2?branches[${slot}]:(branches[${slot}]=${condition})){`;
 }
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
 expr(e){if(e.kind==='number')return this.value(e.type,[String(e.value)]);if(e.kind==='id')return this.lookup(e.name);
  if(e.kind==='field'){const a=this.expr(e.object);if(this.parsed.structs.has(a.type)){let offset=0;for(const f of this.parsed.structs.get(a.type)){const n=this.size(f.type);if(f.name===e.key)return this.value(f.type,a.parts.slice(offset,offset+n));offset+=n;}throw Error('struct field');}
   const chars=e.key.split(''),index=c=>'xyzw'.includes(c)?'xyzw'.indexOf(c):'rgba'.includes(c)?'rgba'.indexOf(c):'stpq'.indexOf(c);if(chars.some(c=>index(c)<0||index(c)>=a.parts.length))throw Error('swizzle');const base=String(a.type).startsWith('int')?'int':'float';return this.value(base+(chars.length===1?'':chars.length),chars.map(c=>a.parts[index(c)]));}
  if(e.kind==='index'){const a=this.expr(e.object),index=this.expr(e.key).parts[0],n=typeof a.type==='object'?this.size(a.type.array):a.type.includes('x')?Number(a.type.at(-1)):1,type=typeof a.type==='object'?a.type.array:n>1?'float'+n:'float';
   if(/^\d+$/.test(index))return this.value(type,a.parts.slice(Number(index)*n,(Number(index)+1)*n));
   return this.value(type,Array.from({length:n},(_,j)=>a.parts.filter((_,i)=>i%n===j).map((v,i,all)=>i===all.length-1?v:`(${index}===${i}?${v}:`).join('')+')'.repeat(a.parts.length/n-1)));}
  if(e.kind==='unary'){const a=this.expr(e.value);return this.variable(e.op==='!'?'bool':a.type,a.parts.map(x=>`(${e.op}${x})`));}
  if(e.kind==='ternary'){
   const c=this.expr(e.cond),outer=this.lines,before=this.derivatives.length;this.lines=[];
   const a=this.expr(e.yes),yes=this.lines;this.lines=[];const b=this.expr(e.no),no=this.lines;this.lines=outer;
   if(a.parts.length!==b.parts.length)throw Error('conditional shape');const out=this.variable(a.type);
   const site=this.lines.length;this.line(`if(${c.parts[0]}){`);for(const line of yes)this.line(line);this.assign(out,a);this.line('}else{');for(const line of no)this.line(line);this.assign(out,b);this.line('}');this.finishBranch(site,c.parts[0],before);return out;
  }
  if(e.kind==='binary'){const a=this.expr(e.left);if(['=','+=','-=','*=','/='].includes(e.op))return this.assign(a,this.expr(e.right),e.op);if(e.op==='&&'||e.op==='||'){
    const out=this.variable('bool',[a.parts[0]]),condition=(e.op==='||'?'!':'')+out.parts[0];
    const site=this.lines.length,before=this.derivatives.length;
    this.line(`if(${condition}){`);this.assign(out,this.expr(e.right));this.line('}');
    this.finishBranch(site,condition,before);return out;
   }const b=this.expr(e.right),n=Math.max(a.parts.length,b.parts.length);if(e.op==='*'&&(String(a.type).includes('x')||String(b.type).includes('x')))return this.matrix(a,b);
   if(n>1&&(e.op==='=='||e.op==='!=')){
    const equal=a.parts.map((part,i)=>'('+part+'==='+b.parts[i]+')').join('&&');
    return this.variable('bool',[e.op==='=='?'('+equal+')':'!('+equal+')']);
   }
   const comparison=['==','!=','<=','>=','<','>'].includes(e.op);
   const integers=String(a.type).startsWith('int')&&String(b.type).startsWith('int');
   const type=(comparison?'bool':integers?'int':'float')+(n===1?'':n);
   return this.variable(type,Array.from({length:n},(_,i)=>{
    const x=a.parts[i%a.parts.length],y=b.parts[i%b.parts.length];
    if(integers&&e.op==='*')return `Math.imul(${x},${y})`;
    const result=`(${x}${e.op}${y})`;
    return integers&&!comparison?`(${result}|0)`:result;
   }));}
  if(e.kind==='call'){if(e.callee.kind==='field'&&e.callee.key==='eval'){const s=this.expr(e.callee.object),uv=this.expr(e.args[0]);return this.sampleTexture(s,uv);}
   if(e.callee.kind!=='id')throw Error('shader callee');const name=e.callee.name;
   if(name==='dFdx'||name==='dFdy'||name==='fwidth'){
    const before=this.derivatives.length,a=this.expr(e.args[0]);if(this.derivatives.length!==before)throw Error('nested derivative');const id=this.derivatives.length;this.derivatives.push({name,size:a.parts.length});for(let i=0;i<a.parts.length;i++)this.line(`captured[${id*4+i}]=${a.parts[i]};`);return this.value(a.type,a.parts.map((_,i)=>`delta[${id*4+i}]`));}
   const args=e.args.map(a=>this.expr(a));
   if(this.parsed.types.has(name))return this.construct(name,args);
   const builtin=this.builtin(name,args);if(builtin)return builtin;
   const candidates=this.parsed.functions.get(name)??[],fn=candidates.find(f=>f.args.length===args.length&&f.args.every((a,i)=>this.size(a.type)===args[i].parts.length));if(!fn)throw Error('Unsupported function '+name);return this.call(fn,args);
  }throw Error('Unsupported expression '+e.kind);
 }
 construct(type,args){let parts=args.flatMap(a=>a.parts),n=this.size(type);if(n===1)return this.variable(type,[type==='bool'?`!!(${parts[0]})`:type==='int'?`Math.trunc(${parts[0]})`:parts[0]]);
  if(type.includes('x')&&args.length===1&&String(args[0].type).includes('x')){
   const from=Math.sqrt(parts.length),to=Math.sqrt(n),source=parts;
   parts=Array.from({length:n},(_,i)=>{
    const col=Math.floor(i/to),row=i%to;
    return row<from&&col<from?source[col*from+row]:String(Number(col===row));
   });
  }
  if(parts.length===1){if(type.includes('x')){const dim=Number(type.at(-1));parts=Array.from({length:n},(_,i)=>i%(dim+1)===0?parts[0]:'0');}else parts=Array(n).fill(parts[0]);}
  if(parts.length<n)throw Error('constructor shape');return this.variable(type,parts.slice(0,n).map(x=>type.startsWith('int')?'('+x+'|0)':x));
 }
 matrix(a,b){const am=String(a.type).includes('x'),bm=String(b.type).includes('x');if(am&&bm){
   const dim=Math.sqrt(a.parts.length);
   if(a.parts.length!==b.parts.length)throw Error('matrix shape');
   return this.variable(a.type,Array.from({length:dim*dim},(_,i)=>{
    const row=i%dim,col=Math.floor(i/dim);
    return Array.from({length:dim},(_,k)=>`(${a.parts[k*dim+row]}*${b.parts[col*dim+k]})`).join('+');
   }));
  }
  const m=am?a:b,v=am?b:a,n=Math.sqrt(m.parts.length);if(v.parts.length===1)return this.variable(m.type,m.parts.map(x=>`(${x}*${v.parts[0]})`));if(v.parts.length!==n)throw Error('matrix shape');return this.variable('float'+n,Array.from({length:n},(_,row)=>Array.from({length:n},(_,col)=>`(${m.parts[am?col*n+row:row*n+col]}*${v.parts[col]})`).join('+')));}
 builtin(name,args){const a=args[0],b=args[1],c=args[2],n=Math.max(...args.map(a=>a.parts.length)),type=n===1?'float':'float'+n;
  const at=(a,i)=>a.parts[i%a.parts.length],each=fn=>this.variable(type,Array.from({length:n},(_,i)=>fn(i)));
  if(name==='all'||name==='any')return this.variable('bool',[a.parts.join(name==='all'?'&&':'||')]);
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
  if(name==='distance')return this.variable('float',[ `Math.sqrt(${a.parts.map((v,i)=>`((${v}-${b.parts[i]})**2)`).join('+')})` ]);
  if(name==='length'||name==='normalize'){const len=this.variable('float',[`Math.sqrt(${a.parts.map(v=>`(${v}*${v})`).join('+')})`]).parts[0];return name==='length'?this.value('float',[len]):this.variable(a.type,a.parts.map(v=>`(${v}/${len})`));}
  if(name==='cross')return this.variable('float3',[0,1,2].map(i=>`(${a.parts[(i+1)%3]}*${b.parts[(i+2)%3]}-${a.parts[(i+2)%3]}*${b.parts[(i+1)%3]})`));
  if(name==='reflect'){const dot=a.parts.map((v,i)=>`(${v}*${b.parts[i]})`).join('+');return this.variable(a.type,a.parts.map((v,i)=>`(${v}-2*(${dot})*${b.parts[i]})`));}
  const op={lessThan:'<',lessThanEqual:'<=',greaterThan:'>',greaterThanEqual:'>=',equal:'===',notEqual:'!=='}[name];if(op)return each(i=>`(${at(a,i)}${op}${at(b,i)})`);
  return null;
 }
 sampleTexture(s,uv){const id=Number(s.parts[0]);if(!Number.isInteger(id))throw Error('dynamic sampler');const out=this.variable('float4');this.line(`sampleTexture(textures[${id}],${uv.parts[0]},${uv.parts[1]},texel);`);for(let i=0;i<4;i++)this.line(`${out.parts[i]}=texel[${i}];`);return out;}
 stmt(s,ret,label){if(s.kind==='block'){this.scopes.push(new Map());for(const node of s.body)this.stmt(node,ret,label);this.scopes.pop();}
  else if(s.kind==='decls'){for(const d of s.body){const init=d.value?this.expr(d.value):null;const v=this.variable(d.type,init?.parts);this.scopes.at(-1).set(d.name,v);}}
  else if(s.kind==='counted'){
   // A constant induction value also lets indexed uniforms use a fixed slot.
   // Any write to it produces an invalid assignment and declines this lowering.
   const enclosingLoop=this.loopLabel;
   this.loopLabel='L'+(++this.n);this.line(this.loopLabel+':{');
   for(let i=s.first;i<s.end;i+=s.step){
    this.iterations=(this.iterations??0)+1;if(this.iterations>512)throw Error('loop expansion budget');
    this.scopes.push(new Map([[s.name,this.value('int',[String(i)])]]));
    const outer=this.iterationLabel;
    this.iterationLabel='L'+(++this.n);
    this.line(this.iterationLabel+':{');this.stmt(s.body,ret,label);this.line('}');
    this.iterationLabel=outer;this.scopes.pop();
   }
   this.line('}');this.loopLabel=enclosingLoop;
  }
  else if(s.kind==='break'){
   if(!this.loopLabel)throw Error('break outside a supported loop');
   this.line('break '+this.loopLabel+';');
  }
  else if(s.kind==='continue'){
   if(!this.iterationLabel)throw Error('continue outside a supported loop');
   this.line('break '+this.iterationLabel+';');
  }
  else if(s.kind==='expr')this.expr(s.value);
  else if(s.kind==='if'){
   const condition=this.expr(s.cond).parts[0],site=this.lines.length,before=this.derivatives.length;
   this.line(`if(${condition}){`);this.stmt(s.yes,ret,label);
   if(s.no){this.line('}else{');this.stmt(s.no,ret,label);}
   this.line('}');this.finishBranch(site,condition,before);
  }
  else if(s.kind==='return'){if(s.value)this.assign(ret,this.expr(s.value));this.line(`break ${label};`);}
  else if(s.kind==='discard'){
   this.hasDiscard=true;
   this.line('return false;');
  }
  else throw Error('Unsupported statement');
 }
 call(fn,args){if(++this.depth>32)throw Error('shader call depth');const ret=this.variable(fn.type),label='L'+(++this.n);this.line(`${label}:{`);this.scopes.push(new Map());
  for(let i=0;i<args.length;i++)this.scopes.at(-1).set(fn.args[i].name,fn.args[i].q.some(q=>q==='out'||q==='inout')?args[i]:this.variable(fn.args[i].type,args[i].parts));
  this.stmt(fn.body,ret,label);this.scopes.pop();this.line('}');this.depth--;return ret;
 }
 interfaceValue(name){
  // GLSL interface arrays occupy one slot per element. The parser keeps
  // their shared declaration while the rasterizer supplies separate inputs.
  const element=/^(\w+)\[(\d+)\]$/.exec(name);
  if(!element)return this.lookup(name);
  const base=this.lookup(element[1]),type=base.type.array;
  const size=this.size(type),offset=Number(element[2])*size;
  return this.value(type,base.parts.slice(offset,offset+size));
 }
 compile(init,outputNames=['gl_FragColor'],vertex=false){
  const uniformSlots=[],uniformNames=new Map(this.uniforms.map(u=>[u.key,u.name]));const global=this.scopes[0];
  for(const d of this.parsed.globals){if(d.type==='shader'){global.set(d.name,this.value('shader',[String(this.samplerNames.length)]));this.samplerNames.push(d.name);continue;}
   const v=this.variable(d.type);global.set(d.name,v);
   if(d.q.includes('uniform')){const offset=uniformSlots.length;for(let i=0;i<v.parts.length;i++){uniformSlots.push([uniformNames.get(d.name)??d.name,i]);this.line(`${v.parts[i]}=uniforms[${offset+i}];`);}}
   else if(d.value)this.assign(v,this.expr(d.value));
  }
  const initParser=new Parser('void _init(){'+init+'}').parse();if(init)this.stmt(initParser.functions.get('_init')[0].body,this.value('void',[]),'unused');
  const inputNames=new Set(this.varyings.map(v=>v.name.split('[')[0]));
  const mutable=this.parsed.globals.filter(d=>d.type!=='shader'&&!d.q.includes('uniform')&&!d.q.includes('const')&&!inputNames.has(d.name)).flatMap(d=>this.lookup(d.name).parts);
  this.line(`const initialGlobals=[${mutable.join(',')}];`);
  const declarations=this.lines.join('\n');this.lines=[];
  mutable.forEach((v,i)=>this.line(`let ${v}=initialGlobals[${i}];`));
  for(let k=0;k<this.varyings.length;k++){
   const spec=this.varyings[k],v=this.interfaceValue(spec.name);
   const offset=vertex?'index*'+spec.size:'index';
   for(let c=0;c<v.parts.length;c++)this.line(`let ${v.parts[c]}=varyings[${k}][${offset}+${c}];`);
  }
  const coord=global.get('gl_FragCoord');if(coord)coord.parts.forEach((v,i)=>this.line(`${v}=${['fx','fy','z','1'][i]};`));const face=global.get('gl_FrontFacing');if(face)this.line(`${face.parts[0]}=front;`);
  this.call(this.parsed.functions.get('_sw_run')[0],[]);
  const outputs=outputNames.flatMap(name=>this.interfaceValue(name).parts);
  const specializeUniforms=declarations.length+this.lines.reduce((size,line)=>size+line.length+1,0)<=50000;
  const body=simplifyKernel(this.lines,outputs);
  const dest=vertex?'index*'+outputs.length+'+':'';
  let output=outputs.map((v,i)=>`result[${dest}${i}]=${v};`).join('');
  // The CPU JIT can skip the remainder of main for derivative helper lanes.
  // The final capture in emission order is also last on any path that reaches it.
  let shaderBody=body;
  if(this.derivatives.length){const end=Math.max(...[...body.matchAll(/captured\[\d+\]=[^;]+;/g)].map(m=>m.index+m[0].length));if(end>0)shaderBody=body.slice(0,end)+'if(collect)return;'+body.slice(end);}
  // Helper invocations that a discard would suppress still supply quad derivatives.
  if(this.branchCount){
   // If the center skipped every conditional derivative, it already produced
   // its final color. Return its coverage and skip both helpers and replay.
   shaderBody='let sampled=false;'+shaderBody.replace(/captured\[(\d+)\]=/g,(store,slot)=>Number(slot)%4===0?'sampled=true;'+store:store);
   output+='if(collect===1&&!sampled)return true;';
  }
  if(this.hasDiscard&&this.derivatives.length){
   // Helper lanes continue past discard to supply neighboring operands.
   const discard=this.branchCount?'if(collect!==2)return collect===1&&sampled?undefined:false;':'if(!collect)return false;';
   shaderBody=shaderBody.replaceAll('return false;',discard);
  }
  const branchState=this.branchCount?'const branches=[];':'';
  const code=`"use strict";${branchState}${declarations}\nreturn function shade(index,fx,fy,z,front,collect){${shaderBody}\n${output}};`;
  const make=new NumericFunction('uniforms','varyings','delta','captured','result','textures','sampleTexture','texel',code);
  // Specialization leaves uniforms as numeric literals inside the function,
  // allowing the JS JIT to fold lighting/material constants across pixels.
  // Cache factories, not bound images/arrays, so draw resources are not retained.
  const localBody=shaderBody.replace(/let r\d+=initialGlobals\[\d+\];/g,'').replace(/let (r\d+=varyings\[)/g,'$1');
  const localDecl=declarations.replace(/const initialGlobals=\[[^;]*;/,'');
  const literalCode=`"use strict";${branchState}return function shade(index,fx,fy,z,front,collect){${localDecl}\n${localBody}\n${output}};`;
  return {make,specializeUniforms,uniformSlots,samplers:this.samplerNames,derivatives:this.derivatives,code,literalCode,factories:new Map()};
 }
}
export function compileCPUFragment(translated){try{
 const output=translated.output||'gl_FragColor';
 const parsed=new Parser((output==='gl_FragColor'?'float4 gl_FragColor;':'')+'float4 gl_FragCoord;bool gl_FrontFacing;'+translated.code).parse();
 return new Compiler(parsed,translated.varyings,translated.uniforms).compile(translated.init,[output]);
}catch{return null;}}

export function compileCPUVertex(translated){try{
 const parsed=new Parser('float4 gl_Position;'+translated.code).parse();
 const cpu=new Compiler(parsed,translated.attributes,translated.uniforms).compile(translated.init,['gl_Position',...translated.varyings.map(v=>v.name)],true);
 return cpu.derivatives.length?null:cpu;
}catch{return null;}}
function bindShader(cpu,values,inputs,delta,captured,result,textures,texel,specialize=true){
 const uniforms=new Float64Array(cpu.uniformSlots.length);
 for(let i=0;i<uniforms.length;i++){const [name,index]=cpu.uniformSlots[i],value=values.get(name);uniforms[i]=Math.fround(typeof value==='number'?(index===0?value:0):value?.[index]??0);}
 // Model matrices often change on every draw. Reuse one compiled vertex
 // function instead of compiling another JS function for each moved object.
 // Large lighting programs would otherwise recompile for each material or light change.
 if(!specialize||!cpu.specializeUniforms)return cpu.make(uniforms,inputs,delta,captured,result,textures,sampleTexture,texel);
 const number=n=>Object.is(n,-0)?'-0':String(n),key=Array.from(uniforms,number).join(',');let factory=cpu.factories.get(key);
 if(!factory){const literal=cpu.literalCode.replace(/uniforms\[(\d+)\]/g,(_,i)=>number(uniforms[Number(i)]));factory=new NumericFunction('uniforms','varyings','delta','captured','result','textures','sampleTexture','texel',literal);cpu.factories.set(key,factory);if(cpu.factories.size>16)cpu.factories.delete(cpu.factories.keys().next().value);}
 return factory(uniforms,inputs,delta,captured,result,textures,sampleTexture,texel);
}
export function runCPUVertices(compiled,values,attributes,count,samplers=[]){
 // Vertex streams already use their declared stride. Feed those arrays to
 // the kernel and write its outputs straight into the clipper's buffer.
 const inputs=compiled.attributes.map(a=>attributes.get(a.name)??new Float32Array(count*a.size));
 const out=new Float32Array(count*compiled.outputCount);
 const textures=compiled.cpuVertex.samplers.map(name=>samplers.find(s=>s.key===name));
 const run=bindShader(compiled.cpuVertex,values,inputs,null,null,out,textures,new Float64Array(4),false);
 for(let i=0;i<count;i++)run(i,0,0,0,true,false);
 return out;
}

function wrapTexel(i,size,mode){
 if(i>=0&&i<size)return i;
 if(mode===10497)return ((i%size)+size)%size;
 if(mode===33648){
  const period=size*2,position=((i%period)+period)%period;
  return position<size?position:period-position-1;
 }
 return Math.max(0,Math.min(size-1,i));
}
function sampleTexture(t,x,y,out){
 const pixels=t?.pixels;
 if(!pixels){out[0]=out[1]=out[2]=0;out[3]=1;return;}
 const scale=pixels instanceof Float32Array?1:1/255;
 if(t.volume||t.mag===9728){
  const col=wrapTexel(Math.floor(x),t.width,t.wrapS);
  let row=wrapTexel(Math.floor(y),t.height,t.wrapT);
  if(t.topDown)row=t.height-1-row;
  if(t.depthPlane){out[0]=pixels[row*t.width+col];out[1]=out[2]=0;out[3]=1;return;}
  const p=(row*t.width+col)*4;
  for(let c=0;c<4;c++)out[c]=pixels[p+c]*scale;
  return;
 }
 x-=.5;y-=.5;
 const ix=Math.floor(x),iy=Math.floor(y),dx=x-ix,dy=y-iy;
 const col0=wrapTexel(ix,t.width,t.wrapS),col1=wrapTexel(ix+1,t.width,t.wrapS);
 let y0=wrapTexel(iy,t.height,t.wrapT),y1=wrapTexel(iy+1,t.height,t.wrapT);
 if(t.topDown){y0=t.height-1-y0;y1=t.height-1-y1;}
 const row0=y0*t.width,row1=y1*t.width;
 if(t.depthPlane){
  out[0]=(pixels[row0+col0]*(1-dx)+pixels[row0+col1]*dx)*(1-dy)+(pixels[row1+col0]*(1-dx)+pixels[row1+col1]*dx)*dy;
  out[1]=out[2]=0;out[3]=1;return;
 }
 const a=(row0+col0)*4,b=(row0+col1)*4,c=(row1+col0)*4,d=(row1+col1)*4;
 for(let k=0;k<4;k++)out[k]=((pixels[a+k]*(1-dx)+pixels[b+k]*dx)*(1-dy)+(pixels[c+k]*(1-dx)+pixels[d+k]*dx)*dy)*scale;
}
// Both tile shading and ordered blending use the same derivative quad. During
// collection only the center lane decides which derivative branches to visit.
function bindFragment(compiled,values,samplers,inputs){
 const cpu=compiled.cpu;
 const textures=cpu.samplers.map(name=>samplers.find(s=>s.key===name));
 const delta=new Float64Array(cpu.derivatives.length*4),captured=new Float64Array(delta.length),result=new Float64Array(4);
 const shade=bindShader(cpu,values,inputs,delta,captured,result,textures,new Float64Array(4));
 if(!delta.length)return {shade,inputs,result};
 const center=new Float64Array(delta.length),horizontal=new Float64Array(delta.length);
 function prepare(index,stride,px,py,front,dx,dy,z,zx,zy){
  delta.fill(0);captured.fill(0);
  const centerResult=shade(index,px,py,z,front,1);
  if(centerResult!==undefined)return centerResult;
  center.set(captured);
  shade(index+stride,px+dx,py,zx,front,2);
  horizontal.set(captured);
  captured.set(center);
  shade(index+2*stride,px,py-dy,zy,front,2);
  for(let d=0;d<cpu.derivatives.length;d++){
   const derivative=cpu.derivatives[d];
   for(let c=0;c<derivative.size;c++){
    const k=d*4+c,h=(horizontal[k]-center[k])*dx,v=(center[k]-captured[k])*dy;
    delta[k]=derivative.name==='dFdx'?h:derivative.name==='dFdy'?v:Math.abs(h)+Math.abs(v);
   }
  }
 }
 return {shade,inputs,result,prepare};
}
// A blend or discard can make several fragments at one pixel observable.
export function orderedCPUFragment(compiled,values,samplers){
 const stride=compiled.cpu.derivatives.length?12:4;
 const inputs=compiled.varyings.map(()=>new Float32Array(stride));
 return bindFragment(compiled,values,samplers,inputs);
}
export function runCPUFragment(compiled,values,samplers,coverage,varyings,width,height,left,top,canvasHeight){
 if(!compiled.cpu)return null;
 return createFragmentBatch(compiled,values,samplers)(coverage,varyings,width,height,left,top,canvasHeight);
}
// One draw can span many tiles. Bind uniforms and sampler state once while
// switching only the interpolated input planes at each tile boundary.
export function createFragmentBatch(compiled,values,samplers){
 const inputs=[];
 const {shade,result,prepare}=bindFragment(compiled,values,samplers,inputs);
 return function shadeTile(coverage,varyings,width,height,left,top,canvasHeight){
  for(let i=0;i<varyings.length;i++)inputs[i]=varyings[i];
  const stride=width*height*4;
  const out=compiled.rawColor?new Float32Array(stride):new Uint8Array(stride);
  for(let y=0;y<height;y++){
   for(let x=0;x<width;x++){
    const i=(y*width+x)*4;if(!coverage[i+3])continue;
    const px=left+x+.5,py=canvasHeight-top-y-.5;
    const kept=prepare?.(i,stride,px,py,coverage[i]>0,(left+x)%2?-1:1,(top+y)%2?-1:1,coverage[i+2],coverage[i+stride+2],coverage[i+2*stride+2]);
    if((kept??shade(i,px,py,coverage[i+2],coverage[i]>0,false))===false){
     coverage[i+3]=0;
     continue;
    }
    if(compiled.rawColor){out.set(result,i);continue;}
    const alpha=Math.max(0,Math.min(1,result[3]));
    for(let c=0;c<3;c++)out[i+c]=Math.round(Math.max(0,Math.min(1,result[c]))*alpha*255);
    out[i+3]=Math.round(alpha*255);
   }
  }
  return out;
 };
}
