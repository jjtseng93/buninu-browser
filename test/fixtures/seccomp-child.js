// Installs the renderer seccomp policy, then reports what still works.
import { installSeccomp } from "../../lib/renderer/seccomp.js";

const status = installSeccomp();
const results = { status };
const attempt = async (name, fn) => {
  try {
    results[name] = { ok: true, value: await fn() };
  } catch (error) {
    results[name] = { ok: false, code: error?.code ?? error?.name ?? String(error) };
  }
};
if (status.installed) {
  await attempt("compute", () => JSON.stringify([...Array(1000).keys()].map((n) => n * 2).sort()).length);
  await attempt("allocate", () => new ArrayBuffer(64 * 1024 * 1024).byteLength);
  await attempt("timer", () => new Promise((resolve) => setTimeout(() => resolve("fired"), 10)));
  await attempt("date", () => new Date(0).toISOString());
  await attempt("worker", () => new Promise((resolve, reject) => {
    const worker = new Worker(URL.createObjectURL(new Blob(["postMessage(42)"])));
    worker.onmessage = ({ data }) => {
      worker.terminate();
      resolve(data);
    };
    worker.onerror = reject;
  }));
  await attempt("readFile", () => Bun.file("/etc/hostname").text());
  await attempt("network", () => fetch("http://127.0.0.1:9/", { signal: AbortSignal.timeout(3000) }).then((r) => r.status));
  await attempt("spawn", async () => (await Bun.spawn(["true"]).exited));
  await attempt("killParent", () => process.kill(process.ppid, 0));
}
console.log(JSON.stringify(results));
process.exit(0);
