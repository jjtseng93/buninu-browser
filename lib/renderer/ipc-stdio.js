import { readdirSync, readlinkSync } from 'node:fs';

// Android's linker caches its atrace fd before posix_spawn remaps child stdio.
// termux-exec can call dlsym between that remapping and exec, writing trace text
// into Bun's default IPC fd 3. Bun then closes the corrupted IPC channel.
// Reserve the cached trace fd as /dev/null and let Bun append IPC after it.
// Never inherit the trace handle (or unrelated parent descriptors) into a page.
export function rendererStdio(logging, {
  platform = process.platform, readdir = readdirSync, readlink = readlinkSync,
} = {}) {
  const stdio = ['ignore', logging ? 'pipe' : 'inherit', logging ? 'pipe' : 'inherit'];
  if (platform !== 'android') return stdio;
  let entries;
  try { entries = readdir('/proc/self/fd'); } catch { return stdio; }
  let lastTraceFd = 2;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const fd = Number(entry);
    if (!Number.isSafeInteger(fd) || fd < 3) continue;
    try {
      const path = readlink('/proc/self/fd/' + entry);
      if (path === '/sys/kernel/tracing/trace_marker' || path === '/sys/kernel/debug/tracing/trace_marker')
        lastTraceFd = Math.max(lastTraceFd, fd);
    } catch { /* A descriptor may close while enumerating. */ }
  }
  while (stdio.length <= lastTraceFd) stdio.push('ignore');
  return stdio;
}
