// Two triangles may be filled as one span per row when their shared edge
// is a diagonal and their fragment output replaces the destination color.
function corners(triangle, left, top, right, bottom) {
  let mask=0;
  for (const [x,y,z] of triangle.p) {
    if ((x!==left && x!==right) || (y!==top && y!==bottom) || !(z>-1 && z<1)) return 0;
    mask |= 1 << (Number(x===right) + 2*Number(y===bottom));
  }
  return mask;
}

const FUNC_ADD=32774, SRC_ALPHA=770, ONE_MINUS_SRC_ALPHA=771;

export function fillSolidRects(bytes, width, triangles, vertices, stride, offset, blend) {
  if (offset===undefined || triangles.length%2) return false;
  // Both additive blend channels must replace the destination. Alpha-based
  // factors also require opaque source alpha, checked for every triangle.
  let opaque=false;
  if (blend) {
    if (!blend.equations.every(eq=>eq===FUNC_ADD)) return false;
    for (let i=0;i<4;i++) {
      const factor=blend.factors[i];
      if (factor===(i%2 ? 0 : 1)) continue;
      if (factor!==(i%2 ? ONE_MINUS_SRC_ALPHA : SRC_ALPHA)) return false;
      opaque=true;
    }
  }
  const rgba=new Uint8Array(4), word=new Uint32Array(rgba.buffer);
  const rects=[];
  for (let i=0;i<triangles.length;i+=2) {
    const a=triangles[i], b=triangles[i+1], [p,q,r]=a.p;
    const left=Math.min(p[0],q[0],r[0]), right=Math.max(p[0],q[0],r[0]);
    const top=Math.min(p[1],q[1],r[1]), bottom=Math.max(p[1],q[1],r[1]);
    // Leave outer edges through sample centers to the top-left coverage test.
    if ([left,right,top,bottom].some(v=>v-Math.floor(v)===.5)) return false;
    const first=corners(a,left,top,right,bottom), second=corners(b,left,top,right,bottom);
    const shared=first&second;
    if ((first|second)!==15 || (shared!==6 && shared!==9)) return false;
    const start=a.ids[0]*stride+offset;
    for (let c=0;c<4;c++) {
      const v=vertices[start+c];
      if (!Number.isFinite(v) || (opaque && c===3 && v!==1)) return false;
      for (const tri of [a,b]) for (const id of tri.ids) if (vertices[id*stride+offset+c]!==v) return false;
      rgba[c]=Math.round(Math.max(0,Math.min(1,v))*255);
    }
    // Bounds already include the viewport and scissor. Validate the whole
    // batch before writing anything so fallback cannot blend a primitive twice.
    rects.push({x0:Math.min(a.x0,b.x0),x1:Math.max(a.x1,b.x1),y0:Math.min(a.y0,b.y0),y1:Math.max(a.y1,b.y1),color:word[0]});
  }
  const pixels=new Uint32Array(bytes.buffer,bytes.byteOffset,bytes.length/4);
  for (const {x0,x1,y0,y1,color} of rects) {
    if (x0===0 && x1===width-1) {
      pixels.fill(color,y0*width,(y1+1)*width);
      continue;
    }
    for (let y=y0;y<=y1;y++) pixels.fill(color,y*width+x0,y*width+x1+1);
  }
  return true;
}
