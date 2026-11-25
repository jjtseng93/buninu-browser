// Row and image lengths are in pixels. Alignment applies to each row in
// bytes, including the rows skipped before the first transferred pixel.
export const pixelStoreEnums = {
  PACK_ROW_LENGTH: 0x0d02, PACK_SKIP_ROWS: 0x0d03, PACK_SKIP_PIXELS: 0x0d04,
  UNPACK_ROW_LENGTH: 0x0cf2, UNPACK_SKIP_ROWS: 0x0cf3, UNPACK_SKIP_PIXELS: 0x0cf4,
  UNPACK_SKIP_IMAGES: 0x806d, UNPACK_IMAGE_HEIGHT: 0x806e,
};

export function pixelStoreState(webgl2, fail) {
  const pack = {alignment: 4, rowLength: 0, skipRows: 0, skipPixels: 0};
  const unpack = {...pack, imageHeight: 0, skipImages: 0};
  const fields = new Map([[0x0d05, [pack, 'alignment']], [0x0cf5, [unpack, 'alignment']]]);
  if (webgl2) {
    const e = pixelStoreEnums;
    fields.set(e.PACK_ROW_LENGTH, [pack, 'rowLength']);
    fields.set(e.PACK_SKIP_ROWS, [pack, 'skipRows']);
    fields.set(e.PACK_SKIP_PIXELS, [pack, 'skipPixels']);
    fields.set(e.UNPACK_ROW_LENGTH, [unpack, 'rowLength']);
    fields.set(e.UNPACK_SKIP_ROWS, [unpack, 'skipRows']);
    fields.set(e.UNPACK_SKIP_PIXELS, [unpack, 'skipPixels']);
    fields.set(e.UNPACK_IMAGE_HEIGHT, [unpack, 'imageHeight']);
    fields.set(e.UNPACK_SKIP_IMAGES, [unpack, 'skipImages']);
  }
  return {
    pack, unpack,
    get(key) {
      const entry = fields.get(key);
      return entry && entry[0][entry[1]];
    },
    set(key, value) {
      const entry = fields.get(key);
      if (!entry) return false;
      value = Number(value) | 0;
      if (value < 0 || (entry[1] === 'alignment' && ![1,2,4,8].includes(value))) fail(0x501);
      else entry[0][entry[1]] = value;
      return true;
    },
  };
}

export function transferRows(store, width, height, bytesPerPixel, volume = false) {
  const rowLength = store.rowLength || width;
  const imageHeight = volume ? store.imageHeight || height : height;
  if (width + store.skipPixels > rowLength || (volume && height + store.skipRows > imageHeight)) return null;
  const pitch = Math.ceil(rowLength * bytesPerPixel / store.alignment) * store.alignment;
  const slice = imageHeight * pitch;
  const start = (volume ? store.skipImages * slice : 0) + store.skipRows * pitch + store.skipPixels * bytesPerPixel;
  return {start, pitch, slice};
}
