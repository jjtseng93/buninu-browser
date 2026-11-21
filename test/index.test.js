import { expect, test } from "bun:test";
import packageInfo from "../package.json" with { type: "json" };
import { castyCommand, castyPackage, chooseFrontend } from "../index.js";

test("the first argument picks the frontend; anything else goes to casty whole", () => {
  expect(chooseFrontend(["--casty", "example.com", "--", "--mobile"])).toEqual({ frontend: "casty", args: ["example.com", "--", "--mobile"] });
  expect(chooseFrontend(["--headless", "--remote-debugging-port=9222"])).toEqual({ frontend: "headless", args: ["--remote-debugging-port=9222"] });
  expect(chooseFrontend(["--win32", "example.com"])).toEqual({ frontend: "win32", args: ["example.com"] });
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
  const casty = [castyPackage()];
  const all = (name) => `/bin/${name}`;
  expect(castyCommand(["a", "--", "--mobile"], all))
    .toEqual(["/bin/npx", "--loglevel=error", "-p", castyPackage(), "--", "casty", "a", "--", "--mobile"]);
  // npx without bun could not run casty's `#!/usr/bin/env bun` bin.
  expect(castyCommand(["a"], (name) => name === "bun" ? null : `/bin/${name}`)).toEqual(["/bin/bunx", ...casty, "a"]);
  expect(castyCommand(["a"], (name) => name === "npx" ? null : `/bin/${name}`)).toEqual(["/bin/bunx", ...casty, "a"]);
  expect(castyCommand(["a"], (name) => name === "bun" ? "/bin/bun" : null)).toEqual(["/bin/bun", "x", ...casty, "a"]);
  expect(castyCommand([], () => null)).toEqual([process.argv0, "x", ...casty]);
});

test("explicit Quickshell backends and their help work through the package entry", async () => {
  for (const backend of ["wayland", "headless", "casty"]) {
    const flag = `--quickshell-${backend}`;
    expect(chooseFrontend([flag, "-p", "shell.qml", "--", "--help"]))
      .toEqual({ frontend: flag.slice(2), args: ["-p", "shell.qml", "--", "--help"] });
    const child = Bun.spawn([process.execPath, new URL('../index.js', import.meta.url).pathname, flag, '--help'], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output).toContain(flag);
    expect(output).toContain('-p, --path');
  }
});

test("the casty package comes from the pinned script without shell execution", () => {
  expect(castyPackage()).toBe(packageInfo.scripts.casty.split(/\s+/)[1]);
  expect(castyPackage()).toMatch(/^@drxiaozhi\/casty@\d+\.\d+\.\d+/);
  expect(castyPackage("bunx @drxiaozhi/casty@9.8.7")).toBe("@drxiaozhi/casty@9.8.7");
  expect(() => castyPackage("bunx @drxiaozhi/casty")).toThrow();
  expect(() => castyPackage("bunx @drxiaozhi/casty@1; echo bad")).toThrow();
  expect(() => castyPackage("bunx other@1.0.0")).toThrow();
  expect(() => castyPackage(null)).toThrow();
});
