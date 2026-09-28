/**
 * Optional diagnostic log file, enabled by the BUNINU_LOG environment
 * variable, for frontends such as casty that swallow the browser's stderr.
 *
 *   BUNINU_LOG=1 (or "true")  append to ./buninu-browser.log in the working directory
 *   BUNINU_LOG=/some/path     append to that file
 *
 * Only the controller writes the file. Renderers have no environment and
 * cannot open files under seccomp, so their stdout and stderr are piped to
 * the controller, which copies them into the log.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatWithOptions } from "node:util";

export const LOG_ENV = "BUNINU_LOG";
export const DEFAULT_LOG_FILE = "buninu-browser.log";
/** Tells a renderer that its output is logged, so it also echoes page console messages. */
export const RENDERER_LOG_FLAG = "--buninu-log";

let logPath = null;

/** The log file BUNINU_LOG asks for, or null when logging is off. */
export function logFileFromEnv(env = process.env, cwd = process.cwd()) {
  const value = env[LOG_ENV]?.trim();
  if (!value || ["0", "false", "off", "no"].includes(value.toLowerCase())) return null;
  if (["1", "true", "on", "yes"].includes(value.toLowerCase())) return resolve(cwd, DEFAULT_LOG_FILE);
  return resolve(cwd, value);
}

/** Starts logging to `path`: console output of this process is copied into the file. */
export function installLog(path) {
  if (!path || logPath) return;
  logPath = path;
  for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      writeLog(level, formatWithOptions({ colors: false }, ...args));
    };
  }
  writeLog("log", `started pid ${process.pid}, bun ${Bun.version}, cwd ${process.cwd()}, args ${JSON.stringify(Bun.argv.slice(2))}`);
}

export function logEnabled() {
  return logPath !== null;
}

/** Appends text to the log, one timestamped line per line of text. */
export function writeLog(source, text) {
  if (!logPath) return;
  const stamp = new Date().toISOString();
  const lines = String(text).replace(/\n+$/, "").split("\n").map((line) => `${stamp} [${source}] ${line}`);
  try {
    appendFileSync(logPath, `${lines.join("\n")}\n`);
  } catch {
    // Logging must never break the browser.
  }
}

/**
 * Copies a child's output stream to `echo` and into the log, line by line.
 * @param {ReadableStream<Uint8Array>} stream
 * @param {string} source
 * @param {(chunk: Uint8Array) => void} echo
 */
export async function pipeToLog(stream, source, echo) {
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for await (const chunk of stream) {
      echo(chunk);
      pending += decoder.decode(chunk, { stream: true });
      const end = pending.lastIndexOf("\n");
      if (end >= 0) {
        writeLog(source, pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    }
  } catch {
    // The child went away mid-read.
  }
  pending += decoder.decode();
  if (pending) writeLog(source, pending);
}
