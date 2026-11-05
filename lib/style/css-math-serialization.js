import {absoluteCSSNumericValue,hasRelativeCSSUnits} from './animation-numeric-values.js';

const format=value=>String(Object.is(value,-0)?0:value);
const units={length:'px',time:'s',angle:'deg',frequency:'hz',resolution:'dppx',percent:'%'};
const literal=(value,unit='')=>({kind:'literal',value,unit});

// CSS Values 4: serialize a calculation tree. Keep context-dependent leaves
// symbolic, sort numeric factors before functions, and remove only the outer
// parentheses of each function argument. Parentheses inside products/sums
// still preserve precedence. This is separate from computing their values.
export function serializeDeferredCSSMath(token) {
  const tree=expression(token);
  if(!tree)return token.source;
  return tree.kind==='function'?serialize(tree):`calc(${serialize(tree,true)})`;
}

function expression(token) {
  if(!token)return null;
  // Pure absolute subexpressions can be simplified independently of the
  // relative part. Mixed/complex dimensions remain as arithmetic nodes.
  if(!hasRelativeCSSUnits(token)) {
    const result=absoluteCSSNumericValue(token);
    const dimensions=result&&Object.entries(result.type).filter(([,power])=>power);
    if(result&&Number.isFinite(result.value)&&(!dimensions.length||dimensions.length===1&&dimensions[0][1]===1&&units[dimensions[0][0]]))
      return literal(result.value,dimensions.length?units[dimensions[0][0]]:'');
  }
  if(token.kind==='number'||token.kind==='dimension')return literal(Number(token.value),token.unit?.toLowerCase()??'');
  if(token.kind==='ident')return {kind:'ident',value:token.value.toLowerCase()};
  if(token.kind!=='function'&&token.kind!=='block')return null;
  const tokens=token.args;let at=0;
  const product=()=>{
    let value=expression(tokens[at++]);
    while(value&&['*','/'].includes(tokens[at]?.kind)) {
      const operator=tokens[at++].kind,right=expression(tokens[at++]);
      if(!right)return null;
      value=operation(operator,value,right);
    }
    return value;
  };
  const sum=()=>{
    let value=product();
    while(value&&['+','-'].includes(tokens[at]?.kind)) {
      const operator=tokens[at++].kind,right=product();
      if(!right)return null;
      value=operation(operator,value,right);
    }
    return value;
  };
  const args=[];
  while(at<tokens.length) {
    const value=sum();if(!value)return null;args.push(value);
    if(at===tokens.length)break;
    if(tokens[at++]?.kind!==','||at===tokens.length)return null;
  }
  return token.kind==='block'||token.name==='calc'?args.length===1?args[0]:null
    :{kind:'function',name:token.name,args};
}

function operation(operator,left,right) {
  if(left.kind==='literal'&&right.kind==='literal') {
    if(['+','-'].includes(operator)&&left.unit===right.unit) {
      const value=left.value+(operator==='+'?right.value:-right.value);
      if(Number.isFinite(value))return literal(value,left.unit);
    }
    if(operator==='*'&&(!left.unit||!right.unit)&&Number.isFinite(left.value*right.value))return literal(left.value*right.value,left.unit||right.unit);
    if(operator==='/'&&!right.unit&&right.value!==0&&Number.isFinite(left.value/right.value))return literal(left.value/right.value,left.unit);
  }
  // Flatten sums/products before sorting, retaining the sign/inversion of
  // each term. Division by a sum stays grouped, so a/(b+c) never becomes a/b+c.
  const kind=operator==='+'||operator==='-'?'sum':'product';
  const parts=left.kind===kind?[...left.parts]:[{node:left,inverse:false}];
  const inverse=operator==='-'||operator==='/';
  if(right.kind===kind&&!inverse)parts.push(...right.parts);
  else parts.push({node:right,inverse});
  if(kind==='sum') {
    const literals=new Map(),others=[];
    for(const part of parts) {
      const node=part.node;
      if(node.kind!=='literal') {others.push(part);continue;}
      const previous=literals.get(node.unit),signed=part.inverse?-node.value:node.value;
      // Adding an artificial +0 seed would erase the first term's -0 sign.
      const value=previous?previous.node.value+signed:signed;
      if(!Number.isFinite(value)) {others.push(part);continue;}
      literals.set(node.unit,{node:literal(value,node.unit),inverse:false});
    }
    parts.splice(0,parts.length,...literals.values(),...others);
  } else {
    let factor=1;const others=[];
    for(const part of parts) {
      const node=part.node;
      if(node.kind!=='literal'||node.unit||part.inverse&&node.value===0) {others.push(part);continue;}
      const next=part.inverse?factor/node.value:factor*node.value;
      if(!Number.isFinite(next)) {others.push(part);continue;}
      factor=next;
    }
    const dimension=others.find(part=>part.node.kind==='literal'&&!part.inverse&&Number.isFinite(part.node.value*factor));
    if(dimension)dimension.node=literal(dimension.node.value*factor,dimension.node.unit);
    else if(factor!==1||!others.length)others.unshift({node:literal(factor),inverse:false});
    parts.splice(0,parts.length,...others);
  }
  return parts.length===1&&!parts[0].inverse?parts[0].node:{kind,parts};
}

function serialize(tree,top=false) {
  // Declarations are later reparsed for computation. Unlike a browser which
  // keeps a separate internal math tree, spelling -0 as CSSOM's plain 0 would
  // lose observable sign()/division behavior. A stable arithmetic form keeps
  // that sign without introducing another declaration/source storage layer.
  if(tree.kind==='literal')return Object.is(tree.value,-0)?`(-1 * 0${tree.unit})`:`${format(tree.value)}${tree.unit}`;
  if(tree.kind==='ident')return tree.value;
  if(tree.kind==='function')return `${tree.name}(${tree.args.map(arg=>serialize(arg,true)).join(', ')})`;
  const rank=part=>part.node.kind!=='literal'?'3':!part.node.unit?'0':part.node.unit==='%'?'1':`2${part.node.unit}`;
  const parts=[...tree.parts].sort((a,b)=>rank(a)<rank(b)?-1:rank(a)>rank(b)?1:0);
  const sum=tree.kind==='sum';
  let result='';
  for(let i=0;i<parts.length;i++) {
    let {node,inverse}=parts[i];
    if(sum&&node.kind==='literal'&&node.value<0) {node={...node,value:-node.value};inverse=!inverse;}
    const text=serialize(node);
    if(!i)result=inverse?(sum?node.kind==='literal'?`-${text}`:`-1 * ${text}`:`1 / ${text}`):text;
    else result+=`${sum?inverse?' - ':' + ':inverse?' / ':' * '}${text}`;
  }
  return top?result:`(${result})`;
}
