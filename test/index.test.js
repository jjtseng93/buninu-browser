import { expect, test } from "bun:test";
import { castyCommand, chooseFrontend } from "../index.js";

test("the first argument picks the frontend; anything else goes to casty whole", () => {
  expect(chooseFrontend(["--casty", "example.com", "--", "--mobile"])).toEqual({ frontend: "casty", args: ["example.com", "--", "--mobile"] });
  expect(chooseFrontend(["--headless", "--remote-debugging-port=9222"])).toEqual({ frontend: "headless", args: ["--remote-debugging-port=9222"] });
  expect(chooseFrontend(["--gtk", "x"])).toEqual({ frontend: "gtk", args: ["x"], reserved: true });
  expect(chooseFrontend(["github.com", "--", "--mobile"])).toEqual({ frontend: "casty", args: ["github.com", "--", "--mobile"] });
  expect(chooseFrontend(["--mobile"])).toEqual({ frontend: "casty", args: ["--mobile"] });
  expect(chooseFrontend([])).toEqual({ frontend: "casty", args: [] });
  // Only the first position is special.
  expect(chooseFrontend(["example.com", "--headless"])).toEqual({ frontend: "casty", args: ["example.com", "--headless"] });
});

test("casty runs with bunx, else bun x", () => {
  const casty = ["-p", "@drxiaozhi/casty", "casty"];
  expect(castyCommand(["a"], (name) => name === "bunx" ? "/bin/bunx" : "/bin/bun")).toEqual(["/bin/bunx", ...casty, "a"]);
  expect(castyCommand(["a"], (name) => name === "bun" ? "/bin/bun" : null)).toEqual(["/bin/bun", "x", ...casty, "a"]);
  expect(castyCommand([], () => null)).toEqual([process.argv0, "x", ...casty]);
});
