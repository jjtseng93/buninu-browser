// Adapter for jsmdcui's unchanged PowerShell clipboard functions.
export function runSync(command, options = {}) {
  try {
    const p = Bun.spawnSync(command, {
      stdin: options.stdin == null ? 'ignore' : Buffer.from(options.stdin),
      stdout: options.stdout ?? 'pipe', stderr: 'pipe', timeout: options.timeout ?? 2000,
    });
    return {ok:p.success, stdout:p.stdout?.toString() ?? '', stderr:p.stderr?.toString() ?? ''};
  } catch (error) { return {ok:false, stdout:'', stderr:String(error)}; }
}
