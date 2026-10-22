import {createInertWindow} from '../happy-dom/parser.js';
import {parseQml} from './parser.js';
import {createReactive} from './reactive.js';
import {createQmlRuntime} from './runtime.js';


const types = new Set(['Item', 'Rectangle', 'Text', 'MouseArea', 'FloatingWindow', 'Column', 'Label', 'TextField', 'Button']);
const defaults = ['width','height','implicitWidth','implicitHeight','x','y','color','radius',
  'opacity','visible','enabled','clip','text','title','font','border','anchors','horizontalAlignment','spacing','placeholderText','readOnly','selectByMouse','Accessible'];
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

/** Build actual DOM nodes, never HTML text. AST exists only during this call. */
export function createQmlDocument(source, url, {scripting = true} = {}) {
  const window = createInertWindow(url), document = window.document;
  document.body.style.cssText = 'margin:0;overflow:hidden';
  try {
    if (!scripting) throw new Error("QML rendering requires page scripting; source shown below.");
    const ast = parseQml(source);
    for (const imp of ast.imports) {
      if (!/^(QtQuick(?:\.Controls)?|Quickshell)(?:\s+\d+(?:\.\d+)?)?$/.test(imp)) throw new Error(`Unsupported QML import: ${imp}`);
    }
    const records = [], ids = new Map();
    function build(object, parent = null) {
      if (!types.has(object.type)) throw new Error(`Unsupported QML type: ${object.type}`);
      const index = records.length, element = document.createElement(object.type === 'TextField' ? 'input' : object.type === 'Button' ? 'button' : 'div');
      const record = {object,parent,index,element,names:new Set(defaults)};
      records.push(record); element.setAttribute('data-qml-node',String(index));
      element.setAttribute('data-qml-type',object.type);
      if (object.type === 'TextField') element.setAttribute('type','text');
      if (object.type === 'Button') element.setAttribute('type','button');
      (parent?.element ?? document.body).appendChild(element);
      for (const p of object.properties) {
        if (p.key === 'id') {
          if (!/^[a-zA-Z_][\w]*$/.test(p.code) || ids.has(p.code)) throw new Error(`Invalid or duplicate QML id: ${p.code}`);
          ids.set(p.code,`n${index}`); element.id = p.code;
        } else if (p.custom) {
          if (!['int','real','bool','string','var','color'].includes(p.propertyType) || !/^[a-zA-Z_][\w]*$/.test(p.key)
            || ['__proto__','constructor','prototype'].includes(p.key) || record.names.has(p.key)) throw new Error(`Unsupported QML property: ${p.key}`);
          record.names.add(p.key);
        } else if (!defaults.includes(p.key) && !groups.has(p.key) && !['onClicked','Component.onCompleted'].includes(p.key)) {
          throw new Error(`Unsupported QML property: ${p.key}`);
        }
      }
      for (const child of object.children) build(child,record);
    }
    build(ast.root);
    const code = [`(()=>{const r=(${createQmlRuntime.toString()})((${createReactive.toString()})());`,
      'const Text={AlignLeft:1,AlignHCenter:4};'];
    for (const {index,object} of records) code.push(`const n${index}=r.make(document.querySelector('[data-qml-node="${index}"]'),${JSON.stringify(object.type)});`);
    const completed = [];
    for (const record of records) {
      const {index,object,parent} = record, scope = new Map(ids);
      const ancestors=[]; for(let p=record;p;p=p.parent) ancestors.unshift(p);
      for(const p of ancestors) for(const key of p.names) scope.set(key,`n${p.index}.${key}`);
      scope.set('parent',parent ? `n${parent.index}` : 'r.viewport');
      for (const dimension of ['width','height']) {
        if (!object.properties.some(p=>p.key === dimension)) {
          const implicit = dimension === 'width' ? 'implicitWidth' : 'implicitHeight';
          code.push(`r.bind(n${index},'${dimension}',()=>n${index}.anchors.fill
            ? n${index}.anchors.fill.${dimension} - n${index}.anchors.margins * 2
            : ${!parent && object.type === 'FloatingWindow' ? `r.viewport.${dimension}` : `n${index}.${implicit} ?? ${parent ? 'null' : `r.viewport.${dimension}`}`});`);
        }
      }
      for (const p of object.properties) {
        if (p.key === 'id') continue;
        const value = expression(p,scope);
        if (p.key === 'Component.onCompleted') { completed.push(`${value};`); continue; }
        if (p.key === 'onClicked') {
          code.push(`document.querySelector('[data-qml-node="${index}"]').addEventListener('click',event=>{${value};});`); continue;
        }
        const parts=p.key.split('.'), key=parts.pop(), target=`n${index}${parts.length?'.'+parts.join('.'):''}`;
        code.push(`r.bind(${target},${JSON.stringify(key)},()=>(${value}));`);
      }
    }
    code.push(...completed,'})();');
    const script = document.createElement('script'); script.textContent = code.join('\n'); document.body.appendChild(script);
  } catch (error) {
    document.body.replaceChildren(); document.body.style.cssText = 'margin:16px';
    const heading=document.createElement('h1'); heading.textContent='QML experiment';
    const message=document.createElement('p'); message.textContent=String(error.message);
    const pre=document.createElement('pre'); pre.textContent=source;
    document.body.append(heading,message,pre);
  }
  return {window,document};
}
