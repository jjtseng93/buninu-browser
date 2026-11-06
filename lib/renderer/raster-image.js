// Bun is a useful header probe, not the authority on Skia's supported formats.
const MAX_PIXELS = 0x3fff * 0x3fff;
function checkSize(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_PIXELS)
    throw new Error('Image: invalid dimensions or maxPixels limit exceeded');
}

// Header bounds for formats Bun's probe does not cover. Keep these before Skia
// allocation; palette/RLE BMPs and OS/2 headers are valid even when Bun rejects them.
function checkExtraHeaders(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 26 && b.toString('ascii',0,2) === 'BM') {
    const core = b.readUInt32LE(14) === 12;
    checkSize(core ? b.readUInt16LE(18) : b.readInt32LE(18), core ? b.readUInt16LE(20) : Math.abs(b.readInt32LE(22)));
  } else if (b.length >= 6 && b.readUInt16LE(0) === 0 && [1,2].includes(b.readUInt16LE(2))) {
    const count = b.readUInt16LE(4);
    for (let i=0;i<count;i++) {
      const entry = 6+i*16;
      if (entry+16>b.length) throw new Error('Invalid icon directory');
      const offset=b.readUInt32LE(entry+12), size=b.readUInt32LE(entry+8);
      if (offset>b.length || size>b.length-offset) throw new Error('Invalid icon entry');
      // Embedded PNG or DIB can disagree with the one-byte directory dimensions.
      if (size>=24 && b.toString('ascii',offset+1,offset+4)==='PNG') checkSize(b.readUInt32BE(offset+16),b.readUInt32BE(offset+20));
      else if(size>=12) {
        const core=b.readUInt32LE(offset)===12;
        checkSize(core?b.readUInt16LE(offset+4):b.readInt32LE(offset+4),Math.abs(core?b.readUInt16LE(offset+6):b.readInt32LE(offset+8))/2);
      }
    }
  } else if (b.length >= 4 && b[0] === 0 && b[1] === 0) {
    let pos=2;
    const integer=()=>{let n=0;for(let i=0;i<5 && pos<b.length;i++){const v=b[pos++];n=n*128+(v&127);if(!(v&128))return n;}throw new Error('Invalid WBMP dimensions');};
    checkSize(integer(),integer());
  }
}

export async function probeRasterImage(bytes) {
  checkExtraHeaders(bytes);
  let metadata;
  try { metadata = await new Bun.Image(bytes).metadata(); }
  catch (error) {
    // Preserve Bun's explicit allocation guard. Codec rejection is recoverable.
    if (/maxPixels/i.test(String(error?.message))) throw error;
  }
  if (metadata) checkSize(metadata.width,metadata.height);
  return metadata;
}

export async function decodeRasterImage(kit, bytes) {
  await probeRasterImage(bytes);
  const image = kit.MakeImageFromEncoded(bytes);
  if (!image) throw new Error('Image decoding failed');
  try {
    // The decoder's dimensions are authoritative (e.g. GIF logical canvas and
    // oriented JPEG), not a different codec's interpretation of its metadata.
    const width=image.width(),height=image.height();
    checkSize(width,height);
    return {image,width,height};
  } catch (error) {image.delete();throw error;}
}
