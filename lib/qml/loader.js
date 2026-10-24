// Resolution only: source is fetched via the existing renderer resource bridge.
// No filesystem access, host evaluation, native plugins, or persistent global cache.
import { parseQml } from './parser.js';
import { parse } from '../../vendor/acorn/dist/acorn.mjs';
export const builtinTypes = new Set([
  'MediaPlayer', 'AudioOutput', 'VideoOutput', 'IdleInhibitor',
  'Canvas',
  'ShaderEffectSource',
  'LinearGradient',
  'XmlListModel',
  'XmlListModelRole',
  'WorkerScript',
  'LoggingCategory',
  'Flow',
  'RowLayout',
  'ColumnLayout',
  'ListView',
  'GridView',
  'ListModel',
  'DelegateModel',
  'DelegateModelGroup',
  'PointHandler',
  'Binding',
  'Gradient',
  'GradientStop',
  'PathRectangle',
  'IpcHandler',
  'DropArea',
  'DragHandler',
  'FrameAnimation',
  'Image',
  'Flickable',
  'TextInput',
  'TextEdit',
  'Item',
  'Rectangle',
  'Text',
  'MouseArea',
  'FloatingWindow',
  'Column',
  'Label',
  'TextField',
  'Button',
  'QtObject',
  'Singleton',
  'TextMetrics',
  'FontMetrics',
  'Timer',
  'Connections',
  'FileView',
  'Socket',
  'Process',
  'StdioCollector',
  'SplitParser',
  'Repeater',
  'TapHandler',
  'HoverHandler',
  'Row',
  'Grid',
  'Shape',
  'ShapePath',
  'PathSvg',
  'Scale',
  'Translate',
  'FocusScope',
  'ShellRoot',
  'Loader',
  'Component',
  'Behavior',
  'NumberAnimation',
  'PropertyAnimation',
  'PauseAnimation',
  'SequentialAnimation',
  'ParallelAnimation',
  'ScriptAction',
  'PropertyAction',
]);
const builtinModules = new Set([
  'QtQml.XmlListModel',
  'QtQml',
  'QtQml.Models',
  'QtMultimedia',
  'Quickshell.Wayland',
  'QtQuick',
  'QtQuick.Window',
  'QtQuick.Controls',
  'QtQuick.Shapes',
  'QtQuick.Layouts',
  'Quickshell',
  'Quickshell.Io',
  'Quickshell.Hyprland',
]);
const safeName = /^[A-Za-z_]\w*$/;
export function parseImport(line) {
  const m =
    /^(?:"([^"]+)"|([A-Za-z_]\w*(?:\.\w+)*))(?:\s+(\d+(?:\.\d+)?))?(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(
      line,
    );
  if (!m) throw Error(`Unsupported QML import: ${line}`);
  return { path: m[1], module: m[2], version: m[3], alias: m[4] };
}
export function parseQmldir(source, url, version) {
  const entries = new Map();
  let module = null;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'module') {
      module = parts[1];
      continue;
    }
    if (['typeinfo', 'designersupported'].includes(parts[0])) continue;
    if (
      [
        'plugin',
        'optional',
        'classname',
        'depends',
        'import',
        'prefer',
      ].includes(parts[0])
    )
      throw Error(`Unsupported qmldir directive at ${url}: ${line}`);
    const singleton = parts[0] === 'singleton',
      internal = parts[0] === 'internal';
    if (singleton || internal) parts.shift();
    const [name, ...rest] = parts;
    if (!safeName.test(name)) throw Error(`Invalid qmldir entry: ${line}`);
    const v = /^\d+\.\d+$/.test(rest[0]) ? rest.shift() : null;
    if (rest.length !== 1 || !rest[0].endsWith('.qml'))
      throw Error(`Unsupported qmldir entry: ${line}`);
    const [major, minor] = (v || '0.0').split('.').map(Number),
      [wantedMajor, wantedMinor] = (version || '').split('.').map(Number);
    if (version && v && (major !== wantedMajor || minor > (wantedMinor || 0)))
      continue;
    const old = entries.get(name),
      rank = major * 100000 + minor;
    if (!old || rank > old.rank)
      entries.set(name, {
        url: new URL(rest[0], url).href,
        singleton,
        internal,
        rank,
      });
  }
  return { entries, module };
}
function* graphSteps(source, url, fetchResource, { importRoots = [] } = {}) {
  const documents = new Map(),
    scripts = new Map(),
    reads = new Map();
  let bytes = 0;
  const base = new URL(url),
    resourceLimit = base.protocol === 'file:' ? 1024 : 128;
  const graph = { entry: url, documents, scripts };
  function allowed(href) {
    const u = new URL(href);
    if (!['file:', 'http:', 'https:'].includes(u.protocol))
      throw Error(`Unsupported QML resource URL: ${href}`);
    if (base.protocol !== 'file:' && u.protocol === 'file:')
      throw Error('Remote QML cannot import local files');
    return u.href;
  }
  function* read(href, optional = false, kind = 'metadata') {
    href = allowed(href);
    if (!reads.has(href)) {
      if (reads.size >= resourceLimit)
        throw Error('QML import resource limit (' + resourceLimit + ')');
      let response;
      try {
        response = yield { href, kind };
      } catch (error) {
        if (/ENOENT|not found|404/i.test(error.message))
          response = { status: 404 };
        else throw error;
      }
      let text = null;
      if (response.status !== 404) {
        if (response.ok === false)
          throw Error(`QML import failed (${response.status}): ${href}`);
        if (response.url) allowed(response.url);
        const body = response.body ?? new Uint8Array();
        bytes += body.byteLength;
        if (body.byteLength > 256 * 1024 || bytes > 4 * 1024 * 1024)
          throw Error('QML import byte limit');
        text = new TextDecoder().decode(body);
      }
      reads.set(href, text);
    }
    const text = reads.get(href);
    if (text === null && !optional)
      throw Error(`QML resource not found: ${href}`);
    return text;
  }
  function* script(href, chain = []) {
    if (chain.includes(href))
      throw Error(`Cyclic JS import: ${[...chain, href].join(' -> ')}`);
    if (scripts.has(href)) return;
    let text = yield* read(href, false, 'script');
    const deps = [];
    let library = false;
    text = text.replace(
      /^\s*\.(pragma\s+library|import\s+[^\n]+)\s*$/gm,
      (_all, directive) => {
        if (directive === 'pragma library') library = true;
        else {
          const imp = parseImport(directive.slice(7).trim());
          if (!imp.path?.endsWith('.js') || !imp.alias)
            throw Error(`Unsupported JS import in ${href}`);
          deps.push({ alias: imp.alias, url: new URL(imp.path, href).href });
        }
        return '';
      },
    );
    const ast = parse(text, { ecmaVersion: 'latest' }),
      exports = [];
    for (const node of ast.body) {
      if (node.type === 'FunctionDeclaration')
        exports.push({ name: node.id.name, writable: false });
      if (node.type === 'VariableDeclaration')
        for (const d of node.declarations) {
          if (d.id.type !== 'Identifier')
            throw Error(`Unsupported JS export pattern in ${href}`);
          exports.push({ name: d.id.name, writable: node.kind !== 'const' });
        }
    }
    scripts.set(href, { source: text, ast, exports, deps, library });
    for (const d of deps) yield* script(d.url, [...chain, href]);
  }
  function* document(href, text, depth = 0) {
    if (depth > 48) throw Error('QML import depth limit');
    if (documents.has(href)) return documents.get(href);
    let ast;
    try {
      ast = parseQml(text ?? (yield* read(href)));
    } catch (error) {
      throw Error(`QML load ${href}: ${error.message}`);
    }
    for (const pragma of ast.pragmas)
      if (!['Singleton', 'ComponentBehavior: Bound'].includes(pragma))
        throw Error(`Unsupported QML pragma in ${href}: ${pragma}`);
    const doc = {
      url: href,
      ast,
      types: new Map(),
      values: new Map(),
      builtins: new Map(),
      inlineScopes: new WeakMap(),
    };
    documents.set(href, doc);
    const dirs = [];
    const hasBase = ['http:', 'https:', 'file:'].includes(
      new URL(href).protocol,
    );
    function* directory(dir, alias, version, required = false, module) {
      const qurl = new URL('qmldir', dir).href,
        body = yield* read(qurl, !required);
      const meta =
        body === null
          ? { entries: new Map() }
          : parseQmldir(body, qurl, version);
      if (module && meta.module !== module)
        throw Error(`QML module mismatch: expected ${module} at ${qurl}`);
      dirs.push({ dir, alias, entries: meta.entries, implicit: false });
    }
    const knownGlobals = new Set([
      'Flow',
      'LoggingCategory',
      'XmlListModel',
      'ListView',
      'GridView',
      'Binding',
      'Gradient',
      'PointerHandler',
      'Drag',
      'Flickable',
      'Image',
      'TextInput',
      'TextEdit',
      'Application',
      'Easing',
      'Animation',
      'Text',
      'Behavior',
      'NumberAnimation',
      'PropertyAnimation',
      'PauseAnimation',
      'SequentialAnimation',
      'ParallelAnimation',
      'ScriptAction',
      'PropertyAction',
      'Component',
      'Loader',
      'Font',
      'Accessible',
      'Shape',
      'ShapePath',
      'Qt',
      'TapHandler',
      'Quickshell',
      'Hyprland',
      'FileViewError',
      'Math',
      'Number',
      'String',
      'Boolean',
      'Array',
      'Object',
      'JSON',
      'Date',
      'RegExp',
      'Map',
      'Set',
      'Promise',
      'Error',
      'TypeError',
      'Infinity',
      'NaN',
    ]);
    let needsLocal = false;
    const scan = (node, parent, key) => {
      if (!node || typeof node !== 'object') return;
      if (
        node.type === 'Identifier' &&
        /^[A-Z]/.test(node.name) &&
        !knownGlobals.has(node.name) &&
        !(
          parent?.type === 'MemberExpression' &&
          key === 'property' &&
          !parent.computed
        ) &&
        !(parent?.type === 'Property' && key === 'key')
      )
        needsLocal = true;
      for (const [k, v] of Object.entries(node))
        if (v && typeof v === 'object') {
          if (Array.isArray(v)) v.forEach((n) => scan(n, node, k));
          else scan(v, node, k);
        }
    };
    const collect = (o, inherited = new Map()) => {
      const scope = new Map(inherited);
      for (const c of o.components ?? []) {
        if (scope.has(c.name) && !inherited.has(c.name))
          throw Error('Duplicate inline component ' + c.name);
        scope.set(c.name, c.object);
      }
      doc.inlineScopes.set(o, scope);
      for (const c of o.components ?? []) collect(c.object, scope);
      for (const p of o.properties) if (p.object) collect(p.object, scope);
      for (const child of o.children) collect(child, scope);
    };
    collect(ast.root);
    const inspect = (o) => {
      if (!builtinTypes.has(o.type) && !o.type.includes('.')) needsLocal = true;
      for (const p of o.properties) {
        scan(p.ast);
        if (p.object) inspect(p.object);
      }
      o.children.forEach(inspect);
      for (const c of o.components ?? []) inspect(c.object);
    };
    inspect(ast.root);
    if (hasBase && needsLocal) {
      yield* directory(new URL('.', href).href, null);
      dirs[0].implicit = true;
    }
    const aliases = new Set();
    for (const raw of ast.imports) {
      const imp = parseImport(raw);
      if (imp.alias) {
        if (aliases.has(imp.alias))
          throw Error(`Duplicate QML import alias: ${imp.alias}`);
        aliases.add(imp.alias);
      }
      if (imp.module && builtinModules.has(imp.module)) {
        if (imp.alias) doc.builtins.set(imp.alias, imp.module);
        continue;
      }
      if (imp.path?.endsWith('.js')) {
        if (!imp.alias) throw Error(`JS import needs an alias: ${raw}`);
        const target = new URL(imp.path, href).href;
        yield* script(target);
        doc.values.set(imp.alias, { kind: 'js', url: target });
        continue;
      }
      if (!hasBase)
        throw Error(`Relative imports require a file or HTTP URL: ${raw}`);
      if (imp.path)
        yield* directory(
          new URL(imp.path.replace(/\/?$/, '/'), href).href,
          imp.alias,
          imp.version,
        );
      else {
        const suffix = imp.module.replaceAll('.', '/') + '/';
        const roots = [
          ...new Set([
            new URL('.', href).href,
            new URL('.', url).href,
            ...importRoots,
          ]),
        ];
        let found = false;
        for (const root of roots) {
          const dir = new URL(suffix, root).href;
          if ((yield* read(new URL('qmldir', dir).href, true)) !== null) {
            yield* directory(dir, imp.alias, imp.version, true, imp.module);
            found = true;
            break;
          }
        }
        if (!found)
          throw Error(`QML module not found: ${imp.module} (from ${href})`);
      }
    }
    const props = [],
      objects = [];
    const walk = (o) => {
      objects.push(o);
      props.push(...o.properties);
      for (const p of o.properties) if (p.object) walk(p.object);
      o.children.forEach(walk);
      for (const c of o.components ?? []) walk(c.object);
    };
    walk(ast.root);
    for (const o of objects) {
      const parts = o.type.split('.');
      if (builtinTypes.has(o.type) || doc.inlineScopes.get(o)?.has(o.type))
        continue;
      if (
        parts.length === 2 &&
        doc.builtins.has(parts[0]) &&
        builtinTypes.has(parts[1])
      ) {
        doc.types.set(o.type, { builtin: parts[1] });
        continue;
      }
      const candidates = [];
      for (const d of dirs) {
        const name = d.alias
          ? parts[0] === d.alias && parts.length === 2
            ? parts[1]
            : null
          : parts.length === 1
            ? parts[0]
            : null;
        if (!name) continue;
        const entry = d.entries.get(name);
        if (entry) {
          if (!entry.internal || d.implicit) candidates.push(entry);
          continue;
        }
        const target = new URL(`${name}.qml`, d.dir).href;
        if ((yield* read(target, true)) !== null)
          candidates.push({ url: target, singleton: false });
      }
      const unique = [...new Map(candidates.map((e) => [e.url, e])).values()];
      if (unique.length !== 1)
        throw Error(
          `${unique.length ? 'Ambiguous' : 'Unknown'} QML type ${o.type} in ${href}`,
        );
      const entry = unique[0];
      if (entry.singleton)
        throw Error(`Cannot instantiate singleton ${o.type}`);
      doc.types.set(o.type, entry);
      const child = yield* document(entry.url, null, depth + 1);
      if (child.ast.pragmas.includes('Singleton'))
        throw Error(`Singleton cannot be instantiated: ${entry.url}`);
    }
    const code = props.map((p) => p.code).join('\n');
    for (const d of dirs)
      for (const [name, entry] of d.entries) {
        if (!entry.singleton || (entry.internal && !d.implicit)) continue;
        const key = d.alias ? `${d.alias}.${name}` : name;
        if (!new RegExp(`\\b${key.replaceAll('.', '\\.')}\\b`).test(code))
          continue;
        const old = doc.values.get(key);
        if (old && old.url !== entry.url)
          throw Error(`Ambiguous QML singleton ${key}`);
        doc.values.set(key, { kind: 'singleton', url: entry.url });
        const target = yield* document(entry.url, null, depth + 1);
        if (!target.ast.pragmas.includes('Singleton'))
          throw Error(`qmldir singleton needs pragma Singleton: ${entry.url}`);
      }
    return doc;
  }
  yield* document(url, source);
  return graph;
}

/** One resolver, driven asynchronously for web resources or synchronously for local application components. */
export async function loadQmlGraph(source, url, fetchResource, options = {}) {
  const steps = graphSteps(source, url, null, options);
  let next = steps.next();
  while (!next.done) {
    try {
      next = steps.next(await fetchResource(next.value.href, next.value.kind));
    } catch (error) {
      next = steps.throw(error);
    }
  }
  return next.value;
}
export function loadQmlGraphSync(source, url, fetchResource, options = {}) {
  const steps = graphSteps(source, url, null, options);
  let next = steps.next();
  while (!next.done) {
    try {
      const response = fetchResource(next.value.href, next.value.kind);
      if (response?.then)
        throw Error('Synchronous QML imports require synchronous resources');
      next = steps.next(response);
    } catch (error) {
      next = steps.throw(error);
    }
  }
  return next.value;
}
