import { expect, test } from "bun:test";
import { castyCommand, chooseFrontend } from "../index.js";

test("the first argument picks the frontend; anything else goes to casty whole", () => {
  expect(chooseFrontend(["--casty", "example.com", "--", "--mobile"])).toEqual({ frontend: "casty", args: ["example.com", "--", "--mobile"] });
  expect(chooseFrontend(["--headless", "--remote-debugging-port=9222"])).toEqual({ frontend: "headless", args: ["--remote-debugging-port=9222"] });
  expect(chooseFrontend(["--gtk", "x"])).toEqual({ frontend: "gtk", args: ["x"], reserved: true });
  expect(chooseFrontend(["github.com", "--", "--mobile"])).toEqual({ frontend: "casty", args: ["github.com", "--", "--mobile"] });
  expect(chooseFrontend(["--mobile"])).toEqual({ frontend: "casty", args: ["--mobile"] });
  expect(chooseFrontend([])).toEqual({ frontend: "casty", args: [] });
  expect(chooseFrontend(["-V"])).toEqual({ frontend: "version", args: [], information: true });
  expect(chooseFrontend(["-h"])).toMatchObject({ frontend: "help", information: true });
  expect(chooseFrontend(["--docs"])).toMatchObject({ frontend: "readme", information: true });
  // Only the first position is special.
  expect(chooseFrontend(["example.com", "--headless"])).toEqual({ frontend: "casty", args: ["example.com", "--headless"] });
  expect(chooseFrontend(["--casty", "--help"])).toEqual({ frontend: "casty", args: ["--help"] });
});

test("casty runs with npx when npx and bun exist, else bunx, else bun x", () => {
  const casty = ["-p", "@drxiaozhi/casty", "casty"];
  const all = (name) => `/bin/${name}`;
  expect(castyCommand(["a", "--", "--mobile"], all))
    .toEqual(["/bin/npx", "--loglevel=error", "-p", "@drxiaozhi/casty", "--", "casty", "a", "--", "--mobile"]);
  // npx without bun could not run casty's `#!/usr/bin/env bun` bin.
  expect(castyCommand(["a"], (name) => name === "bun" ? null : `/bin/${name}`)).toEqual(["/bin/bunx", ...casty, "a"]);
  expect(castyCommand(["a"], (name) => name === "npx" ? null : `/bin/${name}`)).toEqual(["/bin/bunx", ...casty, "a"]);
  expect(castyCommand(["a"], (name) => name === "bun" ? "/bin/bun" : null)).toEqual(["/bin/bun", "x", ...casty, "a"]);
  expect(castyCommand([], () => null)).toEqual([process.argv0, "x", ...casty]);
});
