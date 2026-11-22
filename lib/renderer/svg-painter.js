// Shared CPU SVG painter for inline SVG and decoded SVG image resources.
import { viewportMatrix } from '../render-tree/svg-viewport.js';
const skMatrix=([a,b,c,d,e,f])=>[a,c,e,b,d,f,0,0,1];
const rgba=(kit,value,alpha=1)=>{const c=kit.parseColorString(value);c[3]*=alpha;return c;};
// A renderer owns the native paths and releases them on navigation or shutdown.
// Callers own their copy: changing its fill rule cannot affect another shape.
export class SvgPathCache {
  #paths = new Map();

  parse(kit, d) {
    if (d.length > 8192) return kit.Path.MakeFromSVGString(d);
    const cached = this.#paths.get(d);
    if (cached) return cached.copy();
    const path = kit.Path.MakeFromSVGString(d);
    if (path) {
      if (this.#paths.size >= 128) {
        const oldest = this.#paths.keys().next().value;
        this.#paths.get(oldest).delete();
        this.#paths.delete(oldest);
      }
      this.#paths.set(d, path.copy());
    }
    return path;
  }

  clear() {
    for (const path of this.#paths.values()) path.delete();
    this.#paths.clear();
  }
}

/**
 * Paints `svg` (extractSvg's shapes) into `rect`. `text`, when given, draws text shapes:
 * text.paragraph(string, style) answers a laid-out-able Paragraph for a style of {color,
 * fontFamily, fontSize, fontWeight, fontStyle}, set in the page's fonts; without it text is
 * left out (as in an SVG image's raster snapshot).
 */
export function paintSvg(kit, canvas, svg, rect, text = null, paths = null) {
  if(!(rect.width>0 && rect.height>0))return;
  const saved=canvas.getSaveCount();
  canvas.save();
  let paint;
  try {
    // An svg with overflow: visible (svg.clip false) may draw past its box, as superscripts do.
    if(svg.clip!==false)canvas.clipRect(kit.XYWHRect(rect.x,rect.y,rect.width,rect.height),kit.ClipOp.Intersect,true);
    canvas.translate(rect.x,rect.y);
    canvas.concat(skMatrix(viewportMatrix(svg.viewBox,rect.width,rect.height,svg.preserveAspectRatio)));
    paint=new kit.Paint();paint.setAntiAlias(true);
    let layers=[];
    for(const shape of svg.shapes) {
      const next=shape.layers??[];
      const opacity=next.reduce((value,layer)=>value*layer.opacity,1);
      // An invisible branch contributes nothing. Leave the active layer stack
      // alone until the next visible shape so shared ancestors still composite once.
      if(opacity===0)continue;
      let shared=0;
      while(shared<layers.length && shared<next.length && layers[shared].id===next[shared].id)shared++;
      for(let i=layers.length;i>shared;i--)canvas.restore();
      for(let i=shared;i<next.length;i++) {
        const layer=new kit.Paint();
        try {layer.setColor(rgba(kit,'white',next[i].opacity));canvas.saveLayer(layer);}
        finally {layer.delete();}
      }
      layers=next;
      if(shape.kind==='text'){if(text)paintText(kit,canvas,shape,text,opacity);continue;}
      const path=paths ? paths.parse(kit,shape.d) : kit.Path.MakeFromSVGString(shape.d);if(!path)continue;
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

// Where the top of a run's line box sits for its y, by dominant-baseline (SVG 2 §11.10.2):
// the alphabetic baseline by default, the em box's centre for central, about half the
// x-height above the baseline for middle, the top or bottom of the line for the edges.
function lineTop(baseline,y,paragraph,fontSize) {
  const ascent=paragraph.getAlphabeticBaseline(),height=paragraph.getHeight();
  switch(baseline) {
    case 'central': return y-height/2;
    case 'middle': return y+fontSize*0.25-ascent;
    case 'hanging': case 'text-before-edge': case 'text-top': return y;
    case 'text-after-edge': case 'text-bottom': case 'ideographic': return y-height;
    default: return y-ascent;
  }
}
// A text shape's runs, chunk by chunk: a run with its own x or y starts a chunk, which is
// measured whole so text-anchor can place it; the others follow on from the previous run.
function paintText(kit,canvas,shape,text,opacity) {
  const count=canvas.getSaveCount();
  canvas.save();
  const made=[];
  try {
    for(const clip of shape.clips ?? []) {
      if(clip.object)continue;
      const builder=new kit.PathBuilder();let combined;
      try {
        for(const entry of clip.paths){const part=kit.Path.MakeFromSVGString(entry.d);if(!part)continue;try{builder.addPath(part,skMatrix(entry.matrix));}finally{part.delete();}}
        builder.transform(skMatrix(clip.matrix));combined=builder.detach();
        canvas.clipPath(combined,kit.ClipOp.Intersect,true);
      } finally {combined?.delete();builder.delete();}
    }
    canvas.concat(skMatrix(shape.matrix));
    const colorOf=(run)=>{
      const c=kit.parseColorString(run.fill);
      const alpha=Math.max(0,Math.min(1,c[3]*run.opacity/(opacity||1)));
      return `rgba(${Math.round(c[0]*255)}, ${Math.round(c[1]*255)}, ${Math.round(c[2]*255)}, ${alpha})`;
    };
    let penX=0,penY=0;
    for(let start=0;start<shape.runs.length;) {
      let end=start+1;
      while(end<shape.runs.length && shape.runs[end].x==null && shape.runs[end].y==null)end++;
      const chunk=shape.runs.slice(start,end).map(run=>{
        const paragraph=text.paragraph(run.text,{color:run.fill?colorOf(run):'rgba(0, 0, 0, 0)',fontFamily:run.fontFamily,
          fontSize:run.fontSize,fontWeight:run.fontWeight,fontStyle:run.fontStyle});
        made.push(paragraph);
        paragraph.layout(1e6);
        return {run,paragraph,width:paragraph.getMaxIntrinsicWidth()};
      });
      const first=chunk[0].run;
      let x=(first.x ?? penX)+first.dx, y=(first.y ?? penY)+first.dy;
      const total=chunk.reduce((sum,piece,index)=>sum+piece.width+(index?piece.run.dx:0),0);
      const anchor=first.anchor==='middle'?-total/2:first.anchor==='end'?-total:0;
      chunk.forEach((piece,index)=>{
        if(index){x+=piece.run.dx;y+=piece.run.dy;}
        if(piece.run.fill)canvas.drawParagraph(piece.paragraph,x+anchor,lineTop(piece.run.baseline,y,piece.paragraph,piece.run.fontSize));
        x+=piece.width;
      });
      penX=x+anchor;penY=y;
      start=end;
    }
  } finally {for(const paragraph of made)paragraph.delete();canvas.restoreToCount(count);}
}
