import {createInertWindow} from '../happy-dom/parser.js';
import {parseQml} from './parser.js';
import {createReactive} from './reactive.js';
import {createQmlRuntime} from './runtime.js';
import {builtinTypes, loadQmlGraph} from './loader.js';


const types = builtinTypes;
const defaults = ['width','height','implicitWidth','implicitHeight','x','y','color','radius',
  'opacity','visible','enabled','clip','text','title','font','border','anchors','horizontalAlignment','textFormat','spacing','placeholderText','readOnly','selectByMouse','Accessible'];
const groups = new Set(['font.pixelSize','font.family','font.bold','border.width','border.color',
  'anchors.fill','anchors.centerIn','anchors.margins','Accessible.name']);

// Rewrite only QML-resolved names; all other identifiers retain page JS meaning.
// Function/block-local names shadow QML properties. No eval in the host process.
function expression(property, scope) {
  const edits = [];
  function walk(node, parent, key, locals = new Set()) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) walk(child, parent, key, locals); return; }
    if (['FunctionExpression','ArrowFunctionExpression','FunctionDeclaration','BlockStatement','Program'].includes(node.type)) {
      locals = new Set(locals);
      const addPattern = n => {
        if (!n) return;
        if (n.type === 'Identifier') locals.add(n.name);
        else if (n.type === 'Property') addPattern(n.value);
        else for (const [k,v] of Object.entries(n)) if (k !== 'type') {
          if (Array.isArray(v)) v.forEach(addPattern); else if (v && typeof v === 'object') addPattern(v);
        }
      };
      node.params?.forEach(addPattern); addPattern(node.id);
      for (const statement of node.body?.body ?? (Array.isArray(node.body) ? node.body : [])) {
        if (statement.type === 'VariableDeclaration') statement.declarations.forEach(d => addPattern(d.id));
        if (statement.type === 'FunctionDeclaration') addPattern(statement.id);
      }
    }
    if (node.type === 'Identifier' && scope.has(node.name) && !locals.has(node.name)) {
      if ((parent?.type === 'MemberExpression' && key === 'property' && !parent.computed)
        || (parent?.type === 'Property' && key === 'key')
        || (parent?.type === 'VariableDeclarator' && key === 'id')) return;
      const replacement = scope.get(node.name);
      edits.push([node.start,node.end,parent?.type === 'Property' && parent.shorthand ? `${node.name}: ${replacement}` : replacement]);
      return;
    }
    for (const [k,v] of Object.entries(node)) if (k !== 'type' && v && typeof v === 'object') walk(v,node,k,locals);
  }
  walk(property.ast,null,null);
  let code = property.code;
  for (const [start,end,value] of edits.sort((a,b)=>b[0]-a[0])) code = code.slice(0,start)+value+code.slice(end);
  return property.block ? `(()=>${code})()` : code;
}

/** Asynchronous import preparation uses the browser's existing resource bridge. */
export async function loadQmlDocument(source, url, options = {}) {
  try {
    if (options.scripting === false) return createQmlDocument(source, url, options);
    const graph = await loadQmlGraph(source, url, options.fetchResource);
    return createQmlDocument(source, url, {...options, graph});
  } catch (error) { return createQmlDocument(source, url, {...options, error}); }
}

/** Build actual DOM nodes. Import ASTs are discarded after compiling the page. */
export function createQmlDocument(source, url, {scripting = true, graph = null, error = null} = {}) {
  const window = createInertWindow(url), document = window.document;
  document.body.style.cssText = 'margin:0;overflow:hidden';
  try {
    if (error) throw error;
    if (!scripting) throw Error('QML rendering requires page scripting; source shown below.');
    if (!graph) {
      const ast = parseQml(source);
      for (const imp of ast.imports) if (!/^(QtQuick(?:\.Controls)?|Quickshell)(?:\s+\d+(?:\.\d+)?)?$/.test(imp)) throw Error(`Unsupported QML import: ${imp}`);
      graph = {entry:url, documents:new Map([[url,{url,ast,types:new Map(),values:new Map(),builtins:new Map()}]]), scripts:new Map()};
    }
    const records = [], contexts = [], singletons = new Map(), singletonStack = [], scripts = [];
    const constants = 'const Text={AlignLeft:1,AlignHCenter:4,PlainText:0};';
    const ref = record => `n${record.index}`;
    function context(doc) {
      const ctx={doc,ids:new Map(),values:new Map(),index:contexts.length,root:null};contexts.push(ctx);
      for (const [name,value] of doc.values) {
        if(value.kind==='singleton') {
          if(singletonStack.includes(value.url))throw Error(`Cyclic singleton dependency: ${[...singletonStack,value.url].join(' -> ')}`);
          if(!singletons.has(value.url)) {
            singletonStack.push(value.url);
            const child=context(graph.documents.get(value.url));
            const record=build(child.doc.ast.root,null,child,[]);
            record.element.style.display='none';record.nonvisual=true;
            singletons.set(value.url,record);singletonStack.pop();
          }
          ctx.values.set(name,ref(singletons.get(value.url)));
        } else ctx.values.set(name,script(value.url,ctx));
      }
      for(const alias of doc.builtins.keys())ctx.values.set(`${alias}.Text`,'Text');
      return ctx;
    }
    const libraryScripts=new Map();
    function script(href,ctx,chain=[]) {
      if(chain.includes(href))throw Error(`Cyclic JS import: ${href}`);
      const item=graph.scripts.get(href);if(!item)throw Error(`Missing JS resource ${href}`);
      const cache=item.library?libraryScripts:(ctx.scriptCache??=new Map());
      if(cache.has(href))return cache.get(href);
      const deps=item.deps.map(d=>`const ${d.alias}=${script(d.url,ctx,[...chain,href])};`).join('\n');
      const name=`j${scripts.length}`;
      scripts.push({name,deps,item,ctx});
      cache.set(href,name);return name;
    }
    function addProperties(record,object,ctx) {
      for(const p of object.properties) {
        if(p.key==='id') {
          if(!/^[A-Za-z_][\w]*$/.test(p.code)||ctx.ids.has(p.code))throw Error(`Invalid or duplicate QML id: ${p.code}`);
          ctx.ids.set(p.code,ref(record));
          record.element.id=ctx.index===entryContext?.index?p.code:`qml-${ctx.index}-${p.code}`;
          continue;
        }
        if(['__proto__','constructor','prototype'].includes(p.key))throw Error(`Invalid QML property: ${p.key}`);
        if(p.key==='textFormat'&&!['Text.PlainText','0',...[...ctx.doc.builtins.keys()].map(alias=>`${alias}.Text.PlainText`)].includes(p.code))throw Error('Unsupported QML textFormat: only Text.PlainText is implemented');
        if(p.custom||p.method) {
          if(p.custom&&!['int','real','bool','string','var','color','alias'].includes(p.propertyType))throw Error(`Unsupported QML property type: ${p.propertyType}`);
          if(record.names.has(p.key))throw Error(`Duplicate QML property: ${p.key}`);
          record.names.add(p.key);
        } else if(!record.names.has(p.key)&&!groups.has(p.key)&&!['onClicked','Component.onCompleted'].includes(p.key))throw Error(`Unsupported QML property: ${p.key}`);
        const previous=record.properties.get(p.key);
        if(previous?.p.readonly&&!p.custom)throw Error(`Cannot override readonly QML property: ${p.key}`);
        record.properties.set(p.key,{p,ctx});
      }
    }
    function build(object,parent,ctx,chain) {
      const resolution=ctx.doc.types.get(object.type);
      if(resolution?.url) {
        if(chain.includes(resolution.url)||chain.length>48)throw Error(`Recursive QML component: ${[...chain,resolution.url].join(' -> ')}`);
        const inner=context(graph.documents.get(resolution.url));
        const record=build(inner.doc.ast.root,parent,inner,[...chain,resolution.url]);
        if(!ctx.root)ctx.root=record;
        addProperties(record,object,ctx);
        for(const child of object.children)build(child,record,ctx,chain);
        return record;
      }
      const type=resolution?.builtin??object.type;
      if(!types.has(type))throw Error(`Unsupported QML type: ${object.type}`);
      if(records.length>=2000)throw Error('QML expanded object limit');
      const element=document.createElement(type==='TextField'?'input':type==='Button'?'button':'div');
      const record={index:records.length,type,parent,ctx,element,names:new Set(['QtObject','Singleton'].includes(type)?[]:defaults),properties:new Map(),nonvisual:['QtObject','Singleton'].includes(type)};
      records.push(record);if(!ctx.root)ctx.root=record;
      if(record.nonvisual)element.style.display='none';
      element.setAttribute('data-qml-node',String(record.index));element.setAttribute('data-qml-type',type);
      if(type==='TextField')element.setAttribute('type','text');if(type==='Button')element.setAttribute('type','button');
      (parent?.element??document.body).appendChild(element);
      addProperties(record,object,ctx);
      for(const child of object.children)build(child,record,ctx,chain);
      return record;
    }
    let entryContext;
    entryContext=context(graph.documents.get(graph.entry));
    build(entryContext.doc.ast.root,null,entryContext,[graph.entry]);
    const code=[`(()=>{const r=(${createQmlRuntime.toString()})((${createReactive.toString()})());`,constants];
    for(const record of records)code.push(`const ${ref(record)}=r.make(document.querySelector('[data-qml-node="${record.index}"]'),${JSON.stringify(record.type)});`);

    function scopeFor(record,ctx) {
      const scope=new Map();
      const namespaces=new Map();
      for(const [name,value]of ctx.values){const parts=name.split('.');if(parts.length===1)scope.set(name,value);else{if(!namespaces.has(parts[0]))namespaces.set(parts[0],[]);namespaces.get(parts[0]).push(`[${JSON.stringify(parts[1])}]:${value}`);}}
      for(const [name,parts]of namespaces)scope.set(name,`({${parts.join(',')}})`);
      for(const [name,value]of ctx.ids)scope.set(name,value);
      const ancestors=[];for(let p=record;p;p=p.parent)if(p.ctx===ctx||p===record)ancestors.unshift(p);
      if(!ancestors.includes(ctx.root))ancestors.unshift(ctx.root);
      for(const p of ancestors)for(const key of p.names)scope.set(key,`${ref(p)}.${key}`);
      scope.set('parent',record.parent?ref(record.parent):'r.viewport');return scope;
    }
    for(const {name,deps,item,ctx}of scripts) {
      const scope=item.library?new Map():scopeFor(ctx.root,ctx);
      for(const dep of item.deps)scope.delete(dep.alias);
      const body=expression({code:item.source,ast:item.ast,block:false},scope);
      code.push(`const ${name}=(()=>{${deps}\n${body}\nreturn Object.defineProperties({}, {${item.exports.map(e=>`[${JSON.stringify(e.name)}]:{enumerable:true,get:()=>${e.name}${e.writable?`,set:v=>{${e.name}=v;}`:''}}`).join(',')}});})();`);
    }
    // Methods/aliases exist before any property bindings read them.
    for(const record of records)for(const {p,ctx}of record.properties.values()) {
      const scope=scopeFor(record,ctx);
      if(p.method)code.push(`${ref(record)}.${p.key}=(${expression(p,scope)});`);
      if(p.propertyType==='alias'){
        if(!['Identifier','MemberExpression'].includes(p.ast.type))throw Error(`Invalid QML alias ${p.key}`);
        const value=expression(p,scope);
        code.push(`r.alias(${ref(record)},${JSON.stringify(p.key)},()=>(${value}),v=>{${value}=v;},${!!p.readonly});`);
      }
    }
    const completed=[];
    for(const record of records) {
      const n=ref(record);
      for(const dimension of ['width','height'])if(!record.properties.has(dimension)) {
        const implicit=dimension==='width'?'implicitWidth':'implicitHeight';
        code.push(`r.bind(${n},'${dimension}',()=>${n}.anchors.fill ? ${n}.anchors.fill.${dimension}-${n}.anchors.margins*2 : ${!record.parent&&record.type==='FloatingWindow'?`r.viewport.${dimension}`:`${n}.${implicit} ?? ${record.parent?'null':`r.viewport.${dimension}`}`});`);
      }
      for(const {p,ctx}of record.properties.values()) {
        if(p.method||p.propertyType==='alias')continue;
        const value=expression(p,scopeFor(record,ctx));
        if(p.key==='Component.onCompleted'){completed.push(`${value};`);continue;}
        if(p.key==='onClicked'){code.push(`document.querySelector('[data-qml-node="${record.index}"]').addEventListener('click',event=>{${value};});`);continue;}
        const parts=p.key.split('.'),key=parts.pop(),target=n+(parts.length?'.'+parts.join('.'):'');
        code.push(`r.bind(${target},${JSON.stringify(key)},()=>(${value}),${!!p.readonly});`);
      }
      if(record.nonvisual)code.push(`${n}.visible=false;`);
    }
    code.push(...completed,'})();');
    const scriptElement=document.createElement('script');scriptElement.textContent=code.join('\n');document.body.appendChild(scriptElement);
  }catch(error){
    document.body.replaceChildren();document.body.style.cssText='margin:16px';
    const heading=document.createElement('h1');heading.textContent='QML experiment';
    const message=document.createElement('p');message.textContent=String(error.message);
    const pre=document.createElement('pre');pre.textContent=source;document.body.append(heading,message,pre);
  }
  return {window,document};
}
