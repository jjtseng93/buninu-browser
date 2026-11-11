import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function cliTargetUrl(input, { platform = process.platform, resolvePath = resolve, fileURL = pathToFileURL } = {}) {
  const windowsPath = platform === "win32" && (/^[a-z]:/i.test(input) || input.startsWith("\\\\") || input.startsWith("//"));
  if (windowsPath) return fileURL(resolvePath(input)).href;
  if (/^[a-z][a-z\d+.-]*:/i.test(input)) return input;
  if (input.includes("/") || input.startsWith(".") || (platform === "win32" && input.includes("\\"))) {
    return fileURL(resolvePath(input)).href;
  }
  return `https://${input}`;
}

