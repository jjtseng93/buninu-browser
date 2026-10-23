// Functions copied verbatim from jsmdcui/src/platform/clipboard.js (MIT).
// Keep command spelling, quoting and trailing-newline handling unchanged.
import { runSync } from "./clipboard-command.js";

function powershellClipboard(shell) {
  return {
    name: "powershell",
    // Get-Clipboard -Raw appends \r\n to stdout; strip exactly one trailing line ending.
    read: () => outputOrThrow(runSync([shell, "-NoProfile", "-Command", "Get-Clipboard -Raw"], {})).replace(/\r?\n$/, ""),
    write: (text) => {
      text=(text+'').replaceAll("'","''") ;
      return runSync([shell, "-NoProfile", "-Command", `Set-Clipboard '${text}'`], { stdout: "ignore" }).ok ;
    },
  };
}

function outputOrThrow(result) {
  if (!result.ok) throw new Error(result.stderr || result.stdout || "clipboard command failed");
  return result.stdout;
}

export { powershellClipboard };
