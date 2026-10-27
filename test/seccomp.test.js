import { expect, test } from "bun:test";
import { ALLOWED_SYSCALLS, buildFilter, encodeFilter } from "../lib/renderer/seccomp.js";
import { SYSCALL_NUMBERS } from "../lib/renderer/syscall-numbers.js";

const RET = 0x06;
const RET_ALLOW = 0x7fff0000;
const RET_EPERM = 0x00050001;
const RET_ENOSYS = 0x00050026;

// Execute the encoded classic-BPF instructions against a seccomp_data record.
// This checks actual jump destinations and argument loads, including the
// architecture we cannot install on the current test machine.
function filterVerdict(program, arch, syscall, args = []) {
  const code = new DataView(encodeFilter(program)), data = new DataView(new ArrayBuffer(64));
  data.setUint32(0, SYSCALL_NUMBERS[arch][syscall], true);
  data.setUint32(4, arch === "x64" ? 0xc000003e : 0xc00000b7, true);
  args.forEach((value, index) => data.setBigUint64(16 + index * 8, BigInt.asUintN(64, BigInt(value)), true));
  let accumulator = 0, pc = 0;
  for (let steps = 0; steps < program.length; steps++) {
    const offset = pc * 8, op = code.getUint16(offset, true), value = code.getUint32(offset + 4, true);
    const yes = code.getUint8(offset + 2), no = code.getUint8(offset + 3);
    switch (op) {
      case 0x20: accumulator = data.getUint32(value, true); pc++; break;
      case 0x15: pc += 1 + (accumulator === value ? yes : no); break;
      case 0x35: pc += 1 + (accumulator >= value ? yes : no); break;
      case 0x45: pc += 1 + ((accumulator & value) !== 0 ? yes : no); break;
      case RET: return value;
      default: throw new Error(`unsupported BPF opcode ${op}`);
    }
  }
  throw new Error("filter did not return a verdict");
}

test("signal filters allow this process but never let tkill target an arbitrary thread", () => {
  const pid = 1234;
  for (const arch of ["x64", "arm64"]) {
    // Even explicitly including the signal syscalls in the unconditional
    // allowlist must not bypass their target checks.
    for (const allowed of [ALLOWED_SYSCALLS, [...ALLOWED_SYSCALLS, "kill", "tkill", "tgkill"]]) {
      const program = buildFilter(arch, pid, allowed);
      for (const name of ["kill", "tkill", "tgkill"]) {
        expect(filterVerdict(program, arch, name, [pid, 0, 0])).toBe(RET_ALLOW);
        for (const other of [pid + 1, 1, 0, -1]) {
          expect(filterVerdict(program, arch, name, [other, 0, 0])).toBe(RET_EPERM);
        }
        expect(program.filter(([op, , , value]) => op === 0x15 && value === SYSCALL_NUMBERS[arch][name])).toHaveLength(1);
      }
      // Exercise the syscall-number reload after the restricted signal blocks.
      expect(filterVerdict(program, arch, "read")).toBe(RET_ALLOW);
      expect(filterVerdict(program, arch, "openat")).toBe(RET_EPERM);
    }
  }
});

test("builds an allowlist program that checks the architecture first and denies by default", () => {
  for (const arch of ["x64", "arm64"]) {
    const program = buildFilter(arch, 1234);
    expect(program[0]).toEqual([0x20, 0, 0, 4]);
    expect(program[1][3]).toBe(arch === "x64" ? 0xc000003e : 0xc00000b7);
    expect(program.at(-1)).toEqual([RET, 0, 0, RET_EPERM]);
    // Every allowed syscall number is followed by RET_ALLOW.
    const allowed = new Set();
    program.forEach(([code, , , k], index) => {
      if (code === 0x15 && program[index + 1]?.[0] === RET && program[index + 1][3] === RET_ALLOW) allowed.add(k);
    });
    expect(allowed.has(SYSCALL_NUMBERS[arch].read)).toBeTrue();
    for (const denied of ["openat", "socket", "execve", "ptrace", "bpf", "io_uring_setup", "unshare", "mount"]) {
      expect(`${arch} ${denied} ${allowed.has(SYSCALL_NUMBERS[arch][denied])}`).toBe(`${arch} ${denied} false`);
    }
    // clone3 reports ENOSYS so libc falls back to the inspectable clone().
    const clone3 = program.findIndex(([code, , , k]) => code === 0x15 && k === SYSCALL_NUMBERS[arch].clone3);
    expect(program[clone3 + 1]).toEqual([RET, 0, 0, RET_ENOSYS]);
    // Signals are only allowed towards this process id.
    expect(program.some(([code, , , k]) => code === 0x15 && k === 1234)).toBeTrue();
    expect(encodeFilter(program).byteLength).toBe(program.length * 8);
  }
});

test("skips syscalls an architecture lacks and rejects unknown architectures", () => {
  // x86-64-only names such as open/poll are simply absent from the arm64 program.
  const program = buildFilter("arm64", 1, ["open", "read"]);
  expect(program.filter(([code, , , k]) => code === 0x15 && k === SYSCALL_NUMBERS.arm64.read)).toHaveLength(1);
  expect(() => buildFilter("sparc", 1)).toThrow("no seccomp syscall table");
});

test("the policy lists no syscall that opens files, sockets or processes", () => {
  const forbidden = ["open", "openat", "openat2", "creat", "socket", "connect", "execve", "execveat",
    "fork", "vfork", "ptrace", "process_vm_readv", "process_vm_writev", "bpf", "io_uring_setup",
    "userfaultfd", "perf_event_open", "keyctl", "unshare", "setns", "mount", "memfd_create"];
  expect(ALLOWED_SYSCALLS.filter((name) => forbidden.includes(name))).toEqual([]);
});

const supported = ["linux", "android"].includes(process.platform) && ["x64", "arm64"].includes(process.arch);

test.skipIf(!supported)("an installed filter keeps the runtime working and blocks escapes", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, new URL("./fixtures/seccomp-child.js", import.meta.url).pathname],
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  await child.exited;
  const results = JSON.parse(output.trim().split("\n").at(-1));
  // On a supported platform the sandbox must really be installed; a silent
  // fallback would make every assertion below vacuous.
  expect(results.status).toMatchObject({ installed: true });
  expect(results.compute.ok).toBeTrue();
  expect(results.allocate).toEqual({ ok: true, value: 64 * 1024 * 1024 });
  expect(results.timer).toEqual({ ok: true, value: "fired" });
  expect(results.date).toEqual({ ok: true, value: "1970-01-01T00:00:00.000Z" });
  expect(results.worker).toEqual({ ok: true, value: 42 });
  expect(results.readFile.ok).toBeFalse();
  expect(results.network.ok).toBeFalse();
  expect(results.spawn.ok).toBeFalse();
  expect(results.killParent.ok).toBeFalse();
});
