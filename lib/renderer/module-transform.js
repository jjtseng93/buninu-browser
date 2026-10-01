/**
 * Turns an ES module into an async function a page compartment can run.
 *
 * The result evaluates to
 *
 *   (async function (__buninu_module__) { … })
 *
 * and runs in two phases so cyclic graphs can see each other's exports:
 *
 *   1. up to `await __buninu_module__.linked`, the module defines its export
 *      getters (live: they read the module's own bindings, so later
 *      assignments are visible, and uninitialised let/const still throw) and
 *      copies `export *` names;
 *   2. after the loader resolves `linked`, the module body runs.
 *
 * Imported bindings are live: every reference to an imported name that is
 * not shadowed by a local declaration is rewritten to a read of the
 * dependency's namespace, so values assigned later (and cycles) behave as in
 * ESM. `import.meta` and `import()` are rewritten to loader calls. Parsing
 * uses Acorn.
 */
import { Parser } from "../../vendor/acorn/dist/acorn.mjs";
import { boundNames } from "./script-rewrite.js";

const MODULE = "__buninu_module__";

/**
 * @param {string} source module text
 * @returns {{ code: string, requests: { specifier: string, type: string | null }[] }}
 */
export function transformModule(source) {
  const program = Parser.parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const requests = [];
  const requestIndex = new Map();
  const request = (node) => {
    const specifier = String(node.source.value);
    const type = importType(node);
    const key = `${type ?? ""}\n${specifier}`;
    if (!requestIndex.has(key)) {
      requestIndex.set(key, requests.length);
      requests.push({ specifier, type });
    }
    return requestIndex.get(key);
  };

  const edits = [];
  const getters = [];
  const starExports = [];
  // Imported locals re-exported with `export { a }` read the dependency's
  // namespace directly, so they work before the body has run.
  const importExpressions = new Map();
  const namespace = (index) => `${MODULE}.namespaces[${index}]`;
  const getter = (exported, expression) => getters.push(
    `Object.defineProperty(${MODULE}.exports, ${JSON.stringify(exported)}, `
    + `{ enumerable: true, configurable: true, get: () => ${expression} });`,
  );
  const exportedName = (node) => node.type === "Literal" ? String(node.value) : node.name;

  for (const node of program.body) {
    switch (node.type) {
      case "ImportDeclaration": {
        const index = request(node);
        for (const specifier of node.specifiers) {
          const local = specifier.local.name;
          const expression = specifier.type === "ImportDefaultSpecifier" ? `${namespace(index)}.default`
            : specifier.type === "ImportNamespaceSpecifier" ? namespace(index)
              : `${namespace(index)}[${JSON.stringify(exportedName(specifier.imported))}]`;
          importExpressions.set(local, expression);
        }
        edits.push({ start: node.start, end: node.end, text: "" });
        break;
      }
      case "ExportNamedDeclaration": {
        if (node.declaration) {
          // `export const a = 1` -> `const a = 1` plus a getter per bound name.
          edits.push({ start: node.start, end: node.declaration.start, text: "" });
          const declaration = node.declaration;
          const names = declaration.type === "VariableDeclaration"
            ? declaration.declarations.flatMap((declarator) => boundNames(declarator.id))
            : [declaration.id.name];
          for (const name of names) getter(name, name);
        } else if (node.source) {
          const index = request(node);
          for (const specifier of node.specifiers) {
            getter(exportedName(specifier.exported), `${namespace(index)}[${JSON.stringify(exportedName(specifier.local))}]`);
          }
          edits.push({ start: node.start, end: node.end, text: "" });
        } else {
          for (const specifier of node.specifiers) {
            const local = specifier.local.name;
            getter(exportedName(specifier.exported), importExpressions.get(local) ?? local);
          }
          edits.push({ start: node.start, end: node.end, text: "" });
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const declaration = node.declaration;
        const named = (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id;
        if (named) {
          edits.push({ start: node.start, end: declaration.start, text: "" });
          getter("default", declaration.id.name);
        } else {
          // Prefix and suffix edits only, so edits inside the expression
          // (import.meta, import()) never overlap this one.
          const local = `${MODULE}_default`;
          edits.push({ start: node.start, end: declaration.start, text: `const ${local} = (` });
          edits.push({ start: declaration.end, end: declaration.end, text: ");" });
          getter("default", local);
        }
        break;
      }
      case "ExportAllDeclaration": {
        const index = request(node);
        if (node.exported) getter(exportedName(node.exported), namespace(index));
        else starExports.push(index);
        edits.push({ start: node.start, end: node.end, text: "" });
        break;
      }
      default:
        break;
    }
  }

  rewriteImportReferences(program, importExpressions, edits);

  // import.meta and import() can appear anywhere in the module; most
  // modules have neither, and then the extra walk is skipped.
  if (/\bimport\s*[.(]/.test(source)) walk(program, (node) => {
    if (node.type === "MetaProperty" && node.meta.name === "import") {
      edits.push({ start: node.start, end: node.end, text: `${MODULE}.meta` });
    } else if (node.type === "ImportExpression") {
      // Replace only `import(`; the arguments keep their own edits.
      edits.push({ start: node.start, end: node.source.start, text: `${MODULE}.importDynamic(` });
    }
    return true;
  });

  // Applied in one pass: re-slicing the whole source per edit was quadratic.
  edits.sort((left, right) => left.start - right.start);
  const offset = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
  const pieces = [];
  let cursor = offset;
  for (const edit of edits) {
    pieces.push(source.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  pieces.push(source.slice(cursor));
  const body = pieces.join("");
  const stars = starExports.map((index) => `${MODULE}.exportStar(${namespace(index)});`).join("\n");
  const code = `(async function (${MODULE}) {
"use strict";
${getters.join("\n")}
${stars}
await ${MODULE}.linked;
${body}
})`;
  return { code, requests };
}

/**
 * Rewrites references to imported names into namespace reads. A scope stack
 * tracks declarations so shadowed names (parameters, locals, catch
 * parameters, block bindings) are left alone.
 */
function rewriteImportReferences(program, imports, edits) {
  if (!imports.size) return;
  const scopes = [];
  const isImport = (name) => imports.has(name) && !scopes.some((scope) => scope.has(name));
  const reference = (node) => {
    if (isImport(node.name)) edits.push({ start: node.start, end: node.end, text: imports.get(node.name) });
  };
  const withScope = (names, fn) => {
    scopes.push(names);
    try {
      fn();
    } finally {
      scopes.pop();
    }
  };

  /** Declaration patterns: only default values and computed keys are expressions. */
  const pattern = (node) => {
    if (!node) return;
    switch (node.type) {
      case "Identifier": return;
      case "ObjectPattern":
        for (const property of node.properties) {
          if (property.type === "RestElement") pattern(property.argument);
          else {
            if (property.computed) expression(property.key);
            pattern(property.value);
          }
        }
        return;
      case "ArrayPattern":
        for (const element of node.elements) pattern(element);
        return;
      case "AssignmentPattern":
        pattern(node.left);
        expression(node.right);
        return;
      case "RestElement":
        pattern(node.argument);
        return;
      default:
        expression(node);
    }
  };

  const functionNode = (node) => {
    const names = new Set();
    if (node.type === "FunctionExpression" && node.id) names.add(node.id.name);
    for (const parameter of node.params) for (const name of boundNames(parameter)) names.add(name);
    if (node.body.type === "BlockStatement") {
      collectVarNames(node.body, names);
      for (const name of lexicalNames(node.body.body)) names.add(name);
    }
    withScope(names, () => {
      for (const parameter of node.params) pattern(parameter);
      if (node.body.type === "BlockStatement") for (const statement of node.body.body) expression(statement);
      else expression(node.body);
    });
  };

  const classNode = (node) => {
    const names = new Set(node.type === "ClassExpression" && node.id ? [node.id.name] : []);
    if (node.superClass) expression(node.superClass);
    withScope(names, () => {
      for (const member of node.body.body) {
        if (member.type === "StaticBlock") {
          withScope(new Set(lexicalNames(member.body)), () => member.body.forEach(expression));
          continue;
        }
        if (member.computed) expression(member.key);
        if (member.value) expression(member.value);
      }
    });
  };

  function expression(node) {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "Identifier": reference(node); return;
      case "ImportDeclaration":
      case "MetaProperty":
      case "BreakStatement":
      case "ContinueStatement":
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        functionNode(node);
        return;
      case "ClassDeclaration":
      case "ClassExpression":
        classNode(node);
        return;
      case "VariableDeclaration":
        for (const declarator of node.declarations) {
          pattern(declarator.id);
          expression(declarator.init);
        }
        return;
      case "BlockStatement":
      case "StaticBlock":
        withScope(new Set(lexicalNames(node.body)), () => node.body.forEach(expression));
        return;
      case "SwitchStatement":
        expression(node.discriminant);
        withScope(new Set(node.cases.flatMap((entry) => lexicalNames(entry.consequent))), () => {
          for (const entry of node.cases) {
            expression(entry.test);
            entry.consequent.forEach(expression);
          }
        });
        return;
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const head = node.type === "ForStatement" ? node.init : node.left;
        const names = head?.type === "VariableDeclaration" && head.kind !== "var"
          ? new Set(head.declarations.flatMap((declarator) => boundNames(declarator.id)))
          : new Set();
        withScope(names, () => {
          for (const key of ["init", "test", "update", "left", "right", "body"]) expression(node[key]);
        });
        return;
      }
      case "CatchClause": {
        const names = new Set(node.param ? boundNames(node.param) : []);
        withScope(names, () => {
          pattern(node.param);
          expression(node.body);
        });
        return;
      }
      case "LabeledStatement":
        expression(node.body);
        return;
      case "MemberExpression":
        expression(node.object);
        if (node.computed) expression(node.property);
        return;
      case "Property":
        if (node.computed) expression(node.key);
        if (node.shorthand && node.value.type === "Identifier" && isImport(node.value.name)) {
          // `{ a }` -> `{ a: <namespace read> }`
          edits.push({ start: node.start, end: node.end, text: `${node.key.name}: ${imports.get(node.value.name)}` });
        } else {
          expression(node.value);
        }
        return;
      case "MethodDefinition":
      case "PropertyDefinition":
        if (node.computed) expression(node.key);
        expression(node.value);
        return;
      case "ExportNamedDeclaration":
        expression(node.declaration);
        return;
      case "ExportSpecifier":
      case "ExportAllDeclaration":
        return;
      default:
        forEachChild(node, expression);
    }
  }

  program.body.forEach(expression);
}

/** let/const/class/function names declared directly in a statement list. */
function lexicalNames(statements) {
  const names = [];
  for (const statement of statements) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (!declaration) continue;
    if (declaration.type === "VariableDeclaration" && declaration.kind !== "var") {
      for (const declarator of declaration.declarations) names.push(...boundNames(declarator.id));
    } else if ((declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id) {
      names.push(declaration.id.name);
    }
  }
  return names;
}

/** `var` names anywhere in a function body, not crossing nested functions. */
function collectVarNames(node, names) {
  if (!node || typeof node.type !== "string") return;
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return;
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const declarator of node.declarations) for (const name of boundNames(declarator.id)) names.add(name);
  }
  forEachChild(node, (child) => collectVarNames(child, names));
}

function importType(node) {
  const attribute = (node.attributes ?? []).find((entry) =>
    (entry.key.name ?? entry.key.value) === "type");
  return attribute ? String(attribute.value.value) : null;
}

/** Depth-first walk; the visitor returns false to skip a node's children. */
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  if (visit(node) === false) return;
  forEachChild(node, (child) => walk(child, visit));
}

/**
 * Calls `each` with every child object of an AST node. A for-in loop with
 * no temporary arrays: Object.entries and [value] wrappers per node were
 * most of the time spent transforming large modules.
 */
function forEachChild(node, each) {
  for (const key in node) {
    if (key === "type" || key === "start" || key === "end") continue;
    const value = node[key];
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child !== null && typeof child === "object") each(child);
    } else {
      each(value);
    }
  }
}

/**
 * Resolves a module specifier against its referrer and an import map
 * ({ imports: { specifier: url } }, exact and trailing-slash prefix entries).
 */
export function resolveModuleSpecifier(specifier, referrer, importMap = null) {
  const imports = importMap?.imports ?? {};
  if (Object.hasOwn(imports, specifier)) return new URL(imports[specifier], referrer).href;
  const prefix = Object.keys(imports)
    .filter((key) => key.endsWith("/") && specifier.startsWith(key))
    .sort((left, right) => right.length - left.length)[0];
  if (prefix) return new URL(imports[prefix] + specifier.slice(prefix.length), referrer).href;
  if (/^(?:\.{0,2}\/)/.test(specifier)) return new URL(specifier, referrer).href;
  try {
    return new URL(specifier).href;
  } catch {
    throw new TypeError(`Failed to resolve module specifier "${specifier}"`);
  }
}
