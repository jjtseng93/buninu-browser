import {test, expect} from 'bun:test';
import {loadGraphics} from '../lib/renderer/page-renderer.js';
import {visibleItems} from '../lib/paint/display-list.js';
import {rasterVideoMask,videoMaskBounds,videoMaskItems} from '../lib/renderer/video-mask.js';
const {CanvasKit:kit,builtinTypefaces}=await loadGraphics();
const width=160,height=120;
const info={width,height,colorType:kit.ColorType.RGBA_8888,alphaType:kit.AlphaType.Unpremul,colorSpace:kit.ColorSpace.SRGB};

function scene({scale=1,rect={x:15.2,y:22.4,width:57.3,height:37.2},transform,opacity=1,clip=false,rounded=false,transparent=false,shadow=false}) {
  const region={x:7.3,y:11.7,width:width/scale,height:height/scale};
  const surface=kit.MakeSurface(width,height),canvas=surface.getCanvas();
  const background=kit.Color(31,47,71,transparent?0.5:1);
  const video={rect,transform,opacity,bounds:{...rect}};
  if(transform)video.bounds={x:rect.x*transform.a+transform.e,y:rect.y*transform.d+transform.f,width:rect.width*transform.a,height:rect.height*transform.d};
  const overlays=[
    {rect:{x:18,y:29,width:26,height:12},color:kit.Color(240,33,80,0.5)},
    {rect:{x:16,y:39,width:44,height:8},color:kit.Color(250,250,250,1),text:true},
    {rect:{x:114,y:81,width:22,height:23},color:kit.Color(17,225,82,1)},
  ].map(item=>({...item,bounds:item.rect}));
  const shadowItem={op:'drawShadow',rect:{x:10,y:30,width:30,height:60},bounds:{x:-20,y:0,width:90,height:120},blur:30};
  const items=[video,...(shadow?[shadowItem]:[]),...overlays];
  let drawn=0;
  function device(rect){return kit.XYWHRect(Math.round((rect.x-region.x)*scale),Math.round((rect.y-region.y)*scale),Math.round(rect.width*scale),Math.round(rect.height*scale));}
  function paint(white,view=region){
    for(const item of videoMaskItems({items},region,view)){
      drawn++;
      const saved=canvas.save();
      const p=new kit.Paint();p.setAntiAlias(true);
      if(item===video){
        if(clip)canvas.clipRect(device({x:22.3,y:25.1,width:25.2,height:31.3}),kit.ClipOp.Intersect,true);
        if(rounded)canvas.clipRRect(kit.RRectXY(device({x:14,y:21,width:48,height:35}),9,9),kit.ClipOp.Intersect,true);
        if(transform){const {a,d,e,f}=transform;canvas.concat([a,0,((a-1)*region.x+e)*scale,0,d,((d-1)*region.y+f)*scale,0,0,1]);}
        if(opacity<1){p.setAlphaf(opacity);canvas.saveLayer(p,device(item.bounds));}
        canvas.clipRect(device(rect),kit.ClipOp.Intersect,true);
        p.setColor(white===null?kit.Color(22,173,216,1):kit.Color(white?255:0,white?255:0,white?255:0,1));
        canvas.drawRect(device(rect),p);
      }else if(item===shadowItem){
        const filter=kit.MaskFilter.MakeBlur(kit.BlurStyle.Normal,Math.round(item.blur*scale)/2,true);
        p.setMaskFilter(filter);p.setColor(kit.Color(0,0,0,1));
        canvas.clipRect(device(item.rect),kit.ClipOp.Difference,true);
        canvas.drawRect(device(item.rect),p);filter.delete();
      }else{
        p.setColor(item.color);canvas.drawRect(device(item.rect),p);
        if(item.text){
          const font=new kit.Font(builtinTypefaces[0].typeface,7);
          p.setColor(kit.Color(16,16,16,1));
          canvas.drawText('Subtitles',(item.rect.x-region.x)*scale,(item.rect.y-region.y)*scale+7,p,font);
          font.delete();
        }
      }
      p.delete();canvas.restoreToCount(saved);
    }
  }
  function normal(){canvas.clear(background);paint(null);surface.flush();const img=surface.makeImageSnapshot();try{return img.readPixels(0,0,info);}finally{img.delete();}}
  return {video,region,surface,canvas,background,paint,normal,scale,items,get drawn(){return drawn;}};
}

for(const [label,options] of Object.entries({
  shadowTail:{shadow:true,rect:{x:74,y:30,width:60,height:60}},
  basic:{}, fractional:{scale:1.75}, opacity:{opacity:.4}, clipping:{clip:true}, rounded:{rounded:true},
  partial:{rect:{x:-15,y:-6,width:58,height:65}}, transparent:{transparent:true},
  transformed:{transform:{a:1.3,d:.8,e:3.3,f:4.4}},
  transformedFractional:{scale:1.75,opacity:.6,clip:true,transform:{a:1.7,d:.7,e:-4,f:8}},
}))test(`cropped video mask is pixel-identical to full black/white passes: ${label}`,()=>{
  const s=scene(options);
  try{
    const pixels=s.normal();
    const common={kit,canvas:s.canvas,surface:s.surface,width,height,pixels,region:s.region,scale:s.scale,background:s.background,paint:s.paint};
    const reference=rasterVideoMask(common);
    s.normal();const before=s.drawn;
    const bounds=videoMaskBounds(s.video,s.region,s.scale,width,height);
    if(label==='shadowTail') {
      const dirty={x:s.region.x+(bounds.x-2)/s.scale,y:s.region.y+(bounds.y-2)/s.scale,
        width:(bounds.width+4)/s.scale,height:(bounds.height+4)/s.scale};
      expect(visibleItems({items:s.items},dirty).some(item=>item.op==='drawShadow')).toBe(false);
    }
    const actual=rasterVideoMask({...common,bounds,cullPadding:label==='shadowTail'?2:4});
    expect([...actual.base]).toEqual([...reference.base]);
    expect([...actual.mask]).toEqual([...reference.mask]);
    expect(pixels).not.toBe(actual.base);
    expect(bounds.width*bounds.height).toBeLessThan(width*height);
    if(label==='basic')expect(s.drawn-before).toBeLessThan(8);
  }finally{s.surface.dispose();}
});

test('unbounded transforms use the full pass; wholly offscreen video needs no extra raster',()=>{
  const s=scene({rect:{x:500,y:500,width:10,height:10}});
  try{
    expect(videoMaskBounds({...s.video,transform:{a:1,d:1,e:0,f:0,b:1}},s.region,1,width,height)).toBeNull();
    const pixels=s.normal(),before=s.drawn;
    const result=rasterVideoMask({kit,canvas:s.canvas,surface:s.surface,width,height,pixels,region:s.region,scale:1,background:s.background,paint:s.paint,bounds:videoMaskBounds(s.video,s.region,1,width,height)});
    expect(result.base).toEqual(pixels);expect(result.mask.some(Boolean)).toBe(false);expect(s.drawn).toBe(before);
  }finally{s.surface.dispose();}
});
