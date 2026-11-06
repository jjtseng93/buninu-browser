// Original tiny fixtures, generated in JS rather than downloaded binary assets.
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGP4z8AARAwoFABE0AX7pM/egAAAAABJRU5ErkJggg==', 'base64');
export function bmp() {
  const bytes=Buffer.alloc(78);
  bytes.write('BM');bytes.writeUInt32LE(bytes.length,2);bytes.writeUInt32LE(54,10);
  bytes.writeUInt32LE(40,14);bytes.writeInt32LE(2,18);bytes.writeInt32LE(3,22);
  bytes.writeUInt16LE(1,26);bytes.writeUInt16LE(24,28);bytes.writeUInt32LE(24,34);
  for(let y=0;y<3;y++)for(let x=0;x<2;x++)bytes[54+y*8+x*3+2]=255;
  return bytes;
}
export function ico() {
  const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);
  header[6]=2;header[7]=3;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);
  header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
  return Buffer.concat([header,png]);
}
export const rasterFixtures = {
  png, bmp:bmp(), ico:ico(),
  gif:Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'),
  wbmp:Buffer.from([0,0,2,3,0x80,0x40,0x80]),
};
export function indexedBmp(bits=8, rle=false) {
  const palette=1<<bits, offset=54+palette*4;
  const pixels=rle?Buffer.from(bits===8?[2,1,0,0,2,1,0,0,2,1,0,0,0,1]:[2,0x11,0,0,2,0x11,0,0,2,0x11,0,0,0,1]):Buffer.alloc(12);
  if(!rle)for(let y=0;y<3;y++){pixels[y*4]=bits===8?1:bits===4?0x11:0xc0;if(bits===8)pixels[y*4+1]=1;}
  const b=Buffer.alloc(offset);b.write('BM');b.writeUInt32LE(offset+pixels.length,2);b.writeUInt32LE(offset,10);
  b.writeUInt32LE(40,14);b.writeInt32LE(2,18);b.writeInt32LE(3,22);b.writeUInt16LE(1,26);b.writeUInt16LE(bits,28);
  b.writeUInt32LE(rle?(bits===8?1:2):0,30);b.writeUInt32LE(pixels.length,34);b.writeUInt32LE(palette,46);b[54+4+2]=255;
  return Buffer.concat([b,pixels]);
}
function coreBmp(){
 const b=Buffer.alloc(50);b.write('BM');b.writeUInt32LE(50,2);b.writeUInt32LE(26,10);b.writeUInt32LE(12,14);
 b.writeUInt16LE(2,18);b.writeUInt16LE(3,20);b.writeUInt16LE(1,22);b.writeUInt16LE(24,24);
 for(let y=0;y<3;y++)for(let x=0;x<2;x++)b[26+y*8+x*3+2]=255;return b;
}
function bmp16(){
 const b=Buffer.from(bmp().subarray(0,66));b.writeUInt32LE(66,2);b.writeUInt16LE(16,28);b.writeUInt32LE(12,34);
 for(let i=54;i<66;i+=2)b.writeUInt16LE(0x7c00,i);return b;
}
function dibIcon(){
 const dib=Buffer.concat([bmp().subarray(14),Buffer.alloc(12)]);dib.writeInt32LE(6,8);
 const h=Buffer.from(ico().subarray(0,22));h.writeUInt16LE(24,12);h.writeUInt32LE(dib.length,14);return Buffer.concat([h,dib]);
}
Object.assign(rasterFixtures,{
 bmp1:indexedBmp(1),bmp4:indexedBmp(4),bmp8:indexedBmp(8),bmp16:bmp16(),
 bmpRle4:indexedBmp(4,true),bmpRle8:indexedBmp(8,true),bmpCore:coreBmp(),icoDib:dibIcon(),
});
const cur=Buffer.from(rasterFixtures.icoDib);cur.writeUInt16LE(2,2);cur.writeUInt16LE(0,10);cur.writeUInt16LE(0,12);rasterFixtures.cur=cur;
