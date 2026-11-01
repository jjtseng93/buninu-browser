// Browser adapter only. All pixel composition and sampling use Land unchanged.
import {createDirectComposer, type DirectSurface} from '../../vendor/land-renderer/direct-compositor.ts';
export interface CanvasLayer {
  pixels: Uint8Array; width: number; height: number;
  x: number; y: number; drawWidth: number; drawHeight: number;
}
export class CanvasComposer {
  private surfaces: DirectSurface[] = [];
  private positions = new WeakMap<DirectSurface,{x:number;y:number}>();
  private buffers = new WeakMap<Uint8Array,NonNullable<DirectSurface["pixels"]>>();
  private base: {key:string;surface:DirectSurface} | null = null;
  private readonly direct = createDirectComposer({input:{x:0,y:0,pointer:false},wm:{
    renderSurfaces:()=>this.surfaces,origin:surface=>this.positions.get(surface)!,
  }});
  private surface(layer: CanvasLayer): DirectSurface {
    let pixels=this.buffers.get(layer.pixels);
    if(!pixels||pixels.width!==layer.width||pixels.height!==layer.height){pixels={bytes:layer.pixels,width:layer.width,height:layer.height,stride:layer.width*4,format:0};this.buffers.set(layer.pixels,pixels);}
    const surface:DirectSurface={pixels,
      scale:1,transform:0,viewportDestination:[layer.drawWidth,layer.drawHeight]};
    this.positions.set(surface,{x:layer.x,y:layer.y});
    return surface;
  }
  compose(width:number,height:number,background:readonly number[],layers:CanvasLayer[]):Uint8Array {
    const key=[width,height,...background].join('/');
    if(this.base?.key!==key){
      const pixels=new Uint8Array(width*height*4);
      // Browser RGBA and Land BGRA use identical alpha and blend operations.
      // Supplying an opaque RGBA base also hides Land's default desktop color.
      const words=new Uint32Array(pixels.buffer);
      const color=new Uint8Array([background[0]!,background[1]!,background[2]!,255]);
      words.fill(new Uint32Array(color.buffer)[0]!);
      this.base={key,surface:this.surface({pixels,width,height,x:0,y:0,drawWidth:width,drawHeight:height})};
    }
    this.surfaces=[this.base.surface,...layers.map(layer=>this.surface(layer))];
    const out=this.direct.compose(width,height);
    return new Uint8Array(out.buffer,out.byteOffset,out.byteLength);
  }
  close():void {this.direct.close();this.surfaces=[];this.base=null;this.positions=new WeakMap();this.buffers=new WeakMap();}
}
