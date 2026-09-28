import { expect, test } from "bun:test";
import imageSize from "../lib/happy-dom/image-size-adapter.js";
import MIMEType from "../lib/happy-dom/mime-type-adapter.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==",
  "base64",
);

test("MIME adapter supplies the FileReader surface without whatwg-mimetype", () => {
  expect(String(MIMEType.parse("Text/Plain; charset=UTF-8"))).toBe("text/plain");
  expect(MIMEType.parse("not a mime type")).toBeNull();
});

test("image size adapter uses Bun.Image metadata", async () => {
  expect(await imageSize(ONE_PIXEL_PNG)).toEqual({ width: 1, height: 1 });
});

