import { homedir } from "node:os";
import { join, win32 } from "node:path";

// Windows can move the Downloads known folder away from %USERPROFILE%. Query
// its registered location through PowerShell so non-ASCII paths stay UTF-8.
const WINDOWS_DOWNLOADS = [
  "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders')",
  "if ($key) { $path = $key.GetValue('{374DE290-123F-4565-9164-39C4925E467B}'); if ($path) { [Console]::Write([Environment]::ExpandEnvironmentVariables($path)) } }",
].join("; ");

function windowsDownloads() {
  try {
    const result = Bun.spawnSync({ cmd: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_DOWNLOADS],
      stdout: "pipe", stderr: "ignore" });
    return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : null;
  } catch {
    return null;
  }
}

export function downloadsDirectory({ platform = process.platform, home = homedir(), queryWindows = windowsDownloads } = {}) {
  if (platform === "win32") {
    const known = queryWindows();
    return known && win32.isAbsolute(known) ? known : win32.join(home, "Downloads");
  }
  return join(home, "Downloads");
}
