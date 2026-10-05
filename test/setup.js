import { setDefaultTimeout } from "bun:test";

// Many tests start sandboxed renderer processes, which takes much longer while
// test files run in parallel (bun test --parallel): 5s is too tight then.
setDefaultTimeout(30_000);
