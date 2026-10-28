import { expect, test } from "bun:test";

async function fixture(name, args = []) {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL(`./fixtures/${name}.js`, import.meta.url).pathname,
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  expect(JSON.parse(stdout).pass).toBe(true);
}
for (const args of [[], ["--ses"]])
  test(
    `deferred hidden styles equal eager styles ${args.length ? "under SES" : "normally"}`,
    () => fixture("hidden-style-engine", args),
    20_000,
  );
test(
  "hidden updates and reveals preserve pixels, geometry and resource discovery",
  () => fixture("hidden-style-renderer"),
  60_000,
);
