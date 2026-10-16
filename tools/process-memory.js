import { readdir } from 'node:fs/promises';

// Android kernels may omit /proc/PID/task/PID/children. PPid in status works
// there too; return null if this platform does not expose process memory.
export async function processMemory(rootPid) {
  let entries;
  try { entries = (await readdir('/proc')).filter(name => /^\d+$/.test(name)); }
  catch { return null; }
  const records = (await Promise.all(entries.map(async name => {
    try {
      const status = await Bun.file(`/proc/${name}/status`).text();
      return { pid: Number(name), parent: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]), rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) };
    } catch { return null; }
  }))).filter(Boolean);
  const children = new Map();
  for (const record of records) {
    if (!children.has(record.parent)) children.set(record.parent, []);
    children.get(record.parent).push(record);
  }
  const root = records.find(record => record.pid === rootPid);
  if (!root) return null;
  const found = [root];
  for (let index = 0; index < found.length; index++) found.push(...(children.get(found[index].pid) ?? []));
  return found;
}

if (import.meta.main) {
  const [pid, output, seconds = '600'] = process.argv.slice(2);
  const writer = Bun.file(output).writer();
  const start = Date.now();
  while (Date.now() - start < Number(seconds) * 1000) {
    const processes = await processMemory(Number(pid));
    if (!processes) break;
    writer.write(JSON.stringify({elapsedMs:Date.now()-start,rssMiB:processes.reduce((sum,p)=>sum+p.rssKiB,0)/1024,processes})+'\n');
    writer.flush();await Bun.sleep(1000);
  }
  await writer.end();
}
