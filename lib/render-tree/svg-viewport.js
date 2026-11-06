export function viewportMatrix(box, width, height, aspect = 'xMidYMid meet') {
  const [x,y,w,h] = box ?? [0,0,width,height];
  let sx=width/w, sy=height/h, dx=0, dy=0;
  const [align,mode] = String(aspect).trim().replace(/^defer\s+/,'').split(/\s+/);
  if(align !== 'none') {
    sx=sy=(mode==='slice'?Math.max:Math.min)(sx,sy);
    dx=(width-w*sx)*(align?.includes('xMax')?1:align?.includes('xMin')?0:.5);
    dy=(height-h*sy)*(align?.includes('YMax')?1:align?.includes('YMin')?0:.5);
  }
  return [sx,0,0,sy,dx-x*sx,dy-y*sy];
}
