/**
 * Rewrites a classic script so its top-level declarations become properties
 * of the global object, as they are in a browser.
 *
 * SES evaluates code with a strict-mode direct eval, which gives every script
 * its own variable scope: `var x` in one <script> would be invisible to the
 * next. Together with SES's `sloppyGlobalsMode` (assignments to undeclared
 * names set global properties) this rewrite restores the sharing:
 *
 *   var a = 1, b;        ->  a = 1;            (+ prologue declares a and b)
 *   for (var i = 0; …)   ->  for (i = 0; …)
 *   function f() {}      ->  f = function f() {};   (hoisted to the prologue)
 *   let/const/class x    ->  global properties (an approximation: browsers
 *                            keep them in a shared lexical scope instead)
 *
 * Declarations inside functions are untouched. Strict-mode-only restrictions
 * (`with`, legacy octal literals, `arguments.callee`) cannot be lifted.
 *
 * SES code is strict, so a function called without a receiver gets
 * `this === undefined`, where a sloppy-mode one gets the global object:
 * `(function () { return this; })()` and `Function("return this")()` are how
 * many libraries find the global object. In functions of sloppy code (not
 * arrow functions, which take `this` from outside, nor classes or
 * "use strict" code), `this` becomes `(this ?? globalThis)`.
 */
import { Parser } from "../../vendor/acorn/dist/acorn.mjs";

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/**
 * @param {string} source classic script text
 * @returns {{ code: string, globals: string[], rewritten: boolean }}
 */
export function rewriteClassicScript(source) {
  let program;
  try {
    program = Parser.parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowHashBang: true,
      allowReturnOutsideFunction: false,
    });
  } catch {
    // Let the engine report the syntax error with its own message.
    return { code: source, globals: [], rewritten: false };
  }

  const edits = [];
  const globals = new Set();
  const hoisted = [];
  const thisEdits = sloppyThisExpressions(program);
  // Source text with the `this` rewrites inside it applied.
  const text = (start, end) => {
    let result = "";
    let at = start;
    for (const node of thisEdits) {
      if (node.start < start || node.end > end) continue;
      result += `${source.slice(at, node.start)}(this ?? globalThis)`;
      at = node.end;
    }
    return result + source.slice(at, end);
  };

  const declare = (pattern) => {
    for (const name of boundNames(pattern)) globals.add(name);
  };

  /** Turns `var a = 1, {b} = c` into `a = 1, ({b} = c)`, or removes it. */
  const declarationAsExpression = (declaration) => declaration.declarations
    .filter((declarator) => declarator.init)
    .map((declarator) => {
      const target = text(declarator.id.start, declarator.id.end);
      const value = text(declarator.init.start, declarator.init.end);
      return declarator.id.type === "Identifier" ? `${target} = ${value}` : `(${target} = ${value})`;
    })
    .join(", ");

  // The walk never enters function or class bodies, so every `var` it sees is
  // function-scope-free and belongs to the global object. let/const/class
  // and function declarations are lifted only when they sit directly in the
  // program body; inside blocks they keep their block scope.
  const visit = (node, parent) => {
    if (!node || typeof node.type !== "string") return;
    const programChild = parent?.type === "Program";
    if (FUNCTION_TYPES.has(node.type)) {
      if (node.type === "FunctionDeclaration" && programChild) {
        globals.add(node.id.name);
        hoisted.push(`${node.id.name} = ${text(node.start, node.end)};`);
        edits.push({ start: node.start, end: node.end, text: "" });
      }
      return;
    }
    if (node.type === "ClassBody" || node.type === "StaticBlock") return;
    if (node.type === "VariableDeclaration" && (node.kind === "var" || programChild)) {
      for (const declarator of node.declarations) declare(declarator.id);
      edits.push({ start: node.start, end: node.end, text: variableReplacement(node) });
      return;
    }
    if (node.type === "ClassDeclaration" && programChild) {
      globals.add(node.id.name);
      edits.push({ start: node.start, end: node.end, text: `${node.id.name} = ${text(node.start, node.end)};` });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object") visit(child, node);
      }
    }
  };

  /**
   * The statement a `var` becomes depends on where it sits: a plain
   * statement, the init of a for loop, or the left side of for-in/of.
   */
  const variableReplacement = (node) => {
    const parent = parentOf.get(node);
    if (parent && (parent.type === "ForInStatement" || parent.type === "ForOfStatement") && parent.left === node) {
      return text(node.declarations[0].id.start, node.declarations[0].id.end);
    }
    const expression = declarationAsExpression(node);
    if (parent && parent.type === "ForStatement" && parent.init === node) return expression;
    return expression ? `${expression};` : ";";
  };

  const parentOf = new Map();
  (function link(node) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (child && typeof child.type === "string") {
          parentOf.set(child, node);
          link(child);
        }
      }
    }
  })(program);

  visit(program, null);
  // `this` rewrites outside the statements replaced above (those carry theirs).
  for (const node of thisEdits) {
    if (!edits.some((edit) => edit.start <= node.start && node.end <= edit.end)) {
      edits.push({ start: node.start, end: node.end, text: "(this ?? globalThis)" });
    }
  }
  if (!edits.length) return { code: source, globals: [], rewritten: false };

  edits.sort((left, right) => right.start - left.start);
  let body = source;
  for (const edit of edits) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  // Hoisting: names exist (as undefined) before any statement runs, and
  // function declarations are assigned first. Existing globals are kept.
  const prologue = [...globals]
    .map((name) => `if (!(${JSON.stringify(name)} in globalThis)) globalThis[${JSON.stringify(name)}] = undefined;`)
    .join(" ");
  return { code: `${prologue} ${hoisted.join(" ")}\n${body}`, globals: [...globals], rewritten: true };
}

/** Whether a function body or program starts with a "use strict" directive. */
function hasUseStrict(node) {
  const body = node?.type === "BlockStatement" || node?.type === "Program" ? node.body : [];
  for (const statement of body) {
    if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string") return false;
    if (statement.directive === "use strict") return true;
  }
  return false;
}

/** The `this` expressions of sloppy-mode functions in a program, in source order (see rewriteClassicScript). */
function sloppyThisExpressions(program) {
  const found = [];
  const walk = (node, sloppyFunction, strict) => {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "ThisExpression":
        if (sloppyFunction) found.push(node);
        return;
      case "FunctionDeclaration":
      case "FunctionExpression": {
        const functionStrict = strict || hasUseStrict(node.body);
        for (const param of node.params) walk(param, !functionStrict, functionStrict);
        walk(node.body, !functionStrict, functionStrict);
        return;
      }
      case "ArrowFunctionExpression": {
        const arrowStrict = strict || hasUseStrict(node.body);
        for (const param of node.params) walk(param, sloppyFunction, arrowStrict);
        walk(node.body, sloppyFunction, arrowStrict);
        return;
      }
      case "ClassDeclaration":
      case "ClassExpression":
        walk(node.superClass, sloppyFunction, strict);
        // Class code is strict.
        walk(node.body, false, true);
        return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object") walk(child, sloppyFunction, strict);
      }
    }
  };
  walk(program, false, hasUseStrict(program));
  return found.sort((left, right) => left.start - right.start);
}

/** Names bound by a declaration pattern (identifiers, destructuring, defaults, rest). */
export function boundNames(pattern) {
  if (!pattern) return [];
  switch (pattern.type) {
    case "Identifier": return [pattern.name];
    case "ObjectPattern": return pattern.properties.flatMap((property) =>
      boundNames(property.type === "RestElement" ? property.argument : property.value));
    case "ArrayPattern": return pattern.elements.flatMap((element) => boundNames(element));
    case "AssignmentPattern": return boundNames(pattern.left);
    case "RestElement": return boundNames(pattern.argument);
    default: return [];
  }
}

/** The global the constructor-read rewrite calls (see rewriteConstructorReads). */
export const CONSTRUCTOR_HELPER = "$buninu$constructor";

/**
 * Routes reads of `.constructor` through CONSTRUCTOR_HELPER:
 *
 *   Object.getPrototypeOf(async function () {}).constructor
 *     ->  $buninu$constructor(Object.getPrototypeOf(async function () {}))
 *
 * SES replaces the Function, AsyncFunction, GeneratorFunction and
 * AsyncGeneratorFunction constructors reachable through prototypes with inert
 * ones that throw, and they are frozen afterwards; the helper hands out
 * working per-document versions instead. Only plain reads change: assignment
 * targets, `delete` and optional chains keep their form; a call passes the
 * object along to stay its receiver. The edits only insert text, so nested
 * reads compose.
 *
 * Parsing costs about as much as the engine's own parse, so only sources
 * with the usual idiom are rewritten: `.constructor` right after a closing
 * parenthesis — `(async () => {}).constructor`,
 * `Object.getPrototypeOf(function* () {}).constructor` — in code that
 * mentions async, generators or Function. On GitHub that is one script in a
 * hundred.
 *
 * @param {string} source
 * @param {"script" | "module"} sourceType
 * @returns {{ code: string, rewritten: boolean }}
 */
export function rewriteConstructorReads(source, sourceType = "script") {
  if (!/\)\s*\.\s*constructor\b|\)\s*\[\s*["'`]constructor["'`]\s*\]/.test(source)
    || !/\basync\b|function\s*\*|\bFunction\b/.test(source)) {
    return { code: source, rewritten: false };
  }
  let program;
  try {
    program = Parser.parse(source, { ecmaVersion: "latest", sourceType, allowHashBang: true });
  } catch {
    return { code: source, rewritten: false };
  }
  const inserts = [];
  const visit = (node, parent, key) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "MemberExpression" && !node.optional && isConstructorKey(node)
      && node.object.type !== "Super" && !isWrite(parent, key)) {
      // $buninu$constructor( <object> ) and drop ".constructor" / ["constructor"],
      // which may follow the object's closing parenthesis. A call passes true
      // so the helper keeps the object as the receiver.
      const call = parent?.type === "CallExpression" && key === "callee";
      const accessor = source.lastIndexOf(node.computed ? "[" : ".", node.property.start);
      inserts.push({ at: node.object.start, text: `${CONSTRUCTOR_HELPER}(`, end: null });
      inserts.push({ at: node.object.end, text: call ? ", true)" : ")", end: null });
      inserts.push({ at: accessor, text: "", end: node.end });
    }
    if (node.type === "ChainExpression") return;
    for (const [name, value] of Object.entries(node)) {
      if (name === "type" || name === "start" || name === "end") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object") visit(child, node, name);
      }
    }
  };
  visit(program, null, null);
  if (!inserts.length) return { code: source, rewritten: false };
  // Apply from the end; at one position the removal goes first so the
  // insertion lands before what follows it.
  inserts.sort((left, right) => right.at - left.at || (left.end === null) - (right.end === null));
  let code = source;
  for (const { at, text, end } of inserts) code = code.slice(0, at) + text + code.slice(end ?? at);
  return { code, rewritten: true };
}

function isConstructorKey(node) {
  return node.computed
    ? node.property.type === "Literal" && node.property.value === "constructor"
    : node.property.type === "Identifier" && node.property.name === "constructor";
}

function isWrite(parent, key) {
  if (!parent) return false;
  if ((parent.type === "AssignmentExpression" || parent.type === "AssignmentPattern") && key === "left") return true;
  if (parent.type === "UpdateExpression") return true;
  if (parent.type === "UnaryExpression" && parent.operator === "delete") return true;
  return (parent.type === "ForInStatement" || parent.type === "ForOfStatement") && key === "left";
}
