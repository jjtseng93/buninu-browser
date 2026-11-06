import { createInertWindow } from '../happy-dom/parser.js';
import { StyleEngine } from '../style/computed-style.js';
import { extractSvg } from '../render-tree/svg.js';
import { paintSvg } from './svg-painter.js';
import { makeRasterSurface } from './raster-surface.js';

export function isSvgImage(response) {
  const headers=response.headers;
  const type=typeof headers?.get==='function'?headers.get('content-type'):Array.isArray(headers)?headers.find(([k])=>k.toLowerCase()==='content-type')?.[1]:headers?.['content-type'];
  if(/^image\/svg\+xml(?:;|$)/i.test(type??''))return true;
  // Image responses may omit a MIME type. XML declarations/comments can precede the root.
  const prefix=new TextDecoder().decode(response.body.subarray(0,4096));
  return /^\s*(?:<\?xml[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg(?:\s|>)/i.test(prefix);
}
export function decodeSvgImage(kit,bytes,url) {
  if(bytes.length>4*1024*1024)throw Error('SVG image exceeds 4 MiB');
  const source=new TextDecoder().decode(bytes);
  // Never evaluate scripts, load foreign objects or resolve external entities/resources.
  if(/<!ENTITY\b/i.test(source))throw Error('SVG entities are not supported');
  const window=createInertWindow(url);
  let surface;
  try {
    const document=new window.DOMParser().parseFromString(source,'image/svg+xml');
    const root=document.documentElement;
    if(root?.localName!=='svg'||root.namespaceURI!=='http://www.w3.org/2000/svg'||document.querySelector('parsererror'))throw Error('Invalid SVG image');
    if(document.querySelectorAll('*').length>10000)throw Error('SVG image element limit');
    const sheets=[...document.querySelectorAll('style')].map(node=>node.textContent);
    const styles=new StyleEngine().compute(document,sheets);
    const svg=extractSvg(root,styles.get(root)?.color??'black',styles,{image:true});
    const ratio=svg.viewBox?svg.viewBox[2]/svg.viewBox[3]:null;
    let width=svg.width,height=svg.height;
    if(width==null && height!=null && ratio)width=height*ratio;
    if(height==null && width!=null && ratio)height=width/ratio;
    if(width==null && height==null && ratio){width=Math.min(300,150*ratio);height=width/ratio;}
    width??=300;height??=150;
    if(!(width>0 && height>0) || !Number.isFinite(width+height))throw Error('Invalid SVG dimensions');
    width=Math.ceil(width);height=Math.ceil(height);
    if(width>16384||height>16384||width*height>16*1024*1024)throw Error('SVG image pixel limit');
    surface=makeRasterSurface(kit,width,height);
    if(!surface)throw Error('Cannot allocate SVG image');
    paintSvg(kit,surface.getCanvas(),svg,{x:0,y:0,width,height});
    surface.flush();
    const image=surface.makeImageSnapshot();
    if(!image)throw Error('Cannot snapshot SVG image');
    return {image,width,height,svg};
  } finally {surface?.dispose();window.happyDOM.abort();}
}
