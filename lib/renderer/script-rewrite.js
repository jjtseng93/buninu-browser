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

  const declare = (pattern) => {
    for (const name of boundNames(pattern)) globals.add(name);
  };

  /** Turns `var a = 1, {b} = c` into `a = 1, ({b} = c)`, or removes it. */
  const declarationAsExpression = (declaration) => declaration.declarations
    .filter((declarator) => declarator.init)
    .map((declarator) => {
      const target = source.slice(declarator.id.start, declarator.id.end);
      const value = source.slice(declarator.init.start, declarator.init.end);
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
        hoisted.push(`${node.id.name} = ${source.slice(node.start, node.end)};`);
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
      edits.push({ start: node.start, end: node.end, text: `${node.id.name} = ${source.slice(node.start, node.end)};` });
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
      return source.slice(node.declarations[0].id.start, node.declarations[0].id.end);
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
