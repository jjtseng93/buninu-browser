import { parseWindowSize } from "./window-size.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBrowser } from "./headless-shell.js";
import { webkitFromArgs } from "./user-agent.js";

export function screenshotTargetUrl(input, { platform = process.platform, resolvePath = resolve, fileURL = pathToFileURL } = {}) {
  const windowsPath = platform === "win32" && (/^[a-z]:/i.test(input) || input.startsWith("\\\\") || input.startsWith("//"));
  if (windowsPath) return fileURL(resolvePath(input)).href;
  if (/^[a-z][a-z\d+.-]*:/i.test(input)) return input;
  if (input.includes("/") || input.startsWith(".") || (platform === "win32" && input.includes("\\"))) {
    return fileURL(resolvePath(input)).href;
  }
  return `https://${input}`;
}

/** Chromium-style one-shot PNG capture, using the same renderer as CDP. */
export async function runScreenshot(args) {
  const screenshot = args.find((arg) => arg === "--screenshot" || arg.startsWith("--screenshot="));
  const filename = screenshot === "--screenshot" ? "screenshot.png" : screenshot.slice("--screenshot=".length);
  const extension = filename.match(/\.(png|jpe?g|webp)$/i)?.[1]?.toLowerCase();
  if (!extension) throw new Error("--screenshot filename must end in .png, .jpg, .jpeg, or .webp");
  const format = extension === "jpg" ? "jpeg" : extension;

  const initialViewport = parseWindowSize(args);
  const waitArg = args.find((arg) => arg.startsWith("--screenshot-wait="))?.slice("--screenshot-wait=".length);
  const waitMs = waitArg === undefined ? 0 : Number(waitArg);
  if (waitArg !== undefined && (!/^\d+$/.test(waitArg) || !Number.isSafeInteger(waitMs))) {
    throw new Error("--screenshot-wait must be a nonnegative number of milliseconds");
  }


  const urlArg = args.find((arg) => !arg.startsWith("-"));
  if (!urlArg) throw new Error("--screenshot requires a URL");
  const url = screenshotTargetUrl(urlArg);

  const browser = await createBrowser({
    initialViewport,
    allowHostJs: args.includes("--dangerously-allow-host-js"),
    mobile: args.includes("--mobile"),
    webkit: webkitFromArgs(args),
    spareRenderer: false,
  });
  try {
    await browser.context.navigate(url);
    if (!browser.context.lifecycleState().includes("load")) {
      await new Promise((done) => {
        const unsubscribe = browser.context.onLifecycle((name) => {
          if (name === "load") { unsubscribe(); done(); }
        });
      });
    }
    if (waitMs) await Bun.sleep(waitMs);
    const data = await browser.context.screenshot({ format });
    await Bun.write(filename, Buffer.from(data, "base64"));
    console.error(`Screenshot saved to ${resolve(filename)}`);
  } finally {
    browser.close();
  }
}
