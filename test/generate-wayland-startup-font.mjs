// Development-only atlas generator. Its output replaces startup-font.js base64.
import {loadGraphics} from '../lib/renderer/page-renderer.js';
const {CanvasKit:k}=await loadGraphics();
const face=k.Typeface.MakeFreeTypeFaceFromData(await Bun.file(new URL('../usr/share/fonts/DejaVuSansMono.ttf',import.meta.url)).arrayBuffer());
const font=new k.Font(face,14),paint=new k.Paint();paint.setColor(k.WHITE);paint.setAntiAlias(false);
const w=9,h=18,bytes=[];
const surface=k.MakeSurface(w,h),c=surface.getCanvas();
for(let code=32;code<127;code++){
 c.clear(k.BLACK);c.drawText(String.fromCharCode(code),0,14,paint,font);surface.flush();
 const im=surface.makeImageSnapshot();const pixels=im.readPixels(0,0,{width:w,height:h,colorType:k.ColorType.RGBA_8888,alphaType:k.AlphaType.Unpremul,colorSpace:k.ColorSpace.SRGB});
 for(let y=0;y<h;y++){let row=0;for(let x=0;x<w;x++)if(pixels[(y*w+x)*4]>127)row|=1<<x;bytes.push(row&255,row>>8)}im.delete();
}
console.log(Buffer.from(bytes).toString('base64'));
font.delete();face.delete();paint.delete();surface.delete();process.exit(0);
