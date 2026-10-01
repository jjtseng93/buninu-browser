import { expect, test } from "bun:test";
import Window from "../vendor/happy-dom/packages/happy-dom/src/window/Window.ts";

// Element.matches() caches its result; each case matches once, changes the
// DOM, and expects the same answer querySelectorAll gives.
const cases = [
  [":has() after a removal deep inside", '<div id="x"><p><img></p></div>', "div:has(img)", (d) => d.querySelector("img").remove()],
  [":has() after an insertion deep inside", '<div id="x"><p></p></div>', "div:has(img)", (d) => d.querySelector("p").append(d.createElement("img"))],
  ["+ after an insertion between", '<i></i><li id="x"></li>', "i + li", (d) => d.querySelector("i").after(d.createElement("b"))],
  ["+ on an ancestor", '<i></i><li><b id="x"></b></li>', "i + li b", (d) => d.querySelector("i").after(d.createElement("b"))],
  [":first-child after a prepend", '<li id="x"></li>', "li:first-child", (d) => d.body.prepend(d.createElement("b"))],
  [":first-child on an ancestor", '<ul><li><b id="x"></b></li></ul>', "li:first-child b", (d) => d.querySelector("ul").prepend(d.createElement("li"))],
  [":last-child after an append", '<li id="x"></li>', "li:last-child", (d) => d.body.append(d.createElement("b"))],
];

for (const [name, html, selector, change] of cases) {
  test(`matches() is current for ${name}`, () => {
    const document = new Window().document;
    document.body.innerHTML = html;
    const element = document.getElementById("x");
    element.matches(selector);
    change(document);
    expect(element.matches(selector)).toBe([...document.querySelectorAll(selector)].includes(element));
  });
}
