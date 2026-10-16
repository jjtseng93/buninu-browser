import { expect, test } from "bun:test";
import { createPageRenderer, loadGraphics } from "../lib/renderer/page-renderer.js";

test("scroll paints reuse shaped text, evict bounded resources, and release paragraphs on navigation/disposal", async () => {
  const { CanvasKit } = await loadGraphics();
  const original = CanvasKit.ParagraphBuilder.MakeFromFontCollection;
  let built = 0;
  let alive = 0;
  CanvasKit.ParagraphBuilder.MakeFromFontCollection = (...args) => {
    const builder = original(...args);
    const build = builder.build.bind(builder);
    builder.build = () => {
      const paragraph = build();
      const dispose = paragraph.delete.bind(paragraph);
      built++;
      alive++;
      paragraph.delete = () => { alive--; dispose(); };
      return paragraph;
    };
    return builder;
  };
  let renderer;
  try {
    renderer = await createPageRenderer({ fetchResource: async url => ({ ok: false, status: 404, url, body: new Uint8Array() }) });
    renderer.resize(400, 200, 1);
    await renderer.loadDocument({ url: "https://paint.test/", status: 200, contentType: "text/html",
      source: `<!doctype html><style>body { margin:0 } p { margin:0; height:30px }</style>${
        Array.from({ length: 400 }, (_, i) => `<p>Article number ${i}: shared text</p>`).join("")}` });
    await renderer.whenLoaded();
    const first = await renderer.screenshot();
    const before = built;
    renderer.scroll(0, 1);
    await renderer.screenshot();
    // No layout invalidation and the same seven visible paragraph items.
    expect(built - before).toBeLessThanOrEqual(1);
    renderer.scroll(0, -1);
    expect(await renderer.screenshot()).toBe(first);
    // A fresh layout/display list still uses identical text shaping inputs.
    const beforeLayout = built;
    renderer.resize(400, 201, 1);
    await renderer.screenshot();
    expect(built - beforeLayout).toBeLessThanOrEqual(1);
    renderer.resize(400, 200, 1);
    expect(await renderer.screenshot()).toBe(first);

    for (let i = 0; i < 40; i++) renderer.scroll(0, 250);
    expect(alive).toBeGreaterThan(0);
    expect(alive).toBeLessThanOrEqual(256);
    renderer.resize(400, 200, 2);
    const zoomed = await renderer.screenshot();
    expect((await new Bun.Image(Buffer.from(zoomed, "base64")).metadata()).width).toBe(800);
    await renderer.loadDocument({ url: "https://paint.test/empty", status: 200, contentType: "text/html", source: "<!doctype html><body></body>" });
    await renderer.whenLoaded();
    expect(alive).toBe(0);
  } finally {
    renderer?.dispose();
    CanvasKit.ParagraphBuilder.MakeFromFontCollection = original;
  }
  expect(alive).toBe(0);
});

test("screenshot encoding options are honored and separated in the frame cache", async () => {
  const { CanvasKit: kit } = await loadGraphics();
  const renderer = await createPageRenderer({});
  const images = [];
  try {
    renderer.resize(400, 200, 1);
    await renderer.loadDocument({ url: "https://capture.test/", contentType: "text/html",
      source: "<body style='margin:0;color:#256;background:#def'><h1>Frame format cache</h1><p>Lossless PNG and JPEG capture</p>" });
    await renderer.whenLoaded();
    const png = await renderer.screenshot();
    const jpeg = await renderer.screenshot({ format: "jpeg", quality: 85 });
    expect((await new Bun.Image(Buffer.from(jpeg, "base64")).metadata()).format).toBe("jpeg");
    const fast = await renderer.screenshot({ optimizeForSpeed: true });
    const pixelBytes = value => {
      const image = kit.MakeImageFromEncoded(Buffer.from(value, "base64"));
      images.push(image);
      return image.readPixels(0, 0, { width: 400, height: 200, colorType: kit.ColorType.RGBA_8888,
        alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    };
    expect(pixelBytes(fast)).toEqual(pixelBytes(png));
    expect(await renderer.screenshot()).toBe(png);
  } finally {
    for (const image of images) image.delete();
    renderer.dispose();
  }
});
