// Shared CPU SVG painter for inline SVG and decoded SVG image resources.
import { viewportMatrix } from '../render-tree/svg-viewport.js';
const skMatrix=([a,b,c,d,e,f])=>[a,c,e,b,d,f,0,0,1];
const rgba=(kit,value,alpha=1)=>{const c=kit.parseColorString(value);c[3]*=alpha;return c;};
export function paintSvg(kit, canvas, svg, rect) {
  if(!(rect.width>0 && rect.height>0))return;
  const saved=canvas.getSaveCount();
  canvas.save();
  let paint;
  try {
    canvas.clipRect(kit.XYWHRect(rect.x,rect.y,rect.width,rect.height),kit.ClipOp.Intersect,true);
    canvas.translate(rect.x,rect.y);
    canvas.concat(skMatrix(viewportMatrix(svg.viewBox,rect.width,rect.height,svg.preserveAspectRatio)));
    paint=new kit.Paint();paint.setAntiAlias(true);
    let layers=[];
    for(const shape of svg.shapes) {
      const next=shape.layers??[];
      let shared=0;
      while(shared<layers.length && shared<next.length && layers[shared].id===next[shared].id)shared++;
      for(let i=layers.length;i>shared;i--)canvas.restore();
      for(let i=shared;i<next.length;i++) {
        const layer=new kit.Paint();
        try {layer.setColor(rgba(kit,'white',next[i].opacity));canvas.saveLayer(layer);}
        finally {layer.delete();}
      }
      layers=next;
      const opacity=layers.reduce((value,layer)=>value*layer.opacity,1);
      if(opacity===0)continue;
      const path=kit.Path.MakeFromSVGString(shape.d);if(!path)continue;
      const count=canvas.getSaveCount();
      canvas.save();
      try {
        for(const clip of shape.clips ?? []) {
          const builder=new kit.PathBuilder();
          let combined;
          try {
            for(const entry of clip.paths) {
              const part=kit.Path.MakeFromSVGString(entry.d);
              if(!part)continue;
              try {builder.addPath(part,skMatrix(entry.matrix));}
              finally {part.delete();}
            }
            if(clip.paths.some(p=>p.rule==='evenodd'))builder.setFillType(kit.FillType.EvenOdd);
            let transform=clip.matrix;
            if(clip.object) {
              const b=path.getBounds();
              const local=[b[2]-b[0],0,b[0],0,b[3]-b[1],b[1],0,0,1];
              builder.transform(kit.Matrix.multiply(skMatrix(shape.matrix),local));
            } else builder.transform(skMatrix(transform));
            combined=builder.detach();
            canvas.clipPath(combined,kit.ClipOp.Intersect,true);
          } finally {combined?.delete();builder.delete();}
        }
        canvas.concat(skMatrix(shape.matrix));
        path.setFillType(shape.fillRule==='evenodd'?kit.FillType.EvenOdd:kit.FillType.Winding);
        for(const kind of ['fill','stroke']) {
          if(!shape[kind] || !(shape[kind+'Opacity']>0) || kind==='stroke' && !(shape.strokeWidth>0))continue;
          let shader,effect;
          try {
            paint.setStyle(kind==='fill'?kit.PaintStyle.Fill:kit.PaintStyle.Stroke);
            paint.setColor(rgba(kit,typeof shape[kind]==='string'?shape[kind]:'white',shape[kind+'Opacity']/opacity));
            if(typeof shape[kind]==='object') {
              shader=gradientShader(kit,shape[kind],path.getBounds(),svg.viewBox ?? [0,0,rect.width,rect.height]);
              if(!shader)continue;
              paint.setShader(shader);
            }
            if(kind==='stroke') {
              paint.setStrokeWidth(shape.strokeWidth);
              paint.setStrokeCap({round:kit.StrokeCap.Round,square:kit.StrokeCap.Square}[shape.lineCap] ?? kit.StrokeCap.Butt);
              paint.setStrokeJoin({round:kit.StrokeJoin.Round,bevel:kit.StrokeJoin.Bevel}[shape.lineJoin] ?? kit.StrokeJoin.Miter);
              paint.setStrokeMiter(shape.miterLimit ?? 4);
              if(shape.dash?.length) {effect=kit.PathEffect.MakeDash(shape.dash,shape.dashOffset ?? 0);paint.setPathEffect(effect);}
            }
            canvas.drawPath(path,paint);
          } finally {paint.setShader(null);paint.setPathEffect(null);shader?.delete();effect?.delete();}
        }
      } finally {canvas.restoreToCount(count);path.delete();}
    }
  } finally {paint?.delete();canvas.restoreToCount(saved);}
}
function gradientShader(kit,g,bounds,viewport) {
  const object=g.units!=='userSpaceOnUse';
  const number=(value,axis,def)=>{
    value=String(value ?? def);const n=parseFloat(value);if(!Number.isFinite(n))return 0;
    return value.endsWith('%')?n/100*(object?1:axis==='x'?viewport[2]:axis==='y'?viewport[3]:Math.hypot(viewport[2],viewport[3])/Math.SQRT2):n;
  };
  if(object && (!(bounds[2]>bounds[0]) || !(bounds[3]>bounds[1])))return null;
  let matrix=skMatrix(g.transform);
  if(object)matrix=kit.Matrix.multiply([bounds[2]-bounds[0],0,bounds[0],0,bounds[3]-bounds[1],bounds[1],0,0,1],matrix);
  const colors=g.stops.map(s=>rgba(kit,s.color,s.opacity)), offsets=g.stops.map(s=>s.offset);
  if(!colors.length)return null;
  if(colors.length===1){colors.push(colors[0]);offsets[0]=0;offsets.push(1);}
  const mode={repeat:kit.TileMode.Repeat,reflect:kit.TileMode.Mirror}[g.spread] ?? kit.TileMode.Clamp;
  if(g.type==='lineargradient')return kit.Shader.MakeLinearGradient(
    [number(g.x1,'x','0%'),number(g.y1,'y','0%')],[number(g.x2,'x','100%'),number(g.y2,'y','0%')],colors,offsets,mode,matrix);
  const center=[number(g.cx,'x','50%'),number(g.cy,'y','50%')], radius=number(g.r,'r','50%');
  if(!(radius>0))return null;
  return kit.Shader.MakeTwoPointConicalGradient([number(g.fx,'x',g.cx??'50%'),number(g.fy,'y',g.cy??'50%')],0,center,radius,colors,offsets,mode,matrix);
}
