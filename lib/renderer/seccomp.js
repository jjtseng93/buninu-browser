/**
 * seccomp-bpf sandbox for the renderer process.
 *
 * The policy is an allowlist modelled on Chromium's renderer baseline
 * (sandbox/linux/seccomp-bpf-helpers/baseline_policy.cc): anything not listed
 * fails with EPERM; clone() may only create threads; clone3() reports ENOSYS
 * so libc falls back to the inspectable clone(); signals may only target this
 * process. Syscall numbers come from Chromium's
 * sandbox/linux/system_headers/{x86_64,arm64}_linux_syscalls.h.
 *
 * The filter is installed with SECCOMP_FILTER_FLAG_TSYNC because Bun is
 * multi-threaded from startup. Everything the renderer needs from the file
 * system must be loaded before installation: open() is not allowed after it.
 *
 * Installing requires bun:ffi (libc's syscall()); AGENTS.md permits dlopen of
 * libc when no other mechanism exists, which is the case for seccomp.
 */
import { dlopen, ptr } from "bun:ffi";
import { SYSCALL_NUMBERS } from "./syscall-numbers.js";

/**
 * Syscalls the renderer may use after startup. The base sets are Chromium's
 * unconditional baseline (IsBaselinePolicyAllowed in baseline_policy.cc); the
 * rest are syscalls Chromium allows with argument checks, allowed here
 * without them for now, plus what a strace of the renderer workload (load,
 * resize, raster, scroll, hints, hit testing) showed Bun/JSC need.
 * clone, clone3, kill, tgkill and prctl are handled separately with argument
 * checks.
 */
export const ALLOWED_SYSCALLS = Object.freeze([
  // Address space (Chromium: IsAllowedAddressSpaceAccess, mmap/mprotect/madvise restricted).
  "brk", "mmap", "munmap", "mprotect", "mremap", "madvise", "mlock", "munlock", "mseal", "mincore",
  // Scheduling (IsAllowedBasicScheduler; own-thread affinity queries).
  "nanosleep", "pause", "sched_yield", "sched_getaffinity", "sched_getparam", "sched_getscheduler", "getpriority",
  // Event loop (IsAllowedEpoll, IsEventFd). epoll_pwait2 is Bun's event loop wait.
  "epoll_create", "epoll_create1", "epoll_ctl", "epoll_pwait", "epoll_pwait2", "epoll_wait", "eventfd", "eventfd2",
  // I/O on already-open descriptors (IsAllowedGeneralIo, IsAllowedFileSystemAccessViaFd).
  "read", "readv", "pread64", "write", "writev", "lseek", "poll", "ppoll", "select", "pselect6",
  "recvfrom", "recvmsg", "recvmmsg", "sendto", "sendmsg", "fstat", "ftruncate",
  // Descriptor operations (IsAllowedOperationOnFd); fcntl is argument-restricted in Chromium.
  "close", "dup", "dup2", "dup3", "fcntl", "shutdown",
  // Futexes and time (IsAllowedFutex; clock_* are clock-id restricted in Chromium).
  "futex", "clock_gettime", "clock_getres", "clock_nanosleep", "gettimeofday", "time",
  // Signals (IsAllowedSignalHandling). rt_sigsuspend: JSC suspends threads for GC.
  "rt_sigaction", "rt_sigprocmask", "rt_sigreturn", "rt_sigtimedwait", "rt_sigsuspend", "sigaltstack",
  // Identity (IsGetSimpleId).
  "getpid", "getppid", "gettid", "getuid", "geteuid", "getgid", "getegid", "getgroups",
  "getresuid", "getresgid", "getsid", "capget",
  // Thread and process lifetime (IsAllowedProcessStartOrDeath; no fork/exec).
  "exit", "exit_group", "wait4", "waitid", "restart_syscall", "rseq",
  // Misc allowed by Chromium's baseline.
  "uname", "getrandom",
]);

// prctl options a renderer may use: thread names (JSC, Bun) and Android's
// anonymous-mapping names. Everything else, e.g. PR_SET_DUMPABLE, is refused.
const PRCTL_ALLOWED = Object.freeze([15 /* PR_SET_NAME */, 16 /* PR_GET_NAME */, 0x53564d41 /* PR_SET_VMA */]);

const AUDIT_ARCH = Object.freeze({ x64: 0xc000003e, arm64: 0xc00000b7 });
const X32_SYSCALL_BIT = 0x40000000;
const CLONE_THREAD = 0x00010000;
const RET_KILL_PROCESS = 0x80000000;
const RET_ALLOW = 0x7fff0000;
const retErrno = (errno) => 0x00050000 | (errno & 0xffff);
const EPERM = 1;
const ENOSYS = 38;
const SECCOMP_SET_MODE_FILTER = 1;
const SECCOMP_FILTER_FLAG_TSYNC = 1;
const PR_SET_NO_NEW_PRIVS = 38;

// struct seccomp_data offsets.
const DATA_NR = 0;
const DATA_ARCH = 4;
const DATA_ARG0_LOW = 16;

// BPF opcodes.
const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const JSET_K = 0x45;
const RET_K = 0x06;

/**
 * Builds the filter program for an architecture as [code, jt, jf, k] tuples.
 * @param {"x64" | "arm64"} arch
 * @param {number} pid the process allowed as a signal target
 * @param {readonly string[]} allowed syscall names
 */
export function buildFilter(arch, pid, allowed = ALLOWED_SYSCALLS) {
  const numbers = SYSCALL_NUMBERS[arch];
  if (!numbers) throw new Error(`no seccomp syscall table for ${arch}`);
  const nr = (name) => {
    const value = numbers[name];
    if (value == null) throw new Error(`unknown ${arch} syscall ${name}`);
    return value;
  };
  const program = [
    [LD_W_ABS, 0, 0, DATA_ARCH],
    [JEQ_K, 1, 0, AUDIT_ARCH[arch]],
    [RET_K, 0, 0, RET_KILL_PROCESS],
    [LD_W_ABS, 0, 0, DATA_NR],
  ];
  if (arch === "x64") {
    // The x32 ABI reuses x86-64 numbers with bit 30 set; never allow it.
    program.push([JGE_K, 0, 1, X32_SYSCALL_BIT], [RET_K, 0, 0, retErrno(EPERM)]);
  }
  // clone(): threads only (CLONE_THREAD), never new processes or namespaces.
  program.push(
    [JEQ_K, 0, 4, nr("clone")],
    [LD_W_ABS, 0, 0, DATA_ARG0_LOW],
    [JSET_K, 1, 0, CLONE_THREAD],
    [RET_K, 0, 0, retErrno(EPERM)],
    [RET_K, 0, 0, RET_ALLOW],
    [LD_W_ABS, 0, 0, DATA_NR],
  );
  program.push([JEQ_K, 0, 1, nr("clone3")], [RET_K, 0, 0, retErrno(ENOSYS)]);
  // kill(pid, ...) and tgkill(tgid, ...): only this process.
  for (const name of ["kill", "tgkill"]) {
    program.push(
      [JEQ_K, 0, 4, nr(name)],
      [LD_W_ABS, 0, 0, DATA_ARG0_LOW],
      [JEQ_K, 1, 0, pid],
      [RET_K, 0, 0, retErrno(EPERM)],
      [RET_K, 0, 0, RET_ALLOW],
      [LD_W_ABS, 0, 0, DATA_NR],
    );
  }
  // prctl(option, ...): only the options in PRCTL_ALLOWED.
  program.push(
    [JEQ_K, 0, 3 + PRCTL_ALLOWED.length, nr("prctl")],
    [LD_W_ABS, 0, 0, DATA_ARG0_LOW],
    ...PRCTL_ALLOWED.map((option, index) => [JEQ_K, PRCTL_ALLOWED.length - index, 0, option]),
    [RET_K, 0, 0, retErrno(EPERM)],
    [RET_K, 0, 0, RET_ALLOW],
    [LD_W_ABS, 0, 0, DATA_NR],
  );
  for (const name of new Set(allowed)) {
    if (["clone", "clone3", "kill", "tgkill", "prctl"].includes(name)) continue;
    // Some syscalls exist on only one architecture (e.g. x86-64 open, poll).
    if (numbers[name] == null) continue;
    program.push([JEQ_K, 0, 1, numbers[name]], [RET_K, 0, 0, RET_ALLOW]);
  }
  program.push([RET_K, 0, 0, retErrno(EPERM)]);
  return program;
}

/** Serialises a filter program into struct sock_filter[] bytes. */
export function encodeFilter(program) {
  const bytes = new DataView(new ArrayBuffer(program.length * 8));
  program.forEach(([code, jt, jf, k], index) => {
    bytes.setUint16(index * 8, code, true);
    bytes.setUint8(index * 8 + 2, jt);
    bytes.setUint8(index * 8 + 3, jf);
    bytes.setUint32(index * 8 + 4, k >>> 0, true);
  });
  return bytes.buffer;
}

const LIBC_CANDIDATES = Object.freeze([
  "libc.so.6",
  "libc.so",
  "/lib/ld-musl-x86_64.so.1",
  "/lib/ld-musl-aarch64.so.1",
]);

function openLibc() {
  for (const path of LIBC_CANDIDATES) {
    try {
      return dlopen(path, {
        syscall: { args: ["i64", "i64", "i64", "i64", "i64", "i64"], returns: "i64" },
      });
    } catch {
      // Try the next libc name (glibc, bionic, musl).
    }
  }
  return null;
}

/**
 * Installs the renderer filter on every thread of this process.
 * Never throws: returns { installed: false, reason } when the platform cannot
 * provide the sandbox, so callers can report and continue.
 */
export function installSeccomp({ arch = process.arch, pid = process.pid, allowed = ALLOWED_SYSCALLS } = {}) {
  if (process.platform !== "linux" && process.platform !== "android") {
    return { installed: false, reason: `seccomp is Linux-only (${process.platform})` };
  }
  if (!SYSCALL_NUMBERS[arch]) return { installed: false, reason: `unsupported architecture ${arch}` };
  const libc = openLibc();
  if (!libc) return { installed: false, reason: "libc not found for bun:ffi" };
  try {
    const numbers = SYSCALL_NUMBERS[arch];
    const program = buildFilter(arch, pid, allowed);
    const filter = encodeFilter(program);
    // struct sock_fprog { unsigned short len; struct sock_filter *filter; }
    const fprog = new DataView(new ArrayBuffer(16));
    fprog.setUint16(0, program.length, true);
    fprog.setBigUint64(8, BigInt(ptr(filter)), true);
    const call = libc.symbols.syscall;
    // no_new_privs lets an unprivileged process install a filter; TSYNC
    // copies it to every other thread.
    if (Number(call(numbers.prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) !== 0) {
      return { installed: false, reason: "prctl(PR_SET_NO_NEW_PRIVS) failed" };
    }
    const result = Number(call(numbers.seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, ptr(fprog.buffer), 0, 0));
    if (result !== 0) {
      return { installed: false, reason: result > 0 ? `thread ${result} could not be synchronised` : "seccomp() failed" };
    }
    return { installed: true, instructions: program.length };
  } catch (error) {
    return { installed: false, reason: String(error?.message ?? error) };
  } finally {
    libc.close();
  }
}
