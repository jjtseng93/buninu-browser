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
 *   --help, -h / --version, -V / --readme, --docs
 *                this launcher's help, version and README
 *
 * Any other first argument (a URL, a casty option, or nothing) means --casty
 * with every argument, so `npx buninu-browser github.com -- --mobile` works.
 * casty's and the engine's own help: `--casty --help`, `--headless --help`.
 * casty is started with npx when both npx and bun are on PATH (npm installs
 * plain file copies; casty's bin still runs on Bun through its shebang),
 * else with bunx, else `bun x` (with the Bun on PATH, or the one running
 * this file).
 *
 * Importing this module (it is also the package's "main") only re-exports
 * the engine's API; the command line runs when it is executed directly.
 */
import { join } from "node:path";
import packageInfo from "./package.json" with { type: "json" };

export * from "./buninu-browser.js";

const CASTY_PACKAGE = "@drxiaozhi/casty";
const ENGINE = join(import.meta.dir, "buninu-browser.js");
const RESERVED_FRONTENDS = new Set(["--win32", "--gtk", "--appkit", "--qt"]);
const INFORMATION = new Map([
  ["--help", "help"], ["-h", "help"], ["-help", "help"],
  ["--version", "version"], ["-V", "version"], ["-version", "version"],
  ["--readme", "readme"], ["--docs", "readme"],
]);

/** Splits the command line into a frontend and the arguments it receives. */
export function chooseFrontend(argv) {
  const [first, ...rest] = argv;
  if (first === "--casty") return { frontend: "casty", args: rest };
  if (first === "--headless") return { frontend: "headless", args: rest };
  if (RESERVED_FRONTENDS.has(first)) return { frontend: first.slice(2), args: rest, reserved: true };
  if (INFORMATION.has(first)) return { frontend: INFORMATION.get(first), args: rest, information: true };
  return { frontend: "casty", args: argv };
}

/**
 * The command that runs casty: npx when npx and bun are both on PATH, else
 * bunx, else `bun x` with bun from PATH or process.argv0.
 */
export function castyCommand(args, which = Bun.which) {
  const npx = which("npx");
  const bun = which("bun");
  // npx asks before installing casty (on purpose); --loglevel=error keeps npm
  // notices off casty's screen. Its executable is "casty", not the scoped
  // package name, so npx is told which one to run.
  if (npx && bun) return [npx, "--loglevel=error", "-p", CASTY_PACKAGE, "--", "casty", ...args];
  const bunx = which("bunx");
  return bunx ? [bunx, CASTY_PACKAGE, ...args] : [bun ?? process.argv0, "x", CASTY_PACKAGE, ...args];
}

export function usage(name = packageInfo.name) {
  return `Usage:
  ${name} [URL] [CASTY_OPTIONS...] [-- BROWSER_FLAGS...]
  ${name} --casty [CASTY_ARGS...]
  ${name} --headless [ENGINE_OPTIONS...]

Frontends (first argument only):
  --casty
      Browse in the terminal with casty (the default)
      Needs a terminal with the Kitty graphics protocol
      Any first argument not listed here also starts casty,
      and every argument goes to casty
      casty's own options: ${name} --casty --help
  --headless
      Start the engine only, as a CDP endpoint
      The engine's options: ${name} --headless --help
  --win32, --gtk, --appkit, --qt
      Native windowed frontends (reserved, not implemented yet)

Information:
  --help, -h, -help
      Show this help & exit
  --version, -V, -version
      Show version+backend info & exit
  --readme, --docs
      Show ${name}'s README.md & exit

Examples:
  ${name} github.com -- --mobile
      casty on GitHub, the engine presenting as a phone
  ${name} --headless --remote-debugging-port=9222
      The engine alone, for any CDP client
`;
}

function printVersion() {
  console.log(`${packageInfo.name}:`, packageInfo.description);
  console.log("  Made by: Dr. John (醫者小智)");
  console.log("");
  console.log("Version:", packageInfo.version);
  console.log("Runtime:", `Bun ${Bun.version}`);
  console.log("Platform:", `${process.platform}-${process.arch}`);
  console.log("Engine:", ENGINE);
  console.log("casty launcher:", castyCommand([]).join(" "));
  console.log("Frontends: casty (default), headless; reserved: win32, gtk, appkit, qt");
}

async function printReadme() {
  const readme = await Bun.file(join(import.meta.dir, "README.md")).text();
  process.stdout.write(Bun.markdown.ansi(readme, { hyperlinks: true }));
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
  if (frontend === "help") {
    console.log(usage());
    process.exit(0);
  }
  if (frontend === "version") {
    printVersion();
    process.exit(0);
  }
  if (frontend === "readme") {
    await printReadme();
    process.exit(0);
  }
  const code = frontend === "headless"
    ? await run([process.execPath, ENGINE, ...args])
    : await run(castyCommand(args), { ...process.env, CASTY_BROWSER: ENGINE });
  process.exit(code ?? 1);
}
