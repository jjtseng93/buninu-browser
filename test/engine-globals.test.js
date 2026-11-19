import { expect, test } from "bun:test";
import { engineGlobal, preserveEngineGlobals } from "../lib/renderer/engine-globals.js";

test("engine globals follow the current global until a host realm preserves them, once", () => {
  const name = "__engineGlobalsTestValue";
  globalThis[name] = "engine";
  try {
    // The sandboxed path preserves nothing: the ordinary global, live.
    expect(engineGlobal(name)).toBe("engine");
    globalThis[name] = "changed";
    expect(engineGlobal(name)).toBe("changed");
    globalThis[name] = "engine";
    preserveEngineGlobals([name, "__engineGlobalsAbsent"]);
    // A page then installs its own value on the shared global.
    globalThis[name] = "page";
    expect(engineGlobal(name)).toBe("engine");
    // A later host realm must not preserve the previous page's value.
    preserveEngineGlobals([name]);
    expect(engineGlobal(name)).toBe("engine");
    // Names the engine never had are not invented.
    globalThis.__engineGlobalsAbsent = "added by page";
    preserveEngineGlobals(["__engineGlobalsAbsent"]);
    expect(engineGlobal("__engineGlobalsAbsent")).toBeUndefined();
  } finally {
    delete globalThis[name];
    delete globalThis.__engineGlobalsAbsent;
  }
});
