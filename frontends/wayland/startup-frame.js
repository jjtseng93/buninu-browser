import {startupFont} from './startup-font.js';

// Opaque CPU strips; no DOM, CanvasKit, fonts, timers, or animation.
// Reuse one solid strip for the rest of the window: allocation/raster is O(width).
export function startupFrame(width,height,url) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192)
    throw Error('Invalid startup frame size');
  const cols=Math.max(1,Math.floor((width-32)/9));
  const rows=Math.min(4,Math.max(0,Math.floor((height-32)/18)));
  // Escaped non-ASCII paths stay unambiguous without loading a CJK font.
  const path=String(url).replace(/[^\x20-\x7e]/gu,c=>{try{return encodeURIComponent(c)}catch{return '?'}});
  const lines=['Starting...'];
  for(let i=0;i<path.length&&lines.length<rows;i+=cols)lines.push(path.slice(i,i+cols));
  if(path.length>cols*Math.max(0,rows-1)&&lines.length>1)lines[lines.length-1]=lines.at(-1).slice(0,Math.max(0,cols-3))+'...';
  const textHeight=Math.min(height,32+Math.min(rows,lines.length)*18);
  const bytes=Buffer.allocUnsafe(width*textHeight*4);
  const pixels=new Uint32Array(bytes.buffer,bytes.byteOffset,width*textHeight);
  pixels.fill(0xff201c1b);
  for(let line=0;line<Math.min(rows,lines.length);line++) {
    for(let column=0;column<Math.min(cols,lines[line].length);column++) {
      const code=lines[line].charCodeAt(column),offset=(code-32)*36;
      for(let y=0;y<18;y++) {
        const bits=startupFont[offset+y*2]|startupFont[offset+y*2+1]<<8;
        for(let x=0;x<9;x++)if(bits&(1<<x)) {
          const px=16+column*9+x,py=16+line*18+y;
          if(px<width&&py<height)pixels[py*width+px]=0xffd8d8d8;
        }
      }
    }
  }
  const parts=[bytes];
  if(height>textHeight){
    const stripHeight=Math.min(64,height-textHeight);
    const strip=Buffer.allocUnsafe(width*stripHeight*4);
    new Uint32Array(strip.buffer,strip.byteOffset,width*stripHeight).fill(0xff201c1b);
    for(let y=textHeight;y<height;y+=stripHeight)parts.push(strip.subarray(0,width*Math.min(stripHeight,height-y)*4));
  }
  return parts;
}

export function attachStartup(window,url,report=()=>{}) {
  let active=true,painted='';
  const draw=()=>{
    const size=`${window.width}:${window.height}`;
    if(!active||!window.available||painted===size)return;
    const start=performance.now();
    const bytes=startupFrame(window.width,window.height,url);
    const raster=performance.now()-start;
    if(window.present(bytes,window.width,window.height)) {
      painted=size;
      report({width:window.width,height:window.height,rasterMs:raster,totalMs:performance.now()-start});
    }
  };
  return {draw,stop:()=>{active=false}};
}
