// HTML Canvas roundRect: CSS radius expansion, edge-overlap reduction and
// mirrored corners for negative dimensions. Adds to the existing path only.
export function roundRect(context,x,y,width,height,radii=0) {
 x=Number(x);y=Number(y);width=Number(width);height=Number(height);
 const list=radii===null||typeof radii!=='object'||radii&&!radii[Symbol.iterator]?[radii]:Array.from(radii);
 if(list.length<1||list.length>4)throw new RangeError('Expected one to four radii');
 let corners=list.map(value=>{
  const point=typeof value==='object'&&value!==null?{x:Number(value.x??0),y:Number(value.y??0)}:{x:Number(value),y:Number(value)};
  if(point.x<0||point.y<0)throw new RangeError('Radius must not be negative');return point;
 });
 if(![x,y,width,height,...corners.flatMap(p=>[p.x,p.y])].every(Number.isFinite))return;
 const [a,b=a,c=a,d=b]=corners;corners=[a,b,c,d];
 const flipped=(width<0)!==(height<0);
 if(width<0){x+=width;width=-width;corners=[corners[1],corners[0],corners[3],corners[2]];}
 if(height<0){y+=height;height=-height;corners=[corners[3],corners[2],corners[1],corners[0]];}
 let [tl,tr,br,bl]=corners;
 const fit=(extent,sum)=>sum>0?extent/sum:1;
 const ratio=Math.min(1,fit(width,tl.x+tr.x),fit(width,bl.x+br.x),fit(height,tl.y+bl.y),fit(height,tr.y+br.y));
 [tl,tr,br,bl]=corners.map(p=>({x:p.x*ratio,y:p.y*ratio}));
 const ellipse=(cx,cy,r,start,end)=>{
  if(!r.x||!r.y){context.lineTo(cx+Math.cos(end)*r.x,cy+Math.sin(end)*r.y);return;}
  context.ellipse(cx,cy,r.x,r.y,0,start,end,flipped);
 };
 if(!flipped){
  context.moveTo(x+tl.x,y);context.lineTo(x+width-tr.x,y);ellipse(x+width-tr.x,y+tr.y,tr,-Math.PI/2,0);
  context.lineTo(x+width,y+height-br.y);ellipse(x+width-br.x,y+height-br.y,br,0,Math.PI/2);
  context.lineTo(x+bl.x,y+height);ellipse(x+bl.x,y+height-bl.y,bl,Math.PI/2,Math.PI);
  context.lineTo(x,y+tl.y);ellipse(x+tl.x,y+tl.y,tl,Math.PI,Math.PI*1.5);
 }else{
  context.moveTo(x+tl.x,y);ellipse(x+tl.x,y+tl.y,tl,-Math.PI/2,-Math.PI);
  context.lineTo(x,y+height-bl.y);ellipse(x+bl.x,y+height-bl.y,bl,Math.PI,Math.PI/2);
  context.lineTo(x+width-br.x,y+height);ellipse(x+width-br.x,y+height-br.y,br,Math.PI/2,0);
  context.lineTo(x+width,y+tr.y);ellipse(x+width-tr.x,y+tr.y,tr,0,-Math.PI/2);
 }
 context.closePath();context.moveTo(x+tl.x,y);
}
