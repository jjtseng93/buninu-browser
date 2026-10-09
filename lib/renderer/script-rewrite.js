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
 * A sloppy-mode function called without a receiver gets the global object
 * as `this`: `(function () { return this; })()` and `Function("return this")()`
 * are how many libraries find it. The engine's realm global is not the
 * page's, and in strict code `this` is undefined there, so in functions of
 * sloppy code (not arrow functions, which take `this` from outside, nor
 * classes or "use strict" code) `this` becomes `$buninu$self(this)` (see
 * THIS_REWRITE): the page global for undefined, null or the realm global.
 *
 * The result also says whether the source parsed (only parsed, rewritten
 * code may run as sloppy-mode code; see page-realm) and whether the program
 * itself is strict, which the prologue would otherwise hide.
 */
import { Parser } from "../../vendor/acorn/dist/acorn.mjs";

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/**
 * Calls `callback(child, key)` for each child node of an Acorn node. A
 * for-in over the node's own keys (Acorn nodes are plain objects) instead of
 * Object.entries: the rewrites walk every node of every script, and
 * BotGuard-style pages evaluate hundreds of sources at run time.
 */
function forEachChild(node, callback) {
  for (const key in node) {
    if (key === "type" || key === "start" || key === "end") continue;
    const value = node[key];
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child !== null && typeof child?.type === "string") callback(child, key);
    } else if (typeof value.type === "string") {
      callback(value, key);
    }
  }
}

/**
 * Applies non-overlapping edits ({ start, end, text }), listed in the order
 * they would be applied from the end of the source, in one pass instead of
 * re-slicing the whole source per edit. At one position the edit listed
 * later ends up first, as when applying them one by one from the end.
 */
function applyEdits(source, edits) {
  const pieces = [];
  let at = 0;
  for (let index = edits.length - 1; index >= 0; index--) {
    const { start, end, text } = edits[index];
    if (start < at) {
      // Overlapping edits: apply them one by one, from the end.
      let code = source;
      for (const edit of edits) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
      return code;
    }
    pieces.push(source.slice(at, start), text);
    at = end;
  }
  pieces.push(source.slice(at));
  return pieces.join("");
}

/**
 * Parses a script or module with the options every rewrite uses, or returns
 * `program` when a previous rewrite already parsed this exact source (each
 * rewrite that leaves its source unchanged hands its AST on; parsing a large
 * bundle costs about as much as the engine's own parse).
 */
function parseSource(source, sourceType, program = null) {
  return program ?? Parser.parse(source, { ecmaVersion: "latest", sourceType, allowHashBang: true });
}

/** The page global function that a sloppy-mode `this` goes through (see THIS_REWRITE). */
export const THIS_HELPER = "$buninu$self";
/** A sloppy-mode function's `this` as the rewrite leaves it (restoreSourceText undoes it). */
export const THIS_REWRITE = `${THIS_HELPER}(this)`;

/**
 * @param {string} source classic script text
 * @param {object | null} [parsed] the AST of `source`, when a previous rewrite has it
 * @returns {{ code: string, globals: string[], rewritten: boolean, parsed: boolean, strict: boolean }}
 */
export function rewriteClassicScript(source, parsed = null) {
  let program;
  try {
    program = parseSource(source, "script", parsed);
  } catch {
    // Let the engine report the syntax error with its own message.
    return { code: source, globals: [], rewritten: false, parsed: false, strict: false };
  }
  const strict = hasUseStrict(program);

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
      result += `${source.slice(at, node.start)}${THIS_REWRITE}`;
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
      edits.push({ start: node.start, end: node.end, text: variableReplacement(node, parent) });
      return;
    }
    if (node.type === "ClassDeclaration" && programChild) {
      globals.add(node.id.name);
      edits.push({ start: node.start, end: node.end, text: `${node.id.name} = ${text(node.start, node.end)};` });
      return;
    }
    forEachChild(node, (child) => visit(child, node));
  };

  /**
   * The statement a `var` becomes depends on where it sits: a plain
   * statement, the init of a for loop, or the left side of for-in/of.
   */
  const variableReplacement = (node, parent) => {
    if (parent && (parent.type === "ForInStatement" || parent.type === "ForOfStatement") && parent.left === node) {
      return text(node.declarations[0].id.start, node.declarations[0].id.end);
    }
    const expression = declarationAsExpression(node);
    if (parent && parent.type === "ForStatement" && parent.init === node) return expression;
    return expression ? `${expression};` : ";";
  };


  visit(program, null);
  // `this` rewrites outside the statements replaced above (those carry theirs).
  for (const node of thisEdits) {
    if (!edits.some((edit) => edit.start <= node.start && node.end <= edit.end)) {
      edits.push({ start: node.start, end: node.end, text: THIS_REWRITE });
    }
  }
  if (!edits.length) return { code: source, globals: [], rewritten: false, parsed: true, strict };

  edits.sort((left, right) => right.start - left.start);
  const body = applyEdits(source, edits);
  // Hoisting: names exist (as undefined) before any statement runs, and
  // function declarations are assigned first. Existing globals are kept.
  const prologue = [...globals]
    .map((name) => `if (!(${JSON.stringify(name)} in globalThis)) globalThis[${JSON.stringify(name)}] = undefined;`)
    .join(" ");
  return { code: `${prologue} ${hoisted.join(" ")}\n${body}`, globals: [...globals], rewritten: true, parsed: true, strict };
}

/**
 * A classic script as the page realm evaluates it: direct evals, then
 * constructor reads, then the classic-script rewrite, parsing the source
 * once when the earlier rewrites leave it unchanged.
 *
 * @param {string} source
 */
export function rewriteClassicScriptSource(source) {
  const direct = rewriteDirectEval(source);
  const reads = rewriteConstructorReads(direct.code, "script", direct.program);
  return rewriteClassicScript(reads.code, reads.program);
}

/** A module's source with direct evals and constructor reads rewritten (see rewriteClassicScriptSource). */
export function rewriteModuleSource(source) {
  const direct = rewriteDirectEval(source, "module");
  return rewriteConstructorReads(direct.code, "module", direct.program).code;
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
    forEachChild(node, (child) => walk(child, sloppyFunction, strict));
  };
  // A sloppy program's own `this` goes through the helper too: it is the
  // global object SES passes in, unless the evaluator was reached some other way.
  const programStrict = hasUseStrict(program);
  walk(program, !programStrict, programStrict);
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
 * @param {object | null} [parsed] the AST of `source`, when a previous rewrite has it
 * @returns {{ code: string, rewritten: boolean, program: object | null }} `program` is
 *   the AST of `code` when the source was left unchanged and parsed
 */
export function rewriteConstructorReads(source, sourceType = "script", parsed = null) {
  if (!/\)\s*\.\s*constructor\b|\)\s*\[\s*["'`]constructor["'`]\s*\]/.test(source)
    || !/\basync\b|function\s*\*|\bFunction\b/.test(source)) {
    return { code: source, rewritten: false, program: parsed };
  }
  let program;
  try {
    program = parseSource(source, sourceType, parsed);
  } catch {
    return { code: source, rewritten: false, program: null };
  }
  const inserts = [];
  const visit = (node, parent, key) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "MemberExpression" && !node.optional && isConstructorKey(node)
      && node.object.type !== "Super" && !isWrite(parent, key)) {
      // $buninu$constructor( <object> ) and drop ".constructor" / ["constructor"],
      // which may follow the object's closing parenthesis. A call passes true
      // so the helper keeps the object as the receiver.
      // A `new` callee is parenthesized: `new $buninu$constructor(x)(args)`
      // would construct the helper itself.
      const call = parent?.type === "CallExpression" && key === "callee";
      const constructed = parent?.type === "NewExpression" && key === "callee";
      const accessor = source.lastIndexOf(node.computed ? "[" : ".", node.property.start);
      // Acorn excludes the receiver's surrounding parentheses from its range.
      // Keep a comma expression inside ONE helper argument, or its second
      // operand would accidentally become the helper's `call` flag.
      const sequence = node.object.type === "SequenceExpression";
      inserts.push({ at: node.object.start, text: `${constructed ? "(" : ""}${CONSTRUCTOR_HELPER}(${sequence ? "(" : ""}`, end: null });
      // The closing comment keeps what was removed, for restoreSourceText.
      const kind = call ? "c" : constructed ? "n" : "p";
      // Text between the object and the removed accessor (a closing parenthesis) stays where it is.
      const gap = accessor - node.object.end;
      const removed = encodeURIComponent(source.slice(accessor, node.end));
      inserts.push({ at: node.object.end, text: `${sequence ? ")" : ""}${call ? ", true" : ""}/*$buninu$ctor:${kind}:${gap}:${removed}${sequence ? ":s" : ""}*/)${constructed ? ")" : ""}`, end: null });
      inserts.push({ at: accessor, text: "", end: node.end });
    }
    if (node.type === "ChainExpression") return;
    forEachChild(node, (child, key) => visit(child, node, key));
  };
  visit(program, null, null);
  if (!inserts.length) return { code: source, rewritten: false, program };
  // Apply from the end; at one position the removal goes first so the
  // insertion lands before what follows it.
  inserts.sort((left, right) => right.at - left.at || (left.end === null) - (right.end === null));
  const code = applyEdits(source, inserts.map(({ at, text, end }) => ({ start: at, end: end ?? at, text })));
  return { code, rewritten: true, program: null };
}

/** Separates the tokens of `-->` and `<!--` in code (see escapeSesHtmlComments). */
const HTML_COMMENT_MARK = "/*$buninu$h*/";

/**
 * SES rejects HTML comment delimiters anywhere in source, including inside
 * strings and regular expressions where browsers treat them as ordinary
 * data. Escape only those lexical values; their evaluated value is unchanged.
 */
export function escapeSesHtmlComments(source, sourceType = "script") {
  if (!source.includes("<!--") && !source.includes("-->")) return source;
  let program;
  const tokens = [];
  try {
    program = Parser.parse(source, { ecmaVersion: "latest", sourceType, allowHashBang: true, onToken: tokens });
  } catch {
    return source;
  }
  const edits = [];
  // In code, `x-->y` is `x-- > y` and `a<!--b` is `a < !--b`: a comment
  // between the tokens keeps that meaning without the HTML comment text.
  for (let index = 0; index + 1 < tokens.length; index++) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const text = source.slice(token.start, token.end);
    if (text === "--" && next.start === token.end && source[next.start] === ">") {
      edits.push({ start: token.end, end: token.end, text: HTML_COMMENT_MARK });
    } else if (text === "!" && next.start === token.end && source.startsWith("--", next.start)
      && source[token.start - 1] === "<") {
      edits.push({ start: token.end, end: token.end, text: HTML_COMMENT_MARK });
    }
  }
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if ((node.type === "Literal" && (typeof node.value === "string" || node.regex))
      || node.type === "TemplateElement") {
      const text = source.slice(node.start, node.end);
      const escaped = text.replaceAll("<!--", "<\\x21--").replaceAll("-->", "-\\x2d>");
      if (escaped !== text) edits.push({ start: node.start, end: node.end, text: escaped });
      return;
    }
    forEachChild(node, (child) => visit(child));
  };
  visit(program);
  edits.sort((left, right) => right.start - left.start);
  const code = applyEdits(source, edits);
  return code;
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

/** The global a direct eval calls instead (see rewriteDirectEval). */
export const DIRECT_EVAL_HELPER = "$buninu$eval";
/** The lexical name `this` of the calling code takes inside directly evaluated code. */
export const DIRECT_EVAL_THIS = "$buninu$this";
/** Present (true) in a direct eval's scope when the calling code is strict. */
export const DIRECT_EVAL_STRICT = "$buninu$strict";
/**
 * The direct eval's scope object as a constant of the evaluated code (see
 * prepareDirectEvalSource): `x` from the caller becomes `$buninu$s.x`.
 */
export const DIRECT_EVAL_SCOPE = "$buninu$s";
/** Marks a shorthand property `{x}` rewritten to `x: $buninu$s.x`, for restoreSourceText. */
const SHORTHAND_MARK = "/*$buninu$sh*/";

const SCOPE_TYPES = new Set(["BlockStatement", "ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement",
  "CatchClause", "ClassDeclaration", "ClassExpression", "StaticBlock"]);

/**
 * Gives `eval(source)` its direct-eval meaning: the evaluated code sees the
 * caller's local variables.
 *
 * SES evaluates page code through its own evaluator, so a call `eval(x)`
 * made by page code is an indirect eval: `eval("n + 1")` inside a function
 * cannot see the function's `n`. Real code relies on this (template
 * engines, minifier output, integrity checks that evaluate
 * "0,function(){f(t)}" against their own locals). Each direct call site
 * becomes a call of DIRECT_EVAL_HELPER with an object of accessors for every
 * name in scope there; the helper evaluates the source with those accessors
 * as lexical bindings, so reads and assignments reach the caller's variables:
 *
 *   function f(n) { return eval("n + 1"); }
 *     ->  function f(n) { return $buninu$eval({ get n() { return n; }, set n($buninu$v) { n = $buninu$v; },
 *                                               …, $buninu$this: () => this }, "n + 1"); }
 *
 * The real %eval% is never handed to page code. Page code runs in strict
 * mode, where direct eval keeps its own `var`s; that is what this gives.
 * `outerNames` are names the source can already see (when it is itself
 * evaluated by the helper), so nested evals see them too.
 *
 * @param {string} source
 * @param {"script" | "module"} sourceType
 * @param {string[]} [outerNames]
 * @returns {{ code: string, rewritten: boolean }}
 */
export function rewriteDirectEval(source, sourceType = "script", outerNames = [], outerStrict = false) {
  if (!/\beval\s*\(/.test(source)) return { code: source, rewritten: false, program: null };
  let program;
  // Parsed as the later rewrites parse, so they can reuse the AST; a
  // function body (with a top-level return) is parsed again as such.
  let reusable = true;
  try {
    program = parseSource(source, sourceType);
  } catch {
    try {
      program = Parser.parse(source, { ecmaVersion: "latest", sourceType, allowHashBang: true, allowReturnOutsideFunction: true });
      reusable = false;
    } catch {
      return { code: source, rewritten: false, program: null };
    }
  }
  if (!hasDirectEvalCall(program)) return { code: source, rewritten: false, program: reusable ? program : null };
  const edits = [];
  // Each scope: { names: Set<string>, ordinaryFunction: boolean, strict: boolean }.
  const scopes = [{ names: new Set(outerNames), ordinaryFunction: false, strict: outerStrict || sourceType === "module" }];

  const visit = (node, parent, key) => {
    if (!node || typeof node.type !== "string") return;
    const isFunction = FUNCTION_TYPES.has(node.type);
    const isScope = isFunction || node.type === "Program" || (SCOPE_TYPES.has(node.type)
      // A function body block shares the function's scope.
      && !(node.type === "BlockStatement" && parent && FUNCTION_TYPES.has(parent.type)));
    if (isScope) {
      const names = new Set();
      if (isFunction) {
        for (const param of node.params) for (const name of boundNames(param)) names.add(name);
        if (node.type === "FunctionExpression" && node.id) names.add(node.id.name);
        if (node.body.type === "BlockStatement") collectDeclarations(node.body.body, names, true);
      } else if (node.type === "Program") {
        collectDeclarations(node.body, names, true);
      } else if (node.type === "CatchClause") {
        for (const name of boundNames(node.param)) names.add(name);
      } else if (node.type === "ClassExpression" && node.id) {
        names.add(node.id.name);
      } else if (node.type === "BlockStatement" || node.type === "StaticBlock") {
        collectDeclarations(node.body, names, false);
      } else if (node.type === "SwitchStatement") {
        collectDeclarations(node.cases.flatMap((switchCase) => switchCase.consequent), names, false);
      } else if (/^For/.test(node.type)) {
        const init = node.type === "ForStatement" ? node.init : node.left;
        if (init?.type === "VariableDeclaration" && init.kind !== "var") {
          for (const declarator of init.declarations) for (const name of boundNames(declarator.id)) names.add(name);
        }
      }
      const enclosing = scopes[scopes.length - 1];
      const strict = enclosing.strict || node.type === "ClassDeclaration" || node.type === "ClassExpression"
        || (node.type === "Program" && hasUseStrict(node)) || (isFunction && hasUseStrict(node.body));
      scopes.push({ names, ordinaryFunction: isFunction ? node.type !== "ArrowFunctionExpression"
        : enclosing.ordinaryFunction, strict });
    }
    if (node.type === "CallExpression" && !node.optional && node.callee.type === "Identifier"
      && node.callee.name === "eval" && !scopes.some((scope) => scope.names.has("eval"))) {
      const names = new Set();
      for (const scope of scopes) for (const name of scope.names) names.add(name);
      names.delete(DIRECT_EVAL_THIS);
      names.delete(DIRECT_EVAL_STRICT);
      const accessors = [...names].map((name) =>
        `get ${name}() { return ${name}; }, set ${name}($buninu$v) { ${name} = $buninu$v; }`);
      if (scopes[scopes.length - 1].ordinaryFunction && !names.has("arguments")) {
        // Inside a getter `arguments` would be the getter's own; read it here.
        accessors.push("arguments: arguments");
      }
      if (scopes[scopes.length - 1].strict) accessors.push(`${DIRECT_EVAL_STRICT}: true`);
      // An arrow function keeps the caller's `this`.
      accessors.push(`${DIRECT_EVAL_THIS}: () => this`);
      const open = source.indexOf("(", node.callee.end);
      edits.push({ start: node.callee.start, end: node.callee.end, text: DIRECT_EVAL_HELPER });
      edits.push({ start: open + 1, end: open + 1, text: `{ ${accessors.join(", ")} }${node.arguments.length ? ", " : ""}` });
    }
    forEachChild(node, (child, key) => visit(child, node, key));
    if (isScope) scopes.pop();
  };
  visit(program, null, null);
  if (!edits.length) return { code: source, rewritten: false, program: reusable ? program : null };
  // From the end; where an insertion and a replacement start at the same
  // place (`eval(eval(x))`), the replacement goes first so the insertion
  // lands before it.
  edits.sort((left, right) => right.start - left.start || right.end - left.end);
  const code = applyEdits(source, edits);
  return { code, rewritten: true, program: null };
}

/** Whether a program calls `eval(...)` directly anywhere (the scope analysis is only needed then). */
function hasDirectEvalCall(program) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (node.type === "CallExpression" && !node.optional && node.callee.type === "Identifier" && node.callee.name === "eval") {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(program);
  return found;
}

/**
 * Declarations of a statement list: let/const/class (and function
 * declarations, block-scoped in strict code) always; `var` and nested
 * blocks' function declarations too when the list is a function or program
 * body, where `var` is hoisted to.
 */
function collectDeclarations(statements, names, functionBody) {
  const hoistVars = (node) => {
    if (!node || typeof node.type !== "string" || FUNCTION_TYPES.has(node.type)
      || node.type === "ClassDeclaration" || node.type === "ClassExpression") return;
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const declarator of node.declarations) for (const name of boundNames(declarator.id)) names.add(name);
    }
    forEachChild(node, (child) => hoistVars(child));
  };
  for (const statement of statements) {
    const declaration = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
      ? statement.declaration : statement;
    if (!declaration) continue;
    if (declaration.type === "VariableDeclaration" && declaration.kind !== "var") {
      for (const declarator of declaration.declarations) for (const name of boundNames(declarator.id)) names.add(name);
    } else if ((declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id) {
      names.add(declaration.id.name);
    } else if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) names.add(specifier.local.name);
    }
    if (functionBody) hoistVars(statement);
  }
}

/**
 * Directly evaluated source: `this` outside its own ordinary functions is
 * the caller's (DIRECT_EVAL_THIS); in sloppy-mode code an ordinary
 * function's `this` gets THIS_REWRITE as in classic scripts; and nested
 * direct evals see `outerNames`.
 *
 * @param {string} source
 * @param {string[]} outerNames
 * @param {boolean} strict whether the calling code is strict
 * @returns {{ code: string, parsed: boolean, strict: boolean }}
 */
export function prepareDirectEvalSource(source, outerNames, strict = false) {
  const code = rewriteDirectEval(source, "script", outerNames, strict).code;
  let program;
  try {
    program = Parser.parse(code, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true });
  } catch {
    return { code, parsed: false, strict };
  }
  const codeStrict = strict || hasUseStrict(program);
  const edits = [];
  const walk = (node, inFunction, functionStrict) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "ThisExpression") {
      if (!inFunction) edits.push({ node, text: `${DIRECT_EVAL_THIS}()` });
      else if (!functionStrict) edits.push({ node, text: THIS_REWRITE });
      return;
    }
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
      const own = functionStrict || hasUseStrict(node.body);
      for (const param of node.params) walk(param, true, own);
      walk(node.body, true, own);
      return;
    }
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      walk(node.superClass, inFunction, functionStrict);
      // Class code is strict; its methods have their own `this`.
      walk(node.body, true, true);
      return;
    }
    forEachChild(node, (child) => walk(child, inFunction, functionStrict));
  };
  walk(program, false, codeStrict);
  edits.push(...outerReferenceEdits(program, new Set(outerNames)));
  edits.sort((left, right) => right.node.start - left.node.start);
  const result = applyEdits(code, edits.map(({ node, text }) => ({ start: node.start, end: node.end, text })));
  return { code: result, parsed: true, strict: codeStrict };
}

/**
 * The caller's variables a directly evaluated program uses, as
 * `$buninu$s.x` (DIRECT_EVAL_SCOPE): the scope object's accessors read and
 * write the caller's variables. Resolved through the evaluator's `with`
 * scopes instead, each use is a dynamic lookup; code that defines functions
 * with eval and runs them in a loop (bytecode interpreters do) would run many
 * times slower. Names the evaluated code declares itself shadow the
 * caller's, as do its own top-level declarations.
 */
function outerReferenceEdits(program, outerNames) {
  const edits = [];
  if (!outerNames.size) return edits;
  const scopes = [];
  const reference = (identifier) => {
    if (!outerNames.has(identifier.name) || scopes.some((names) => names.has(identifier.name))) return false;
    edits.push({ node: identifier, text: `${DIRECT_EVAL_SCOPE}.${identifier.name}` });
    return true;
  };
  const shorthand = (property) => {
    const name = property.value.name;
    if (!outerNames.has(name) || scopes.some((names) => names.has(name))) return;
    edits.push({ node: property, text: `${name}: ${DIRECT_EVAL_SCOPE}.${name}${SHORTHAND_MARK}` });
  };
  const withScope = (names, body) => {
    scopes.push(names);
    body();
    scopes.pop();
  };
  // A binding pattern: only its default values and computed keys are references.
  const binding = (pattern) => {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier": return;
      case "AssignmentPattern": binding(pattern.left); expression(pattern.right); return;
      case "ArrayPattern": for (const element of pattern.elements) binding(element); return;
      case "RestElement": binding(pattern.argument); return;
      case "ObjectPattern":
        for (const property of pattern.properties) {
          if (property.type === "RestElement") binding(property.argument);
          else {
            if (property.computed) expression(property.key);
            binding(property.value);
          }
        }
        return;
      default: expression(pattern);
    }
  };
  // An assignment target: its identifiers are references.
  const target = (pattern) => {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier": reference(pattern); return;
      case "AssignmentPattern": target(pattern.left); expression(pattern.right); return;
      case "ArrayPattern": for (const element of pattern.elements) target(element); return;
      case "RestElement": target(pattern.argument); return;
      case "ObjectPattern":
        for (const property of pattern.properties) {
          if (property.type === "RestElement") target(property.argument);
          else if (property.shorthand && property.value.type === "Identifier") shorthand(property);
          else {
            if (property.computed) expression(property.key);
            target(property.value);
          }
        }
        return;
      default: expression(pattern);
    }
  };
  const functionNode = (node) => {
    const names = new Set();
    for (const param of node.params) for (const name of boundNames(param)) names.add(name);
    if (node.type === "FunctionExpression" && node.id) names.add(node.id.name);
    if (node.type !== "ArrowFunctionExpression") names.add("arguments");
    if (node.body.type === "BlockStatement") collectDeclarations(node.body.body, names, true);
    withScope(names, () => {
      for (const param of node.params) binding(param);
      if (node.body.type === "BlockStatement") for (const statement of node.body.body) expression(statement);
      else expression(node.body);
    });
  };
  const lexicalNames = (declaration) => {
    const names = new Set();
    if (declaration?.type === "VariableDeclaration" && declaration.kind !== "var") {
      for (const declarator of declaration.declarations) for (const name of boundNames(declarator.id)) names.add(name);
    }
    return names;
  };
  const expression = (node) => {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "Identifier": reference(node); return;
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression": functionNode(node); return;
      case "MemberExpression": expression(node.object); if (node.computed) expression(node.property); return;
      case "Property":
        if (node.computed) expression(node.key);
        if (node.shorthand && node.value.type === "Identifier") shorthand(node);
        else expression(node.value);
        return;
      case "MethodDefinition": case "PropertyDefinition":
        if (node.computed) expression(node.key);
        expression(node.value);
        return;
      case "LabeledStatement": expression(node.body); return;
      case "BreakStatement": case "ContinueStatement": case "MetaProperty": return;
      case "VariableDeclaration":
        for (const declarator of node.declarations) { binding(declarator.id); expression(declarator.init); }
        return;
      case "AssignmentExpression": target(node.left); expression(node.right); return;
      case "ClassDeclaration": case "ClassExpression":
        withScope(new Set(node.id ? [node.id.name] : []), () => { expression(node.superClass); expression(node.body); });
        return;
      case "BlockStatement": case "StaticBlock": {
        const names = new Set();
        collectDeclarations(node.body, names, false);
        withScope(names, () => { for (const statement of node.body) expression(statement); });
        return;
      }
      case "ForStatement":
        withScope(lexicalNames(node.init), () => {
          expression(node.init); expression(node.test); expression(node.update); expression(node.body);
        });
        return;
      case "ForInStatement": case "ForOfStatement":
        withScope(lexicalNames(node.left), () => {
          if (node.left.type === "VariableDeclaration") expression(node.left);
          else target(node.left);
          expression(node.right);
          expression(node.body);
        });
        return;
      case "CatchClause":
        withScope(new Set(boundNames(node.param)), () => { binding(node.param); expression(node.body); });
        return;
      case "SwitchStatement": {
        expression(node.discriminant);
        const names = new Set();
        collectDeclarations(node.cases.flatMap((switchCase) => switchCase.consequent), names, false);
        withScope(names, () => { for (const switchCase of node.cases) forEachChild(switchCase, expression); });
        return;
      }
      default: forEachChild(node, expression);
    }
  };
  const programNames = new Set();
  collectDeclarations(program.body, programNames, true);
  withScope(programNames, () => { for (const statement of program.body) expression(statement); });
  return edits;
}

const SHORTHAND_PROPERTY = /([^\s{,:]+): \$buninu\$s\.\1\/\*\$buninu\$sh\*\//g;
const DIRECT_EVAL_CALL = /\$buninu\$eval\(\{ [^]*?\$buninu\$this: \(\) => this \}(?:, )?/g;
const CONSTRUCTOR_CLOSE = /\/\*\$buninu\$ctor:([pcn]):(\d+):([^*]*?)(:s)?\*\/\)/;

/**
 * The text a page wrote, from the text of code this module rewrote: what
 * Function.prototype.toString shows for page functions. Each rewrite marks
 * what it inserted, so this undoes exactly those edits (and SES's own
 * `import(` evasion).
 *
 * @param {string} text
 */
export function restoreSourceText(text) {
  if (!text.includes("$buninu$") && !text.includes("__import__") && !text.includes("\\x21--")
    && !text.includes("\\x2d>")) return text;
  let code = text.replaceAll(THIS_REWRITE, "this").replaceAll(`${DIRECT_EVAL_THIS}()`, "this");
  if (code.includes(`${DIRECT_EVAL_SCOPE}.`)) {
    code = code.replace(SHORTHAND_PROPERTY, "$1").replaceAll(`${DIRECT_EVAL_SCOPE}.`, "");
  }
  for (let match; (match = CONSTRUCTOR_CLOSE.exec(code));) {
    const open = code.lastIndexOf(`${CONSTRUCTOR_HELPER}(`, match.index);
    if (open < 0) break;
    const [, kind, gapLength, removed, sequence] = match;
    let object = code.slice(open + CONSTRUCTOR_HELPER.length + 1, match.index);
    if (kind === "c" && object.endsWith(", true")) object = object.slice(0, -", true".length);
    if (sequence) object = object.slice(1, -1);
    const start = kind === "n" ? open - 1 : open;
    const end = match.index + match[0].length + (kind === "n" ? 1 : 0);
    const gap = code.slice(end, end + Number(gapLength));
    code = code.slice(0, start) + object + gap + decodeURIComponent(removed) + code.slice(end + Number(gapLength));
  }
  return code.replace(DIRECT_EVAL_CALL, "eval(")
    .replaceAll(HTML_COMMENT_MARK, "")
    .replaceAll("<\\x21--", "<!--").replaceAll("-\\x2d>", "-->")
    .replace(/\b__import__(?=\s*(?:\(|\/[/*]))/g, "import");
}
