import {parseCSSComponentValues as components} from './css-value-tokens.js';
import {absoluteCSSNumericValue} from './animation-numeric-values.js';

const presets={ease:[.25,.1,.25,1],'ease-in':[.42,0,1,1],'ease-out':[0,0,.58,1],'ease-in-out':[.42,0,.58,1]};
const positions=new Set(['start','end','jump-start','jump-end','jump-both','jump-none']);
const relative=/^(?:r?(?:em|ex|cap|ch|ic|lh)|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))$/;
const format=n=>String(Object.is(n,-0)?0:n);
const finite=n=>Number.isNaN(n)?0:Math.max(-3.4028234663852886e38,Math.min(3.4028234663852886e38,n));

function numeric(token,style) {
  if(!token||!['number','dimension','function'].includes(token.kind))return null;
  let unresolved=false;
  const map=t=>{
    if(t.kind==='dimension'&&relative.test(t.unit.toLowerCase())) {
      const scale=t.unit.toLowerCase()==='em'?style?.fontSize:undefined;
      if(!Number.isFinite(scale))unresolved=true;
      return {...t,unit:'px',value:String(Number(t.value)*(scale??1))};
    }
    // Preserve valid context-dependent expressions until a resolver exists.
    // This does not invent a sibling index or advertise a new animation API.
    if(t.kind==='function'&&['sibling-index','sibling-count'].includes(t.name)&&!t.args.length) {
      unresolved=true;return {kind:'number',value:'1'};
    }
    return t.args?{...t,args:t.args.map(map)}:t;
  };
  const result=absoluteCSSNumericValue(map(token));
  if(!result)return null;
  return {...result,unresolved,math:token.kind==='function',source:token.source};
}
function number(token,style) {
  const result=numeric(token,style);
  return result&&!Object.values(result.type).some(Boolean)?result:null;
}
function linearSyntax(tokens) {
  let numbers=0,percentages=0;
  for(const token of [...tokens,{kind:','}]) {
    if(token.kind===',') {
      if(numbers!==1)return false;
      numbers=percentages=0;continue;
    }
    const result=numeric(token),type=result&&Object.entries(result.type).filter(([,power])=>power);
    if(!type)return false;
    if(!type.length){if(++numbers>1)return false;}
    else if(type.length!==1||type[0][0]!=='percent'||type[0][1]!==1||++percentages>2)return false;
  }
  return true;
}
function specifiedNumber(value) {
  if(value.unresolved)return value.source;
  const n=value.value,text=Number.isFinite(n)?format(n):Number.isNaN(n)?'NaN':n<0?'-infinity':'infinity';
  return value.math?`calc(${text})`:format(finite(n));
}

function easing(token,computed=false,style) {
  if(token.kind==='ident') {
    const name=token.value.toLowerCase();
    if(name==='linear')return {kind:'linear',text:name};
    if(presets[name])return {kind:'bezier',points:presets[name],text:name};
    if(name==='step-start'||name==='step-end')return {kind:'steps',count:1,position:name==='step-start'?'start':'end',text:name==='step-start'?'steps(1, start)':'steps(1)'};
    return null;
  }
  if(token.kind!=='function')return null;
  if(token.name==='steps') {
    const args=token.args;
    if(args.length!==1&&(args.length!==3||args[1].kind!==','||args[2].kind!=='ident'))return null;
    const position=args[2]?.value.toLowerCase()??'end';
    if(!positions.has(position))return null;
    const n=number(args[0],computed?style:undefined),minimum=position==='jump-none'?2:1;
    if(!n||!n.math&&(!/^[+-]?\d+$/.test(args[0].value)||n.value<minimum)||Number.isNaN(n.value)&&position==='jump-none')return null;
    const count=Math.min(2147483647,Math.max(minimum,Math.floor(finite(n.value)+.5)));
    // CSS integers must not serialize as exponent number tokens. Limit huge
    // literal counts to our integer range while preserving deferred math.
    const text=!n.math||computed&&!n.unresolved?format(count):specifiedNumber(n);
    return {kind:n.unresolved?'unresolved':'steps',count,position,text:`steps(${text}${position==='end'||position==='jump-end'?'':`, ${position}`})`};
  }
  if(token.name==='cubic-bezier') {
    const args=token.args;if(args.length!==7||args.some((t,i)=>i%2&&t.kind!==','))return null;
    const nums=[0,2,4,6].map(i=>number(args[i],computed?style:undefined));
    if(nums.some(n=>!n)||[0,2].some(i=>!nums[i].math&&(nums[i].value<0||nums[i].value>1)))return null;
    const unresolved=nums.some(n=>n.unresolved);
    const points=nums.map((n,i)=>i===0||i===2?Math.max(0,Math.min(1,finite(n.value))):finite(n.value));
    return {kind:unresolved?'unresolved':'bezier',points,text:`cubic-bezier(${nums.map((n,i)=>computed&&!n.unresolved?format(points[i]):specifiedNumber(n)).join(', ')})`};
  }
  // Keep existing linear() storage without claiming piecewise interpolation.
  // Still reject malformed arguments instead of advertising linear(garbage).
  if(token.name==='linear'&&linearSyntax(token.args))return {kind:'unresolved',text:token.source};
  return null;
}

export function easingToken(token) {return easing(token)?.text??null;}
const computedCache=new Map();
export function computedEasing(value,style) {
  value=String(value??'ease');
  const key=`${style?.fontSize??''}\0${value}`;
  if(computedCache.has(key))return computedCache.get(key);
  const parsed=components(value);
  const result=parsed?.tokens.length===1?easing(parsed.tokens[0],true,style)?.text??value:value;
  if(computedCache.size>=128)computedCache.delete(computedCache.keys().next().value);
  computedCache.set(key,result);return result;
}

// A bounded cache avoids reparsing a stable timing function every animation
// sample. It owns strings and numeric descriptors only, never DOM objects.
const cache=new Map();
export function sampleEasing(progress,value,before=false) {
  value=String(value??'ease');
  let curve=cache.get(value);
  if(!curve) {
    const parsed=components(value);curve=parsed?.tokens.length===1?easing(parsed.tokens[0],true):null;
    curve??={kind:'unresolved'};
    if(cache.size>=128)cache.delete(cache.keys().next().value);
    cache.set(value,curve);
  }
  if(curve.kind==='steps') {
    const {count,position}=curve,jumps=count+(position==='jump-both'?1:position==='jump-none'?-1:0);
    const scaled=progress*count;
    let step=Math.floor(scaled)+(['start','jump-start','jump-both'].includes(position)?1:0);
    if(before&&Number.isInteger(scaled))step--;
    if(progress>=0)step=Math.max(0,step);
    if(progress<=1)step=Math.min(jumps,step);
    return step/jumps;
  }
  if(progress<=0)return 0;if(progress>=1)return 1;
  if(curve.kind!=='bezier')return progress;
  const [x1,y1,x2,y2]=curve.points,at=(t,a,b)=>3*(1-t)**2*t*a+3*(1-t)*t*t*b+t**3;
  let low=0,high=1;
  for(let n=0;n<16;n++){const middle=(low+high)/2;if(at(middle,x1,x2)<progress)low=middle;else high=middle;}
  return at((low+high)/2,y1,y2);
}
