import { createQmlCanvas } from './canvas.js';
import { nonvisualTypes, typeProperties, createQt } from './builtins.js';
import { createInertWindow } from '../happy-dom/parser.js';
import { parseQml } from './parser.js';
import { createQmlTextures } from './textures.js';
import { createQmlMedia } from './media.js';
import { createQmlImages } from './images.js';
import { createQmlShapes } from './shapes.js';
import { createQmlText } from './text.js';
import { createQmlModels } from './models.js';
import { createReactive } from './reactive.js';
import { createQmlRuntime } from './runtime.js';
import { builtinTypes, loadQmlGraph } from './loader.js';

const types = builtinTypes;
const defaults = [
  'width',
  'height',
  'implicitWidth',
  'implicitHeight',
  'x',
  'y',
  'color',
  'radius',
  'containmentMask',
  'Layout',
  'Keys',
  'opacity',
  'visible',
  'enabled',
  'clip',
  'text',
  'title',
  'font',
  'border',
  'anchors',
  'horizontalAlignment',
  'textFormat',
  'spacing',
  'placeholderText',
  'readOnly',
  'selectByMouse',
  'Accessible',
  'objectName',
  'activeFocus',
  'focus',
  'activeFocusOnTab',
  'baseline',
  'horizontalCenter',
  'verticalCenter',
  'left',
  'right',
  'top',
  'bottom',
  'childrenRect',
  'children',
  'data',
  'parent',
  'Drag',
  'gradient',
  'scale',
  'rotation',
  'transform',
  'z',
  'baselineOffset',
  'topPadding',
  'bottomPadding',
  'leftPadding',
  'rightPadding',
  'linkColor',
  'hoveredLink',
  'truncated',
  'contentWidth',
  'contentHeight',
  'maximumLineCount',
  'lineCount',
  'renderType',
  'verticalAlignment',
  'wrapMode',
  'elide',
  'lineHeight',
  'lineHeightMode',
  'forceActiveFocus',
  'contains',
  'mapToItem',
  'mapFromItem',
];
const specializedProperties = {
  lineCount: ['Text', 'Label', 'TextEdit'],
  text: ['Text', 'Label', 'TextField', 'TextInput', 'TextEdit', 'Button'],
  font: ['Text', 'Label', 'TextField', 'TextInput', 'TextEdit', 'Button'],
  color: [
    'Text',
    'Label',
    'TextField',
    'TextInput',
    'TextEdit',
    'Button',
    'Rectangle',
    'FloatingWindow',
  ],
  title: ['FloatingWindow'],
  border: ['Rectangle'],
  radius: ['Rectangle'],
  textFormat: ['Text', 'Label', 'TextEdit'],
  placeholderText: ['TextField'],
  readOnly: ['TextField', 'TextInput', 'TextEdit'],
  selectByMouse: ['TextField', 'TextInput', 'TextEdit'],
  horizontalAlignment: [
    'Text',
    'Label',
    'TextField',
    'TextInput',
    'TextEdit',
    'Button',
  ],
};
const itemProperties = (type) =>
  defaults.filter(
    (key) =>
      !specializedProperties[key] || specializedProperties[key].includes(type),
  );
const groups = new Set([
  'Layout.fillWidth',
  'Layout.fillHeight',
  'Layout.minimumWidth',
  'Layout.minimumHeight',
  'Layout.maximumWidth',
  'Layout.maximumHeight',
  'Layout.preferredWidth',
  'Layout.preferredHeight',
  'Layout.alignment',
  'Layout.margins',
  'Layout.leftMargin',
  'Layout.rightMargin',
  'Layout.topMargin',
  'Layout.bottomMargin',
  'Keys.enabled',
  'Keys.forwardTo',
  'font.pixelSize',
  'font.family',
  'font.bold',
  'border.width',
  'border.color',
  'font.capitalization',
  'font.letterSpacing',
  'font.italic',
  'font.features',
  'anchors.fill',
  'anchors.centerIn',
  'anchors.horizontalCenter',
  'anchors.verticalCenter',
  'anchors.left',
  'anchors.right',
  'anchors.baseline',
  'anchors.baselineOffset',
  'anchors.top',
  'anchors.bottom',
  'anchors.margins',
  'anchors.leftMargin',
  'anchors.rightMargin',
  'anchors.topMargin',
  'anchors.bottomMargin',
  'anchors.horizontalCenterOffset',
  'anchors.verticalCenterOffset',
  'Accessible.selected',
  'Accessible.checkable',
  'Accessible.name',
  'Accessible.role',
  'Accessible.checked',
  'Accessible.description',
  'Accessible.focusable',
  'Accessible.focused',
  'Accessible.ignored',
  'xAxis.enabled',
  'xAxis.minimum',
  'xAxis.maximum',
  'yAxis.enabled',
  'yAxis.minimum',
  'yAxis.maximum',
  'sourceSize.width',
  'sourceSize.height',
  'Drag.active',
  'Drag.source',
  'Drag.keys',
  'Drag.mimeData',
  'Drag.supportedActions',
  'Drag.proposedAction',
  'Drag.dragType',
  'Drag.imageSource',
  'Drag.hotSpot.x',
  'Drag.hotSpot.y',
  'origin.x',
  'origin.y',
  'easing.type',
  'easing.amplitude',
  'easing.period',
  'easing.overshoot',
]);

// Rewrite only QML-resolved names; all other identifiers retain page JS meaning.
// Function/block-local names shadow QML properties. No eval in the host process.
function rewriteExpression(property, scope, runtimeRef) {
  const edits = [];
  function walk(node, parent, key, locals = new Set()) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, parent, key, locals);
      return;
    }
    if (
      [
        'FunctionExpression',
        'ArrowFunctionExpression',
        'FunctionDeclaration',
        'BlockStatement',
        'Program',
        'ForStatement',
        'ForInStatement',
        'ForOfStatement',
        'CatchClause',
      ].includes(node.type)
    ) {
      locals = new Set(locals);
      const addPattern = (n) => {
        if (!n) return;
        if (n.type === 'Identifier') locals.add(n.name);
        else if (n.type === 'AssignmentPattern') addPattern(n.left);
        else if (n.type === 'RestElement') addPattern(n.argument);
        else if (n.type === 'ArrayPattern') n.elements.forEach(addPattern);
        else if (n.type === 'ObjectPattern')
          n.properties.forEach((p) =>
            addPattern(p.type === 'RestElement' ? p : p.value),
          );
      };
      const collectVars = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) {
          n.forEach(collectVars);
          return;
        }
        if (
          [
            'FunctionExpression',
            'ArrowFunctionExpression',
            'FunctionDeclaration',
          ].includes(n.type)
        )
          return;
        if (n.type === 'VariableDeclaration' && n.kind === 'var')
          n.declarations.forEach((d) => addPattern(d.id));
        for (const [name, child] of Object.entries(n))
          if (name !== 'type' && child && typeof child === 'object')
            collectVars(child);
      };
      if (
        node.type === 'Program' ||
        node.type.includes('Function') ||
        (node.type === 'BlockStatement' && !parent)
      )
        collectVars(node.body);
      const loop = node.init ?? node.left;
      if (loop?.type === 'VariableDeclaration')
        loop.declarations.forEach((d) => addPattern(d.id));
      if (node.type === 'CatchClause') addPattern(node.param);
      node.params?.forEach(addPattern);
      addPattern(node.id);
      const statements = Array.isArray(node.body)
        ? node.body
        : node.body?.type === 'BlockStatement'
          ? node.body.body
          : [];
      for (const statement of statements) {
        if (statement.type === 'VariableDeclaration')
          statement.declarations.forEach((d) => addPattern(d.id));
        if (statement.type === 'FunctionDeclaration') addPattern(statement.id);
      }
    }
    // Replacing a namespace identifier with a parenthesized object must not
    // turn the following line into a call on the previous expression (ASI).
    if (
      [
        'ExpressionStatement',
        'ReturnStatement',
        'ThrowStatement',
        'BreakStatement',
        'ContinueStatement',
        'VariableDeclaration',
      ].includes(node.type) &&
      !(
        ['ForStatement', 'ForInStatement', 'ForOfStatement'].includes(
          parent?.type,
        ) && ['init', 'left'].includes(key)
      ) &&
      property.code[node.end - 1] !== ';'
    )
      edits.push([node.end, node.end, ';']);
    if (
      node.type === 'BinaryExpression' &&
      node.operator === 'in' &&
      /\bas\b/.test(property.code.slice(node.left.end, node.right.start))
    ) {
      edits.push(
        [node.start, node.start, runtimeRef + '.cast('],
        [node.left.end, node.right.start, ','],
        [
          node.right.start,
          node.right.end,
          JSON.stringify(property.code.slice(node.right.start, node.right.end)),
        ],
        [node.end, node.end, ')'],
      );
      walk(node.left, node, 'left', locals);
      return;
    }
    if (
      node.type === 'MemberExpression' &&
      !node.computed &&
      !node.optional &&
      node.property.name === 'arg' &&
      parent?.type === 'CallExpression' &&
      key === 'callee'
    ) {
      edits.push(
        [node.start, node.start, runtimeRef + '.argFor('],
        [node.object.end, node.end, ')'],
      );
      walk(node.object, node, 'object', locals);
      return;
    }
    if (
      node.type === 'Identifier' &&
      scope.has(node.name) &&
      !locals.has(node.name)
    ) {
      if (
        (parent?.type === 'MemberExpression' &&
          key === 'property' &&
          !parent.computed) ||
        (parent?.type === 'Property' && key === 'key') ||
        (parent?.type === 'VariableDeclarator' && key === 'id')
      )
        return;
      const replacement = scope.get(node.name);
      edits.push([
        node.start,
        node.end,
        parent?.type === 'Property' && parent.shorthand
          ? `${node.name}: ${replacement}`
          : replacement,
      ]);
      return;
    }
    for (const [k, v] of Object.entries(node))
      if (k !== 'type' && v && typeof v === 'object') walk(v, node, k, locals);
  }
  walk(property.ast, null, null);
  let code = property.code;
  for (const [start, end, value] of edits.sort(
    (a, b) => b[0] - a[0] || b[1] - a[1],
  ))
    code = code.slice(0, start) + value + code.slice(end);
  return property.block ? `(()=>${code})()` : code;
}

/** Asynchronous import preparation uses the browser's existing resource bridge. */
export async function loadQmlDocument(source, url, options = {}) {
  try {
    if (options.scripting === false)
      return createQmlDocument(source, url, options);
    const graph = await loadQmlGraph(
      source,
      url,
      options.fetchResource,
      options,
    );
    return createQmlDocument(source, url, { ...options, graph });
  } catch (error) {
    return createQmlDocument(source, url, { ...options, error });
  }
}

/** Build actual DOM nodes. Import ASTs are discarded after compiling the page. */
export function createQmlDocument(
  source,
  url,
  {
    scripting = true,
    graph = null,
    error = null,
    component = false,
    externalSingletons = [],
  } = {},
) {
  const window = createInertWindow(url),
    document = window.document;
  document.body.style.cssText = 'margin:0;overflow:hidden';
  try {
    if (error) throw error;
    if (!scripting)
      throw Error('QML rendering requires page scripting; source shown below.');
    if (!graph) {
      const ast = parseQml(source);
      for (const imp of ast.imports)
        if (
          !/^(QtQuick(?:\.Controls)?|Quickshell)(?:\s+\d+(?:\.\d+)?)?$/.test(
            imp,
          )
        )
          throw Error(`Unsupported QML import: ${imp}`);
      graph = {
        entry: url,
        documents: new Map([
          [
            url,
            {
              url,
              ast,
              types: new Map(),
              values: new Map(),
              builtins: new Map(),
            },
          ],
        ]),
        scripts: new Map(),
      };
    }
    // Generated references must not be captured by application locals such as
    // `for (var r = 0; ...)` inside a binding that reads a shared Theme.
    const applicationCode =
      JSON.stringify([...graph.documents.values()].map((d) => d.ast)) +
      [...graph.scripts.values()].map((s) => s.source).join('\n');
    let generatedPrefix = '$qml$';
    while (applicationCode.includes(generatedPrefix)) generatedPrefix += '$';
    const runtimeRef = generatedPrefix + 'runtime';
    const expression = (property, scope) =>
      rewriteExpression(property, scope, runtimeRef);
    const records = [],
      contexts = [],
      singletons = new Map(),
      scripts = [];
    for (const url of externalSingletons)
      singletons.set(url, {
        external: `${runtimeRef}.shared(${JSON.stringify(url)})`,
      });
    let template = null;
    const constants =
      'const MediaPlayer={NoError:0,ResourceError:1,NetworkError:2,FormatError:3,AccessDeniedError:4,StoppedState:0,PlayingState:1,PausedState:2,NoMedia:0,LoadingMedia:1,LoadedMedia:2,StalledMedia:3,BufferingMedia:4,BufferedMedia:5,EndOfMedia:6,InvalidMedia:7,Infinite:-1};const VideoOutput={Stretch:0,PreserveAspectFit:1,PreserveAspectCrop:2};const XmlListModel={Null:0,Ready:1,Loading:2,Error:3};const LoggingCategory={Debug:0,Info:4,Warning:1,Critical:2,Fatal:3};const Flow={LeftToRight:0,TopToBottom:1};const ListView={Beginning:0,Center:1,End:2,Visible:3,Contain:4,SnapPosition:5,Vertical:2,Horizontal:1,NoHighlightRange:0};const GridView={...ListView,FlowLeftToRight:0,FlowTopToBottom:1};const Binding={RestoreNone:0,RestoreBinding:1,RestoreValue:2,RestoreBindingOrValue:3};const Gradient={Vertical:0,Horizontal:1};const PointerHandler={CanTakeOverFromAnything:31,ApprovesTakeOverByAnything:511,TakeOverForbidden:0};const Drag={None:0,Automatic:1,Internal:2};const Application={styleHints:{wheelScrollLines:3,mouseDoubleClickInterval:400}};const Flickable={AutoFlickDirection:0,HorizontalFlick:1,VerticalFlick:2,HorizontalAndVerticalFlick:3,StopAtBounds:0,DragOverBounds:1,OvershootBounds:2,DragAndOvershootBounds:3};const Image={Null:0,Ready:1,Loading:2,Error:3,Stretch:0,PreserveAspectFit:1,PreserveAspectCrop:2,Tile:3,Pad:6};const TextInput={AlignLeft:1,AlignRight:2,AlignHCenter:4,AlignTop:32,AlignBottom:64,AlignVCenter:128,Normal:0,Password:2,NoEcho:1,PasswordEchoOnEdit:3,NativeRendering:1};const TextEdit=TextInput;const Text={AlignLeft:1,AlignRight:2,AlignHCenter:4,AlignTop:32,AlignBottom:64,AlignVCenter:128,PlainText:0,RichText:1,AutoText:2,StyledText:3,MarkdownText:4,NoWrap:0,WordWrap:1,WrapAnywhere:2,Wrap:3,WrapAtWordBoundaryOrAnywhere:3,ElideNone:0,ElideLeft:1,ElideRight:2,ElideMiddle:3,ProportionalHeight:0,FixedHeight:1};const Font={MixedCase:0,AllUppercase:1,AllLowercase:2,SmallCaps:3,Capitalize:4};const Accessible={Button:43,CheckBox:44};const Shape={CurveRenderer:1};const ShapePath={SquareCap:16,FlatCap:0,RoundCap:32,MiterJoin:0,BevelJoin:64,RoundJoin:128,DashLine:2,WindingFill:1,OddEvenFill:0};const Easing={Linear:0,InQuad:1,OutQuad:2,InOutQuad:3,InCubic:5,OutCubic:6,InOutCubic:7,OutQuart:10,OutQuint:14,OutSine:18,OutExpo:22,OutBack:34};const Animation={Infinite:-1};const Component={Null:0,Ready:1,Loading:2,Error:3};const Loader=Component;const TapHandler={ReleaseWithinBounds:1};const Qt=r.Qt,Quickshell=r.Quickshell,Hyprland=r.Hyprland,FileViewError={FileNotFound:"ENOENT"};';
    const ref = (record) =>
      record.external ?? `${generatedPrefix}n${record.index}`;
    function context(
      doc,
      parent = null,
      chain = [],
      singletonUrl = null,
      inline = null,
      outer = null,
    ) {
      const ctx = {
        doc,
        ids: new Map(),
        values: new Map(),
        index: contexts.length,
        root: null,
        singletonUrl,
        template,
        outer,
      };
      contexts.push(ctx);
      build(inline ?? doc.ast.root, parent, ctx, chain);
      if (singletonUrl) singletons.set(singletonUrl, ctx.root);
      for (const [name, value] of doc.values) {
        if (value.kind === 'singleton') {
          if (!singletons.has(value.url)) {
            const savedTemplate = template;
            template = null;
            const child = context(
              graph.documents.get(value.url),
              null,
              [],
              value.url,
            );
            template = savedTemplate;
            const record = child.root;
            record.element.style.display = 'none';
            record.nonvisual = true;
            singletons.set(value.url, record);
          }
          ctx.values.set(name, ref(singletons.get(value.url)));
        } else ctx.values.set(name, script(value.url, ctx));
      }
      for (const alias of doc.builtins.keys())
        ctx.values.set(`${alias}.Text`, 'Text');
      return ctx;
    }
    const libraryScripts = new Map();
    function script(href, ctx, chain = [], libraryParent = false) {
      if (chain.includes(href)) throw Error(`Cyclic JS import: ${href}`);
      const item = graph.scripts.get(href);
      if (!item) throw Error(`Missing JS resource ${href}`);
      const library = item.library || libraryParent;
      const cache = library ? libraryScripts : (ctx.scriptCache ??= new Map());
      if (cache.has(href)) return cache.get(href);
      const deps = item.deps
        .map(
          (d) =>
            `const ${d.alias}=${script(d.url, ctx, [...chain, href], library)};`,
        )
        .join('\n');
      const name = `${generatedPrefix}j${scripts.length}`;
      scripts.push({ name, deps, item, ctx, library, href });
      cache.set(href, name);
      return name;
    }
    function addProperties(record, object, ctx) {
      for (const p of object.properties) {
        if (p.key === 'id') {
          if (!/^[A-Za-z_][\w]*$/.test(p.code) || ctx.ids.has(p.code))
            throw Error(`Invalid or duplicate QML id: ${p.code}`);
          ctx.ids.set(p.code, ref(record));
          record.element.id =
            ctx.index === 0 && !template
              ? p.code
              : `qml-${ctx.index}-${p.code}`;
          continue;
        }
        if (['__proto__', 'constructor', 'prototype'].includes(p.key))
          throw Error(`Invalid QML property: ${p.key}`);
        if (p.custom || p.method || p.signal) {
          if (
            p.custom &&
            ![
              'int',
              'real',
              'bool',
              'string',
              'var',
              'color',
              'alias',
              'double',
              'url',
              'point',
              'size',
              'rect',
            ].includes(p.propertyType) &&
            !/^[A-Z]/.test(p.propertyType)
          )
            throw Error(`Unsupported QML property type: ${p.propertyType}`);
          if (
            record.properties.has(p.key) &&
            record.properties.get(p.key).p.custom
          )
            throw Error(`Duplicate QML property: ${p.key}`);
          record.names.add(p.key);
        } else if (
          !record.names.has(p.key) &&
          !groups.has(p.key) &&
          !/^(?:Keys\.|Accessible\.|Drag\.|ListView\.|GridView\.)?on[A-Z_]/.test(
            p.key,
          ) &&
          !['Component.onCompleted', 'Component.onDestruction'].includes(p.key)
        )
          throw Error(
            `Unsupported QML property: ${record.type}.${p.key} (${ctx.doc.url})`,
          );
        if (p.propertyType === 'alias') record.aliases.set(p.key, { p, ctx });
        const previous = record.properties.get(p.key);
        // Each component layer connects its own signal handler. Overriding a
        // property binding must not discard the base component's connections.
        if (previous && !p.method && !p.signal &&
            (/^(?:Keys\.|Accessible\.|Drag\.|ListView\.|GridView\.)?on[A-Z_]/.test(p.key) ||
             ['Component.onCompleted', 'Component.onDestruction'].includes(p.key)))
          (record.inheritedHandlers ??= []).push(previous);
        if (previous?.p.readonly && !p.custom)
          throw Error(`Cannot override readonly QML property: ${p.key}`);
        record.properties.set(p.key, {
          p:
            record.aliases.has(p.key) && p.propertyType !== 'alias'
              ? { ...p, aliasOverride: true }
              : previous?.p.custom && !p.custom
                ? {
                    ...p,
                    custom: true,
                    propertyType: previous.p.propertyType,
                    defaultProperty: previous.p.defaultProperty,
                  }
                : p,
          ctx,
        });
      }
    }
    function aliasSlot(record, key, seen = new Set()) {
      const token = record.index + ':' + key;
      if (seen.has(token)) throw Error('Cyclic property alias');
      seen.add(token);
      const entry = record.aliases.get(key);
      if (!entry) return null;
      const { p, ctx } = entry,
        ast = p.ast;
      if (
        ast.type !== 'MemberExpression' ||
        ast.object.type !== 'Identifier' ||
        ast.computed
      )
        return null;
      const target = records.find(
        (r) => ref(r) === ctx.ids.get(ast.object.name),
      );
      if (!target) return null;
      if (['data', 'children'].includes(ast.property.name)) return target;
      return aliasSlot(target, ast.property.name, seen);
    }
    function defaultSlot(record) {
      const entry = [...record.aliases.values()].find(
        ({ p }) => p.defaultProperty,
      );
      if (!entry) return record;
      const target = aliasSlot(record, entry.p.key);
      if (!target)
        throw Error('Default property must reference a child collection');
      return target;
    }
    function buildPropertyObject(p, record, ctx, chain) {
      const slot = aliasSlot(record, p.key);
      const child = build(
        p.key === 'sourceComponent' && p.object.type !== 'Component'
          ? { type: 'Component', properties: [], children: [p.object] }
          : p.object,
        slot ?? record,
        ctx,
        chain,
      );
      record.properties.set(p.key, {
        p: {
          ...record.properties.get(p.key).p,
          reference: child,
          collectionSlot: !!slot,
        },
        ctx,
      });
    }
    function build(object, parent, ctx, chain) {
      const inline = ctx.doc.inlineScopes?.get(object)?.get(object.type);
      const resolution = inline
        ? { url: ctx.doc.url + '#inline-' + object.type }
        : ctx.doc.types.get(object.type);
      if (resolution?.url) {
        if (chain.includes(resolution.url) || chain.length > 48)
          throw Error(
            `Recursive QML component: ${[...chain, resolution.url].join(' -> ')}`,
          );
        const inner = context(
          inline ? ctx.doc : graph.documents.get(resolution.url),
          parent,
          [...chain, resolution.url],
          null,
          inline,
          inline ? ctx : null,
        );
        const record = inner.root;
        record.tags.add(object.type.split('.').at(-1));
        if (!ctx.root) ctx.root = record;
        addProperties(record, object, ctx);
        for (const p of object.properties)
          if (
            p.object &&
            !(
              ['Repeater', 'ListView', 'GridView'].includes(record.type) &&
              p.key === 'delegate'
            )
          )
            buildPropertyObject(p, record, ctx, chain);
        const slot = defaultSlot(record);
        for (const child of object.children) build(child, slot, ctx, chain);
        return record;
      }
      const type = resolution?.builtin ?? object.type;
      if (!types.has(type)) throw Error(`Unsupported QML type: ${object.type}`);
      if (records.length >= 2000) throw Error('QML expanded object limit');
      const svgTag = { ShapePath: 'g', PathSvg: 'path', PathRectangle: 'rect' }[
        type
      ];
      const element = svgTag
        ? document.createElementNS('http://www.w3.org/2000/svg', svgTag)
        : document.createElement(
            ['TextField', 'TextInput'].includes(type)
              ? 'input'
              : type === 'TextEdit'
                ? 'textarea'
                : type === 'Image'
                  ? 'div'
                  : type === 'Button'
                    ? 'button'
                    : 'div',
          );
      const record = {
        index: records.length,
        type,
        parent,
        ctx,
        element,
        template,
        bindingTarget: object.bindingTarget,
        tags: new Set([
          type,
          ...(!nonvisualTypes.has(type) ? ['Item'] : []),
          'QtObject',
        ]),
        names: new Set([
          'objectName',
          ...(nonvisualTypes.has(type) ? [] : itemProperties(type)),
          ...(typeProperties[type] ?? []),
        ]),
        properties: new Map(),
        aliases: new Map(),
        nonvisual: nonvisualTypes.has(type),
      };
      records.push(record);
      if (!ctx.root) {
        ctx.root = record;
        if (ctx.singletonUrl) singletons.set(ctx.singletonUrl, record);
      }
      if (record.nonvisual)
        element.style.display = type === 'ShellRoot' ? 'contents' : 'none';
      element.setAttribute('data-qml-node', String(record.index));
      element.setAttribute('data-qml-type', type);
      if (type === 'TextField') element.setAttribute('type', 'text');
      if (type === 'Button') element.setAttribute('type', 'button');
      (parent?.element ?? document.body).appendChild(element);
      addProperties(record, object, ctx);
      if (['Repeater', 'ListView', 'GridView', 'Component'].includes(type)) {
        const delegate =
          type === 'Component'
            ? object.children[0]
            : (record.properties.get('delegate')?.p.object ??
              (type === 'Repeater' ? object.children[0] : null));
        if (!delegate) throw Error(type + ' requires an object delegate');
        if (type === 'Component' && object.children.length !== 1)
          throw Error('Component requires exactly one root');
        record.properties.delete('delegate');
        const outer = template;
        const group = {
          owner: record,
          outer,
          root: null,
          kind:
            type === 'Component'
              ? 'component'
              : type === 'Repeater'
                ? 'repeater'
                : 'view',
        };
        template = group;
        const delegateContext = {
          ...ctx,
          ids: new Map(),
          outer: ctx,
          template: group,
        };
        // Delegate IDs are local to each factory invocation; outer IDs remain visible.
        for (const p of delegate.properties)
          if (p.key === 'id') delegateContext.ids.delete(p.code);
        group.root = build(
          delegate,
          ['ListView', 'GridView'].includes(type) ? record : parent,
          delegateContext,
          chain,
        );
        group.root.element.remove();
        group.root.names.add('index');
        group.root.names.add('modelData');
        record.delegate = group;
        template = outer;
      }
      for (const p of object.properties)
        if (
          p.object &&
          !(
            ['Repeater', 'ListView', 'GridView'].includes(record.type) &&
            p.key === 'delegate'
          )
        )
          buildPropertyObject(p, record, ctx, chain);
      if (
        type !== 'Component' &&
        !(
          type === 'Repeater' &&
          !object.properties.some((p) => p.key === 'delegate')
        )
      )
        for (const child of object.children) build(child, record, ctx, chain);
      return record;
    }
    let entryContext;
    entryContext = context(graph.documents.get(graph.entry), null, [
      graph.entry,
    ]);
    for (const record of records)
      for (const { p } of record.properties.values())
        if (
          p.required &&
          !(component && record === entryContext.root) &&
          !(
            record.template?.kind === 'component' &&
            record.template.root === record
          ) &&
          !(
            record.template?.root === record &&
            ['index', 'modelData'].includes(p.key)
          )
        )
          throw Error(`Missing required QML property: ${p.key}`);
    // Local createComponent factories already belong to a running QML page.
    // Do not parse a second copy of the entire runtime for every lazy pane.
    const runtimeSource = component
      ? 'globalThis.__qmlRuntime'
      : `globalThis.__qmlRuntime??=(${createQmlRuntime.toString()})((${createReactive.toString()})(),(${createQt.toString()})(),(${createQmlModels.toString()}),(${createQmlText.toString()}),(${createQmlShapes.toString()}),(${createQmlImages.toString()}),(${createQmlTextures.toString()}),(${createQmlMedia.toString()}),(${createQmlCanvas.toString()}))`;
    const code = [
      `(()=>{const r=${runtimeSource};if(!r)throw Error('QML component requires an initialized page');const ${runtimeRef}=r;`,
      constants,
    ];

    function scopeFor(record, ctx) {
      const scope = new Map();
      const namespaces = new Map();
      for (const [name, value] of ctx.values) {
        const parts = name.split('.');
        if (parts.length === 1) scope.set(name, value);
        else {
          if (!namespaces.has(parts[0])) namespaces.set(parts[0], []);
          namespaces
            .get(parts[0])
            .push(`[${JSON.stringify(parts[1])}]:${value}`);
        }
      }
      for (const [name, parts] of namespaces)
        scope.set(name, `({${parts.join(',')}})`);
      const idScopes = [];
      for (let c = ctx; c; c = c.outer) idScopes.unshift(c);
      for (const c of idScopes)
        for (const [name, value] of c.ids) scope.set(name, value);
      // A local component instance can acquire properties at its use site;
      // children declared there must resolve those enclosing properties too.
      const ancestors = [];
      for (let p = record; p; p = p.parent)
        if (p.ctx === ctx || p === record ||
            [...p.properties.values()].some(entry => entry.ctx === ctx)) ancestors.unshift(p);
      if (!ancestors.includes(ctx.root)) ancestors.unshift(ctx.root);
      for (const p of ancestors)
        for (const key of p.names) scope.set(key, `${ref(p)}.${key}`);
      // Component IDs win over same-named properties (e.g. a caption string and caption Text).
      for (const c of idScopes)
        for (const [name, value] of c.ids) scope.set(name, value);
      scope.set(
        'parent',
        record.parent || record.template || component
          ? `${ref(record)}.parent`
          : runtimeRef + '.viewport',
      );
      for (const name of ['ListView', 'GridView'])
        scope.set(name, `({...${name},view:${ref(record)}.${name}.view})`);
      scope.set('console', runtimeRef + '.console');
      scope.set('Qt', `${runtimeRef}.qt(${JSON.stringify(ctx.doc.url)})`);
      return scope;
    }
    const scriptCode = new Map();
    for (const { name, deps, item, ctx, library, href } of scripts) {
      const scope = library ? new Map() : scopeFor(ctx.root, ctx);
      // Library scripts have no component IDs, but still receive Qt services.
      scope.set('Qt', `${runtimeRef}.qt(${JSON.stringify(href)})`);
      scope.set('console', runtimeRef + '.console');
      for (const dep of item.deps) scope.delete(dep.alias);
      const body = expression(
        { code: item.source, ast: item.ast, block: false },
        scope,
      );
      const scriptGroup = library ? null : ctx.template;
      if (!scriptCode.has(scriptGroup)) scriptCode.set(scriptGroup, []);
      scriptCode
        .get(scriptGroup)
        .push(
          `const ${name}=(()=>{${deps}\n${body}\nreturn Object.defineProperties({}, {${item.exports.map((e) => `[${JSON.stringify(e.name)}]:{enumerable:true,get:()=>${e.name}${e.writable ? `,set:v=>{${e.name}=v;}` : ''}}`).join(',')}});})();`,
        );
    }
    function generate(group) {
      const members = records.filter((record) => record.template === group);
      for (const record of members) {
        if (
          group &&
          ![
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
            'Behavior',
            'NumberAnimation',
            'PropertyAnimation',
            'PauseAnimation',
            'SequentialAnimation',
            'ParallelAnimation',
            'ScriptAction',
            'PropertyAction',
            'Timer',
            'Connections',
            'Socket',
            'Process',
            'StdioCollector',
            'SplitParser',
            'FileView',
            'TextMetrics',
            'FontMetrics',
            'QtObject',
            'Item',
            'Rectangle',
            'Text',
            'Label',
            'TextField',
            'Button',
            'MouseArea',
            'Column',
            'Row',
            'Grid',
            'Shape',
            'ShapePath',
            'PathSvg',
            'Scale',
            'Translate',
            'FocusScope',
            'Loader',
            'Component',
            'Repeater',
            'TapHandler',
            'HoverHandler',
          ].includes(record.type)
        )
          throw Error(
            'Unsupported service inside Repeater delegate: ' + record.type,
          );
        let persistent = false;
        for (let a = record; a; a = a.parent)
          if (a.ctx.singletonUrl) persistent = true;
        const parent =
          group?.kind === 'component' && record === group.root
            ? 'mount'
            : record.parent
              ? ref(record.parent)
              : component && record === entryContext.root
                ? 'mount'
                : 'null';
        if (group || component)
          code.push(
            `const ${ref(record)}=r.create(${JSON.stringify(record.type)},${record.index},${parent},${record === group?.root && group.kind === 'repeater' ? ref(group.owner) : 'null'},${persistent});`,
          );
        else
          code.push(
            `const ${ref(record)}=r.make(document.querySelector('[data-qml-node="${record.index}"]'),${JSON.stringify(record.type)},${parent});`,
          );
      }
      for (const record of members)
        for (const { p } of record.properties.values())
          if (p.custom && p.propertyType !== 'alias') {
            const initial = ['int', 'real', 'double'].includes(p.propertyType)
              ? '0'
              : p.propertyType === 'bool'
                ? 'false'
                : ['string', 'url'].includes(p.propertyType)
                  ? '""'
                  : p.propertyType === 'color'
                    ? '"transparent"'
                    : p.propertyType === 'var'
                      ? 'undefined'
                      : 'null';
            code.push(`${ref(record)}[${JSON.stringify(p.key)}]=${initial};`);
          }
      for (const record of members)
        code.push(
          `r.describe(${ref(record)},${JSON.stringify([...record.tags])},${JSON.stringify([...record.properties.keys()])},${JSON.stringify(record.ctx.doc.url)},${JSON.stringify([...record.properties.values()].filter(({ p }) => p.readonly).map(({ p }) => p.key))});`,
        );
      for (const record of members)
        if (record.type === 'Behavior') {
          const animation = members.find((child) => child.parent === record);
          if (!record.parent || !record.bindingTarget || !animation)
            throw Error('Behavior needs a target property and animation');
          code.push(
            `r.behavior(${ref(record.parent)},${JSON.stringify(record.bindingTarget)},${ref(record)},${ref(animation)});`,
          );
        }
      if (!group)
        for (const [url, record] of singletons)
          if (!record.external)
            code.push(`r.share(${JSON.stringify(url)},${ref(record)});`);
      code.push(...(scriptCode.get(group) ?? []));
      if (group && group.kind !== 'component')
        code.push(
          `${ref(group.root)}.index=index;${ref(group.root)}.modelData=modelData;r.attachDelegate(${ref(group.root)},index,${ref(group.owner)});`,
        );
      for (const record of members)
        if (record.delegate) {
          code.push(
            record.delegate.kind === 'component'
              ? `r.component(${ref(record)},(mount,properties={})=>{`
              : `r.delegate(${ref(record)},(index,modelData)=>{`,
          );
          generate(record.delegate);
          code.push(`return ${ref(record.delegate.root)};});`);
        }
      // Methods/aliases exist before any property bindings read them.
      for (const record of members)
        for (const { p, ctx } of record.properties.values()) {
          const scope = scopeFor(record, ctx);
          if (p.signal) code.push(`${ref(record)}.${p.key}=r.signal();`);
          if (p.reference && !p.collectionSlot && !p.aliasOverride)
            code.push(`${ref(record)}.${p.key}=${ref(p.reference)};`);
          if (p.method) {
            const expr = expression(p, scope);
            if (
              record.type === 'Connections' &&
              /^(?:Keys\.|Accessible\.|Drag\.|ListView\.|GridView\.)?on[A-Z_]/.test(
                p.key,
              )
            )
              code.push(
                `r.on(${ref(record)},${JSON.stringify(p.key)},(${expr}));`,
              );
            else code.push(`${ref(record)}.${p.key}=(${expr});`);
          }
        }
      for (const record of members)
        for (const { p, ctx } of record.aliases.values()) {
          const scope = scopeFor(record, ctx);
          if (p.propertyType === 'alias') {
            if (!['Identifier', 'MemberExpression'].includes(p.ast.type))
              throw Error(`Invalid QML alias ${p.key}`);
            const aliasScope = new Map(scope);
            for (let c = ctx; c; c = c.outer)
              for (const [name, id] of c.ids)
                if (!aliasScope.has(name) || ctx.ids.has(name))
                  aliasScope.set(name, id);
            const value = expression(p, aliasScope);
            code.push(
              `r.alias(${ref(record)},${JSON.stringify(p.key)},()=>(${value}),v=>{${value}=v;},${!!p.readonly});`,
            );
          }
        }
      const completed = [];
      for (const record of members) {
        const n = ref(record),
          override =
            (component && record === entryContext.root) ||
            (group?.kind === 'component' && record === group.root);
        for (const dimension of ['width', 'height'])
          if (!record.nonvisual && !record.properties.has(dimension)) {
            const implicit =
              dimension === 'width' ? 'implicitWidth' : 'implicitHeight';
            code.push(
              `${override ? `if(!Object.hasOwn(properties,'${dimension}')) ` : ''}r.bind(${n},'${dimension}',()=>r.dimension(${n},${JSON.stringify(dimension)},${!record.parent || record.type === 'FloatingWindow'}));`,
            );
          }
        for (const axis of ['x', 'y'])
          if (!record.properties.has(axis) && !record.nonvisual)
            code.push(
              `${override ? `if(!Object.hasOwn(properties,'${axis}')) ` : ''}r.bind(${n},'${axis}',()=>r.position(${n},'${axis}'));`,
            );
        for (const { p, ctx } of [...(record.inheritedHandlers ?? []), ...record.properties.values()]) {
          if (p.method || p.signal || p.propertyType === 'alias' || p.required)
            continue;
          if (p.collectionSlot) continue;
          if (p.reference) {
            code.push(
              `r.${p.aliasOverride ? 'bindAlias' : 'bind'}(${n},${JSON.stringify(p.key)},()=>${ref(p.reference)},${!!p.readonly});`,
            );
            continue;
          }
          const value = expression(p, scopeFor(record, ctx));
          if (p.aliasOverride) {
            code.push(
              `r.bindAlias(${n},${JSON.stringify(p.key)},()=>(${value}));`,
            );
            continue;
          }
          if (record.type === 'ScriptAction' && p.key === 'script') {
            code.push(`r.on(${n},'script',()=>{${value};});`);
            continue;
          }
          if (p.key === 'Component.onDestruction') {
            code.push(`r.on(${n},'Component.onDestruction',()=>{${value};});`);
            continue;
          }
          if (p.key === 'Component.onCompleted') {
            completed.push(`${value};`);
            continue;
          }
          if (
            /^(?:Keys\.|Accessible\.|Drag\.|ListView\.|GridView\.)?on[A-Z_]/.test(
              p.key,
            ) &&
            p.key !== 'onClicked'
          ) {
            const handler = [
              'FunctionExpression',
              'ArrowFunctionExpression',
            ].includes(p.ast?.type)
              ? value
              : `function(event,button){const mouse=event,wheel=event;${value};}`;
            code.push(`r.on(${n},${JSON.stringify(p.key)},${handler});`);
            continue;
          }
          if (p.key === 'onClicked') {
            const handler = [
              'FunctionExpression',
              'ArrowFunctionExpression',
            ].includes(p.ast?.type)
              ? value
              : `function(event){const mouse=event;${value};}`;
            code.push(`r.on(${n},'onClicked',${handler});`);
            continue;
          }
          const parts = p.key.split('.'),
            key = parts.pop(),
            target = n + (parts.length ? '.' + parts.join('.') : '');
          code.push(
            `${override ? `if(!Object.hasOwn(properties,${JSON.stringify(p.key)})) ` : ''}r.bind(${target},${JSON.stringify(key)},()=>(${value}),${!!p.readonly},${JSON.stringify(p.propertyType)});`,
          );
        }
        // Nonvisual DOM nodes are already hidden. Their QML visible property
        // may be an application-defined readonly value; never overwrite it.
      }
      if ((component && !group) || group?.kind === 'component') {
        const root = group?.root ?? entryContext.root;
        for (const { p } of root.properties.values())
          if (p.required)
            code.push(
              `if(!Object.hasOwn(properties,${JSON.stringify(p.key)}))throw Error('Missing required QML property: '+${JSON.stringify(p.key)});`,
            );
        code.push(`r.apply(${ref(root)},properties);`);
      }
      code.push('r.start();', ...completed);
    }
    generate(null);
    code.push(`return ${ref(entryContext.root)};})();`);
    const scriptElement = document.createElement('script');
    scriptElement.textContent = code.join('\n');
    document.body.appendChild(scriptElement);
  } catch (error) {
    document.body.replaceChildren();
    document.body.style.cssText = 'margin:16px';
    const heading = document.createElement('h1');
    heading.textContent = 'QML experiment';
    const message = document.createElement('p');
    message.textContent = String(error.message);
    const pre = document.createElement('pre');
    pre.textContent = source;
    document.body.append(heading, message, pre);
  }
  return { window, document };
}
