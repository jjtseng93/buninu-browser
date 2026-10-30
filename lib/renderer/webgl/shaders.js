// CPU WebGL shaders use the browser's existing SkSL compiler. No host eval,
// native GL, or library-specific shader replacements are used here.
export function preprocess(source) {
  const macros=new Map(), stack=[]; let active=true;
  const expand=(text,depth=0)=>{
    if(depth>30)throw Error('Shader macro recursion limit');
    for(const [name,m] of macros)if(m.args){
      const re=new RegExp('\\b'+name+'\\s*\\(','g');let hit;
      while((hit=re.exec(text))){let end=re.lastIndex,level=1,start=end,args=[];for(;end<text.length&&level;end++){const c=text[end];if(c==='(')level++;else if(c===')'){if(--level===0)args.push(text.slice(start,end));}else if(c===','&&level===1){args.push(text.slice(start,end));start=end+1;}}if(level)break;
        const body=m.value.replace(/\b\w+\b/g,k=>m.args.includes(k)?args[m.args.indexOf(k)]:k);
        const value=expand(body,depth+1);text=text.slice(0,hit.index)+value+text.slice(end);re.lastIndex=hit.index+value.length;
      }
    }
    return text.replace(/\b[A-Za-z_]\w*\b/g,name=>{
      const m=macros.get(name);return m && !m.args ? expand(m.value,depth+1) : name;
    });
  };
  const condition=text=>{
    text=text.replace(/defined\s*(?:\(\s*(\w+)\s*\)|(\w+))/g,(_,a,b)=>macros.has(a||b)?'1':'0');
    text=expand(text).replace(/\b[A-Za-z_]\w*\b/g,'0');
    // A small expression parser, rather than executing shader text as JS.
    const tokens=text.match(/\d+(?:\.\d+)?|&&|\|\||==|!=|<=|>=|[()!~+*/%<>&|^-]/g)||[];let at=0;
    const prec={'||':1,'&&':2,'|':3,'^':4,'&':5,'==':6,'!=':6,'<':7,'>':7,'<=':7,'>=':7,'+':8,'-':8,'*':9,'/':9,'%':9};
    function expr(min=0){let t=tokens[at++],a;if(t==='('){a=expr();if(tokens[at++]!==')')throw Error('Invalid shader condition');}else if(['!','~','-','+'].includes(t)){const v=expr(10);a=t==='!'?!v:t==='~'?~v:t==='-'?-v:v;}else a=Number(t)||0;
      while(at<tokens.length && (prec[tokens[at]]??-1)>=min){const op=tokens[at++],b=expr(prec[op]+1);a=op==='||'?a||b:op==='&&'?a&&b:op==='=='?a===b:op==='!='?a!==b:op==='<'?a<b:op==='>'?a>b:op==='<='?a<=b:op==='>='?a>=b:op==='+'?a+b:op==='-'?a-b:op==='*'?a*b:op==='/'?a/b:op==='%'?a%b:op==='&'?a&b:op==='|'?a|b:a^b;}return a;}
    return !!expr();
  };
  const lines=String(source).replace(/\\\r?\n/g,'').replace(/\/\*[\s\S]*?\*\//g,' ').replace(/\/\/[^\n]*/g,'').split('\n'),out=[];
  for(const line of lines){const d=line.match(/^\s*#\s*(\w+)\s*(.*)$/);if(!d){if(active)out.push(expand(line));continue;}const [,op,rest]=d;
    if(['if','ifdef','ifndef'].includes(op)){const yes=op==='if'?condition(rest):op==='ifdef'?macros.has(rest.trim()):!macros.has(rest.trim());stack.push({parent:active,taken:yes});active=active&&yes;}
    else if(op==='else'||op==='elif'){const top=stack.at(-1);if(!top)throw Error('Unmatched shader conditional');const yes=!top.taken&&(op==='else'||condition(rest));top.taken ||= yes;active=top.parent&&yes;}
    else if(op==='endif'){const top=stack.pop();if(!top)throw Error('Unmatched shader endif');active=top.parent;}
    else if(active&&op==='define'){const m=rest.match(/^(\w+)(\([^)]*\))?\s*(.*)$/);if(m)macros.set(m[1],{args:m[2]?.slice(1,-1).split(',').map(s=>s.trim()),value:m[3]||'1'});}
    else if(active&&op==='undef')macros.delete(rest.trim());
    else if(active&&op==='error')throw Error(rest);
  }
  if(stack.length)throw Error('Unclosed shader conditional');return out.join('\n');
}
const typeMap={vec2:'float2',vec3:'float3',vec4:'float4',ivec2:'int2',ivec3:'int3',ivec4:'int4',bvec2:'bool2',bvec3:'bool3',bvec4:'bool4',mat2:'float2x2',mat3:'float3x3',mat4:'float4x4'};
export const components=type=>({float:1,int:1,bool:1,vec2:2,vec3:3,vec4:4,mat2:4,mat3:9,mat4:16}[type]||1);
export const glType=type=>({float:0x1406,int:0x1404,bool:0x8B56,vec2:0x8B50,vec3:0x8B51,vec4:0x8B52,mat2:0x8B5A,mat3:0x8B5B,mat4:0x8B5C,sampler2D:0x8B5E}[type]||0);
export function translate(source,stage) {
 let code=preprocess(source).replace(/\bprecision\s+\w+\s+\w+\s*;/g,'').replace(/\b(?:highp|mediump|lowp)\s+/g,'');
 const structs=new Map();for(const m of code.matchAll(/struct\s+(\w+)\s*\{([^{}]*)\}\s*;/g))structs.set(m[1],fields(m[2]));
 const uniforms=[],attributes=[],varyings=[],assign=[];let output=null;
 function flatten(type,name,path,size=1){if(structs.has(type)){for(let i=0;i<size;i++)for(const f of structs.get(type))flatten(f.type,name+'_'+i+'_'+f.name,path+(size>1?'['+i+']':'')+'.'+f.name,f.size);return;}uniforms.push({name:path,key:name,type,size});assign.push(`${path}=${name};`);}
 code=code.replace(/\buniform\s+(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;/g,(_,type,name,n)=>{const size=Number(n)||1;if(structs.has(type)){flatten(type,'_sw_u_'+name,name,size);return `${type} ${name}${n?'['+n+']':''};`;}uniforms.push({name,key:name,type,size});return '';});
 code=code.replace(/layout\s*\([^)]*\)\s*/g,'');
 code=code.replace(/\b(attribute|varying|in|out)\s+(\w+)\s+(\w+)\s*;/g,(_,kind,type,name)=>{if(kind==='out'&&stage==='fragment'){output=name;return `${type} ${name};`;}const list=kind==='attribute'||(kind==='in'&&stage==='vertex')?attributes:varyings;list.push({name,type,size:components(type)});return `${type} ${name};`;});
 code=code.replace(/\bvoid\s+main\s*\(\s*(?:void)?\s*\)/,'void _sw_run()');
 code=code.replace(/\b(?:[ib]?vec[234]|mat[234])\b/g,t=>typeMap[t]);
 for(const u of uniforms)if(u.type==='bool'){u.key='_sw_bool_'+u.key;code='bool '+u.name+';\n'+code;assign.push(`${u.name}=bool(${u.key});`);}
 const declarations=uniforms.map(u=>`uniform ${u.type==='bool'?'int':typeMap[u.type]||u.type} ${u.key}${u.size>1?'['+u.size+']':''};`).join('\n');
 return {output,code:declarations+'\n'+code,uniforms,attributes,varyings,init:assign.join('\n')};
}
function fields(body){return [...body.matchAll(/(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;/g)].map(m=>({type:m[1],name:m[2],size:Number(m[3])||1}));}
