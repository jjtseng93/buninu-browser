#!/usr/bin/env bun

/**
 * Package entry point: `npx buninu-browser` / `bunx buninu-browser`.
 *
 * The first argument picks a frontend; everything after it is passed on
 * unchanged:
 *
 *   --casty      the terminal frontend (default): runs casty with
 *                CASTY_BROWSER set to this package's buninu-browser.js
 *   --headless   the engine alone (buninu-browser.js, a CDP endpoint)
 *   --win32, --gtk, --appkit, --qt
 *                reserved for the native windowed frontends (not implemented)
 *
 * Any other first argument (a URL, a casty option, or nothing) means --casty
 * with every argument, so `bunx buninu-browser github.com -- --mobile` works.
 * casty is started with bunx, else `bun x` (with the Bun on PATH, or the one
 * running this file).
 *
 * Importing this module (it is also the package's "main") only re-exports
 * the engine's API; the command line runs when it is executed directly.
 */
import { join } from "node:path";

export * from "./buninu-browser.js";

// The package's executable is "casty", not its scoped name, so it is named explicitly.
const CASTY = ["-p", "@drxiaozhi/casty", "casty"];
const ENGINE = join(import.meta.dir, "buninu-browser.js");
const RESERVED_FRONTENDS = new Set(["--win32", "--gtk", "--appkit", "--qt"]);

/** Splits the command line into a frontend and the arguments it receives. */
export function chooseFrontend(argv) {
  const [first, ...rest] = argv;
  if (first === "--casty") return { frontend: "casty", args: rest };
  if (first === "--headless") return { frontend: "headless", args: rest };
  if (RESERVED_FRONTENDS.has(first)) return { frontend: first.slice(2), args: rest, reserved: true };
  return { frontend: "casty", args: argv };
}

/** The command that runs casty: bunx, else `bun x` with bun from PATH or process.argv0. */
export function castyCommand(args, which = Bun.which) {
  const bunx = which("bunx");
  return bunx ? [bunx, ...CASTY, ...args] : [which("bun") ?? process.argv0, "x", ...CASTY, ...args];
}

async function run(cmd, env = process.env) {
  const child = Bun.spawn({ cmd, env, stdio: ["inherit", "inherit", "inherit"] });
  // The terminal's Ctrl+C reaches the child directly; do not die before it.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  return child.exited;
}

if (import.meta.main) {
  const { frontend, args, reserved } = chooseFrontend(Bun.argv.slice(2));
  if (reserved) {
    console.error(`buninu-browser: the ${frontend} frontend is not implemented yet; use --casty or --headless`);
    process.exit(2);
  }
  const code = frontend === "headless"
    ? await run([process.execPath, ENGINE, ...args])
    : await run(castyCommand(args), { ...process.env, CASTY_BROWSER: ENGINE });
  process.exit(code ?? 1);
}
