import { expect, test } from "bun:test";
for (const args of [[], ["--ses"]])
  test(`hidden style measurement callbacks cannot restart unfinished chains ${args.length ? "under SES" : "normally"}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./fixtures/hidden-style-reentry.js", import.meta.url).pathname,
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
  }, 20_000);
