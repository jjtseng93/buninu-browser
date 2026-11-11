import { expect, test } from "bun:test";
import Window from "../vendor/happy-dom/packages/happy-dom/src/window/Window.ts";

// An empty old value is a value: only an absent attribute or unrequested old
// value is reported as null.
test("MutationRecord keeps an empty old value distinct from null", () => {
  const { document, MutationObserver } = new Window();
  const element = document.createElement("div");
  element.setAttribute("a", "");
  const text = document.createTextNode("");
  element.append(text);
  const observer = new MutationObserver(() => {});
  observer.observe(element, { attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true, subtree: true });
  element.setAttribute("a", "x");
  element.setAttribute("b", "y");
  text.data = "z";
  expect(observer.takeRecords().map((record) => record.oldValue)).toEqual(["", null, ""]);
});
