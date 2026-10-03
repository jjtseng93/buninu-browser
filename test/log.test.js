import { expect, test } from "bun:test";
import { DEFAULT_LOG_FILE, logFileFromEnv } from "../lib/log.js";

test("BUNINU_LOG picks the log file", () => {
  expect(logFileFromEnv({}, "/work")).toBeNull();
  expect(logFileFromEnv({ BUNINU_LOG: "0" }, "/work")).toBeNull();
  expect(logFileFromEnv({ BUNINU_LOG: "1" }, "/work")).toBe(`/work/${DEFAULT_LOG_FILE}`);
  expect(logFileFromEnv({ BUNINU_LOG: "true" }, "/work")).toBe(`/work/${DEFAULT_LOG_FILE}`);
  expect(logFileFromEnv({ BUNINU_LOG: "logs/b.log" }, "/work")).toBe("/work/logs/b.log");
  expect(logFileFromEnv({ BUNINU_LOG: "/tmp/b.log" }, "/work")).toBe("/tmp/b.log");
});

test("the CLI writes controller and renderer output to the log file", async () => {
  const dir = `${import.meta.dir}/../.test-log-${process.pid}`;
  await Bun.$`mkdir -p ${dir}`.quiet();
  try {
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/../buninu-browser.js`, "--remote-debugging-port=0"], {
      cwd: dir,
      env: { ...process.env, BUNINU_LOG: "1" },
      stdout: "ignore",
      stderr: "pipe",
    });
    const reader = child.stderr.getReader();
    let seen = "";
    // The endpoint opens first; the sandbox line follows once the first renderer is up.
    while (!seen.includes("renderer sandbox:")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    child.kill();
    await child.exited;
    expect(seen.indexOf("DevTools listening")).toBeGreaterThan(-1);
    expect(seen.indexOf("DevTools listening")).toBeLessThan(seen.indexOf("renderer sandbox:"));
    const log = await Bun.file(`${dir}/${DEFAULT_LOG_FILE}`).text();
    expect(log).toContain("[log] started pid");
    expect(log).toContain("renderer sandbox: seccomp");
    // Renderer output (its warm-up timings) arrives through the controller.
    expect(log).toMatch(/\[renderer \d+\] timing: about:warm-up/);
  } finally {
    await Bun.$`rm -rf ${dir}`.quiet();
  }
}, 30_000);
