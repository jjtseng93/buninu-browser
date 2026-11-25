// RuntimeEffect targets SkSL ES 1.00. Lower integer operators while keeping
// GLSL operand evaluation and precedence, including nested calls/subscripts.
const operators = {
  '%': ['rem', 11], '<<': ['shl', 9], '>>': ['shr', 9],
  '&': ['and', 6], '^': ['xor', 5], '|': ['or', 4],
};
const precedence = {
  '*':11, '/':11, '+':10, '-':10, '<':8, '>':8, '<=':8, '>=':8,
  '==':7, '!=':7, '&&':3, '^^':2, '||':1,
};
const boundary = new Set(['{','}',';',',','?',':','=','+=','-=','*=','/=','return','case']);

export function lowerIntegers(code) {
  if (!/(?:%(?!=)|<<|>>|(?<!&)&(?!&)|(?<!\|)\|(?!\|)|(?<!\^)\^(?!\^))/.test(code)) return code;
  const pattern = /[A-Za-z_]\w*|(?:\d*\.\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?[uUfF]?|<<=?|>>=?|&&|\|\||\^\^|\+\+|--|[=!<>+*/%&|^-]=|[^\s]/g;
  const tokens = Array.from(code.matchAll(pattern), m=>({text:m[0],start:m.index,end:m.index+m[0].length}));
  const rank = s => Object.hasOwn(operators,s)?operators[s][1]:Object.hasOwn(precedence,s)?precedence[s]:undefined;
  const used = new Set();
  function extent(index, step, priority) {
    let depth=0, i=index+step;
    for(;i>=0&&i<tokens.length;i+=step){
      const s=tokens[i].text;
      if(step===1 ? s==='('||s==='[' : s===')'||s===']'){ depth++; continue; }
      if(step===1 ? s===')'||s===']' : s==='('||s==='['){ if(!depth)break; depth--; continue; }
      if(depth)continue;
      if(boundary.has(s))break;
      const p=rank(s);
      if((s==='+'||s==='-')&&(i===0||rank(tokens[i-1].text)!==undefined||['(',',','[','=','!','return'].includes(tokens[i-1].text)))continue;
      if(p<priority||p===priority&&step===1)break;
    }
    return i-step;
  }
  // Fold a nested operation before its containing expression. Keep offsets
  // into the original source; only replaced tokens need new spellings.
  function spelling(from,to) {
    let out=tokens[from].text;
    for(let i=from+1;i<=to;i++)out+=code.slice(tokens[i-1].end,tokens[i].start)+tokens[i].text;
    return out;
  }
  for(;;){
    let best=-1,score=-1,depth=0;
    for(let i=0;i<tokens.length;i++){
      const s=tokens[i].text;
      if(s==='('||s==='[')depth++;
      if(s===')'||s===']')depth--;
      if(Object.hasOwn(operators,s)){
        const priority=depth*16+operators[s][1];
        if(priority>score){score=priority;best=i;}
      }
    }
    if(best<0)break;
    const [name,p]=operators[tokens[best].text],a=extent(best,-1,p),b=extent(best,1,p);
    if(a>=best||b<=best)throw Error('Missing integer operator operand');
    let helper=name, argument=spelling(best+1,b);
    const literal=/^\d+$/.test(argument)?Number(argument):-1;
    if(name==='and'&&literal>=0&&literal<0x3fffffff&&(literal&(literal+1))===0){
      helper='lowbits';argument=String(literal+1);
    }else if(name==='shr'&&literal>=0&&literal<31){
      helper='floorDiv';argument=String(2**literal);
    }
    const text='_sw_'+helper+'('+spelling(a,best-1)+','+argument+')';
    used.add(helper);tokens.splice(a,b-a+1,{text,start:tokens[a].start,end:tokens[b].end});
  }
  let declarations='';
  for(const name of used){
    let body;
    if(name==='lowbits')body='int r=a-(a/b)*b;return r<0?r+b:r;';
    else if(name==='floorDiv')body='int q=a/b;return q-(a<q*b?1:0);';
    else if(name==='rem')body='return a-(a/b)*b;';
    else if(name==='shr'||name==='shl'){
      body='for(int k=0;k<32;k++){if(k>=b)break;'+(name==='shr'?'int n=a/2;a=n-(a<2*n?1:0);':'a=a+a;')+'}return a;';
    }else{
      const bit=name==='and'?'x*y':name==='or'?'(x>y?x:y)':'(x==y?0:1)';
      body='int sum=0;int weight=1;for(int k=0;k<32;k++){int an=a/2;int bn=b/2;int x=a!=2*an?1:0;int y=b!=2*bn?1:0;a=an-(a<2*an?1:0);b=bn-(b<2*bn?1:0);sum+='+bit+'*weight;if(k<31)weight+=weight;}return sum;';
    }
    declarations+='int _sw_'+name+'(int a,int b){'+body+'}\n';
  }
  return declarations+code.slice(0,tokens[0].start)+spelling(0,tokens.length-1)+code.slice(tokens.at(-1).end);
}
