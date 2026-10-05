import { expect, test } from "bun:test";
import imageSize from "../lib/happy-dom/image-size-adapter.js";
import MIMEType from "../lib/happy-dom/mime-type-adapter.js";
import { parseHTMLDocument } from "../lib/happy-dom/parser.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==",
  "base64",
);

// A 2x3 PNG.
const SMALL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGP4z8AARAwoFABE0AX7pM/egAAAAABJRU5ErkJggg==";

test("MIME adapter supplies the FileReader surface without whatwg-mimetype", () => {
  expect(String(MIMEType.parse("Text/Plain; charset=UTF-8"))).toBe("text/plain");
  expect(MIMEType.parse("not a mime type")).toBeNull();
});

test("image size adapter uses Bun.Image metadata", async () => {
  expect(await imageSize(ONE_PIXEL_PNG)).toEqual({ width: 1, height: 1 });
});


test("an image whose src changes while its size is read reports only the latest image", async () => {
  const { document, window } = parseHTMLDocument("<img>");
  const image = document.querySelector("img");
  const events = [];
  image.addEventListener("load", () => events.push(`load ${image.naturalWidth}x${image.naturalHeight}`));
  image.addEventListener("error", () => events.push("error"));
  image.setAttribute("src", `data:image/png;base64,${ONE_PIXEL_PNG.toString("base64")}`);
  image.setAttribute("src", `data:image/png;base64,${SMALL_PNG}`);
  // Not complete until its size is known.
  expect(image.complete).toBeFalse();
  await Bun.sleep(100);
  expect(events).toEqual(["load 2x3"]);
  expect(image.complete).toBeTrue();
  // A removed src drops the image being read.
  image.setAttribute("src", `data:image/png;base64,${ONE_PIXEL_PNG.toString("base64")}`);
  image.removeAttribute("src");
  await Bun.sleep(100);
  expect([events.length, image.naturalWidth]).toEqual([1, 0]);
  window.happyDOM.abort();
});
