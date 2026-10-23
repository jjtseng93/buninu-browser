// Exercise the official backend, including bat path validation, sandbox and SGR parsing.
import cases from './highlight-cases.json' with {type:'json'};
import {mkdir,realpath} from 'node:fs/promises';
const base='/root/flea-demo/code';
await mkdir(base,{recursive:true});
if(!(await realpath('/usr/local/bin/bat')).startsWith('/usr/'))throw Error('Flea requires bat realpath under /usr');
const p=Bun.spawn(['/usr/bin/flea','--backend'],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
const errors=new Response(p.stderr).text();
let pending,token=0;
const reader=(async()=>{
 let buffer='';const decoder=new TextDecoder();
 for await(const chunk of p.stdout){
  buffer+=decoder.decode(chunk,{stream:true});let i;
  while((i=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
   const msg=JSON.parse(line);if(msg.t==='code'&&msg.token===token)pending?.(msg);
  }
 }
})();
async function ask(params){
 token++;
 let timer;
 try{return await new Promise((resolve,reject)=>{
  pending=resolve;timer=setTimeout(()=>reject(Error('Timed out: '+JSON.stringify(params))),15000);
  p.stdin.write(JSON.stringify({c:'code',token,slot:'verify',first:1,count:400,...params})+'\n');
 });}finally{clearTimeout(timer);pending=null;}
}
let checks=0;
try{
 for(const sample of cases){
  const path=base+'/'+sample.name;await Bun.write(path,sample.text);
  for(const query of [{path},{text:sample.text,name:sample.name,lang:sample.lang}]){
   const result=await ask(query);
   const colored=result.lines?.some(line=>line.some((v,i)=>i%2===0&&v>0));
   if(result.state!=='styled'||!colored)throw Error(`${sample.name} (${query.path?'file':sample.lang}): ${JSON.stringify(result)}`);
   const text=result.lines.map(line=>line.filter((_,i)=>i%2===1).join('')).join('\n');
   if(text!==sample.text.trimEnd())throw Error('Text changed: '+sample.name);
   checks++;
  }
 }
 const plain=await ask({text:'plain text\n',name:'sample.unknown',lang:'not-a-real-language'});
 if(plain.state!=='plain')throw Error('Unknown language must fall back to plain text');
 console.log(`PASS: official Flea colored ${cases.length} formats, ${checks} file/language requests; unknown language falls back to plain`);
}finally{
 p.stdin.write('{"c":"quit"}\n');p.stdin.end();await p.exited;await reader;
 const stderr=await errors;if(stderr)console.error(stderr);
}
