#!/usr/local/bin/bun
// Experimental Flea bat argv adapter, using the unchanged bundled glow highlighter.
import {RuntimeRegistry} from './node_modules/jsmdcui/src/runtime/registry.js';
import {Colorscheme} from './node_modules/jsmdcui/src/config/colorscheme.js';
import {SyntaxDefinition,detectSyntax,loadSyntaxDefinitions} from './node_modules/jsmdcui/src/highlight/parser.js';
import {Highlighter} from './node_modules/jsmdcui/src/highlight/highlighter.js';
import {styleToAnsi} from './node_modules/jsmdcui/src/display/ansi-style.js';
import {fileURLToPath} from 'node:url';
import {adaptSyntaxRules} from './syntax-compat.mjs';
let name='',lang='',file=null,first=1,last=Infinity;
for(const arg of Bun.argv.slice(2)){
 if(['--no-config','--no-custom-assets','--theme=ansi','--color=always','--style=plain','--paging=never','--wrap=never'].includes(arg))continue;
 if(arg.startsWith('--file-name='))name=arg.slice(12);
 else if(arg.startsWith('--language='))lang=arg.slice(11);
 else if(arg.startsWith('--line-range=')){const m=/^--line-range=(\d+):(\d+)$/.exec(arg);if(!m)throw Error('Unsupported line range');first=+m[1];last=+m[2];}
 else if(arg.startsWith('-')&&arg!=='-')throw Error('Unsupported bat option: '+arg);
 else if(file!==null)throw Error('Only one input is supported');else file=arg;
}
const text=await (file&&file!=='-'?Bun.file(file):Bun.stdin).text();
if(Buffer.byteLength(text)>1048576)throw Error('Preview exceeds 1 MiB');
const runtime=new RuntimeRegistry({repoRoot:fileURLToPath(new URL('./node_modules/jsmdcui',import.meta.url)),configDir:'/tmp'});
await runtime.init({user:false});
const scheme=await new Colorscheme(runtime).load('simple'),defs=await loadSyntaxDefinitions(runtime);
adaptSyntaxRules(defs,SyntaxDefinition);
const lines=text.replace(/\r\n?/g,'\n').split('\n');if(lines.at(-1)==='')lines.pop();
const aliases={js:'javascript',jsx:'javascript',mjs:'javascript',cjs:'javascript',node:'javascript',nodejs:'javascript',ts:'typescript',tsx:'typescript',mts:'typescript',cts:'typescript',rs:'rust',py:'python',python3:'python',sh:'shell',bash:'shell',shellscript:'shell',md:'markdown',yml:'yaml',jsonc:'json',json5:'json',jsonl:'json',ndjson:'json',cpp:'c++',cc:'c++',cxx:'c++',hpp:'c++',cs:'csharp','c#':'csharp',rb:'ruby',golang:'go',kt:'kotlin',kts:'kotlin',ps1:'powershell',pwsh:'powershell',bat:'batch',cmd:'batch',docker:'dockerfile',make:'makefile',cmakelists:'cmake',tf:'terraform',proto:'proto',protobuf:'proto',tex:'tex',latex:'tex',diff:'patch',dotenv:'ini'};
const byType=new Map(defs.map(d=>[d.filetype.toLowerCase(),d]));
const lookup=key=>byType.get(aliases[key.toLowerCase()]||key.toLowerCase());
const path=name||file||'',ext=path.split('.').at(-1).toLowerCase();
const def=lang?lookup(lang):lookup(({jsx:'jsx',mts:'ts',cts:'ts',jsonc:'json',json5:'json',jsonl:'json',ndjson:'json',env:'ini'})[ext]||'')||detectSyntax(defs,{path,firstLine:lines[0]||'',lines:lines.slice(0,50)});
if(lang&&!def)process.exit(1);
const highlighter=def?new Highlighter(def,defs):null;let state=null;
for(let i=0;i<Math.min(lines.length,last);i++){
 const line=lines[i],result=highlighter?.highlightLine(line,state);if(result)state=result.state;
 if(i+1<first)continue;
 if(!result){process.stdout.write(line+'\n');continue;}
 const changes=[...result.changes.entries()];let output='';
 for(let j=0;j<changes.length-1;j++){
  const [from,group]=changes[j],to=changes[j+1][0];
  output+=styleToAnsi(scheme.get(group)).replace(/38;5;(\d+)/g,(_,n)=>String(+n<8?30+(+n):90+(+n)-8))+line.slice(from,to);
 }
 process.stdout.write(output+'\x1b[0m\n');
}
