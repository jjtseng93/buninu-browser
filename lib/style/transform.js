/** Resolve CSS affine transforms after the element's reference box is known. */
export function transformLength(value,reference){
 if(typeof value==='number')return value;
 if(value?.unit==='%')return reference*value.value/100;
 if(value?.kind==='calc')return value.px+reference*value.percent/100;
 if(value?.kind==='scale')return value.factor*transformLength(value.value,reference);
 const v=value?.values?.map(x=>transformLength(x,reference))??[];
 if(value?.kind==='sum')return v.reduce((a,b)=>a+b,0);
 if(value?.kind==='min')return Math.min(...v);
 if(value?.kind==='max')return Math.max(...v);
 return v.length?Math.max(v[0],Math.min(v[1],v[2])):0;
}
export function multiplyTransform(outer,inner){
 const {a,b=0,c=0,d,e,f}=outer,{a:A,b:B=0,c:C=0,d:D,e:E,f:F}=inner;
 return {a:a*A+c*B,b:b*A+d*B,c:a*C+c*D,d:b*C+d*D,e:a*E+c*F+e,f:b*E+d*F+f};
}
export function resolveAffine(transform,width,height){
 let matrix={a:1,b:0,c:0,d:1,e:0,f:0};
 for(const op of transform.operations){
  let next;
  if(op.kind==='translate')next={a:1,d:1,e:transformLength(op.x,width),f:transformLength(op.y,height)};
  else if(op.kind==='scale')next={a:op.x,d:op.y,e:0,f:0};
  else if(op.kind==='matrix')next=op.matrix;
  else {const clean=n=>Math.abs(n)<1e-14?0:n,cs=clean(Math.cos(op.angle)),sn=clean(Math.sin(op.angle));next={a:cs,b:sn,c:-sn,d:cs,e:0,f:0};}
  matrix=multiplyTransform(matrix,next);
 }
 return matrix;
}
