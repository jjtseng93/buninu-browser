// Viewporter coordinates follow buffer transform, then integer buffer scale.
export function surfaceViewport(surface) {
  const b=surface.pixels;
  if(!b)return null;
  const rotated=surface.transform&1;
  const width=(rotated?b.height:b.width)/surface.scale;
  const height=(rotated?b.width:b.height)/surface.scale;
  const source=surface.viewportSource??[0,0,width,height];
  const destination=surface.viewportDestination??source.slice(2);
  return {source,width:destination[0],height:destination[1]};
}
export function validateViewport(surface) {
  const source=surface.viewportSource,destination=surface.viewportDestination;
  if(source&&!destination&&(!Number.isInteger(source[2])||!Number.isInteger(source[3])))throw Error('Viewport source size must be integral without destination');
  if(!surface.pixels||!source)return;
  const b=surface.pixels,rotated=surface.transform&1;
  if(source[0]+source[2]>(rotated?b.height:b.width)/surface.scale||source[1]+source[3]>(rotated?b.width:b.height)/surface.scale)throw Error('Viewport source outside buffer');
}
