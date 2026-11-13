import { describe, expect, test } from "bun:test";
import { createReactive } from "../lib/qml/reactive.js";

describe("QML binding cycle containment", () => {
  test("sync cycle errors describe only the current cycle and release its jobs", () => {
    const reactive = createReactive();
    const old = reactive.state({ oldKey: 0 });
    reactive.effect(() => { if (old.oldKey < 95) old.oldKey++; }, { sync: true });
    const current = reactive.state({ currentKey: 0, otherKey: 0 });
    reactive.effect(() => { current.otherKey; current.currentKey = current.otherKey + 1; }, { sync: true });
    reactive.effect(() => { current.currentKey; current.otherKey = current.currentKey + 1; }, { sync: true });
    let currentError;
    try {
      current.currentKey++;
    } catch (error) {
      currentError = error;
    }
    expect(currentError?.message).toContain("QML binding cycle");
    expect(currentError?.message).toContain("currentKey");
    expect(currentError?.message).not.toContain("oldKey");
  });
});
