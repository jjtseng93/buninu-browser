/**
 * A reusable native readback buffer and immutable JavaScript pixel snapshots.
 * Shared snapshots cross the renderer/compositor worker boundary without
 * copying another full raster tile. Each snapshot owns its buffer: encoding
 * an old frame can safely overlap painting the next one.
 */
export class RasterReadback {
  #kit;
  #shared;
  #scratch = null;
  #allocate;

  constructor(kit, { shared = false, allocate = null } = {}) {
    this.#kit = kit;
    this.#shared = shared;
    this.#allocate = allocate;
  }

  read(image, width, height) {
    const kit = this.#kit;
    const bytes = width * height * 4;
    if (!this.#scratch || this.#scratch.length < bytes) {
      this.dispose();
      this.#scratch = kit.Malloc(Uint8Array, bytes);
    }
    const native = image.readPixels(0, 0, {
      width, height, colorType: kit.ColorType.RGBA_8888,
      alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB,
    }, this.#scratch, width * 4);
    if (!native) throw new Error("Unable to read raster pixels");
    const pixels = this.#allocate ? this.#allocate(bytes)
      : new Uint8Array(this.#shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
    pixels.set(native.subarray(0, bytes));
    return pixels;
  }

  dispose() {
    if (this.#scratch) this.#kit.Free(this.#scratch);
    this.#scratch = null;
  }
}
