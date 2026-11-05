import CSSTextParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/utilities/CSSTextParser.ts';

// Shared inline/rule declaration tokenizer. Avoid the upstream regex splitting
// a quoted semicolon or nested function into separate declarations.
export function parseDeclarationText(input) {
  const rules=[],variables=Object.create(null),stack=[];
  let part='',quote='',colon=-1,invalid=false;
  function finish(){
    if(!invalid&&!quote&&!stack.length&&colon>0){
      const name=part.slice(0,colon).trim();
      let value=part.slice(colon+1).trim();
      const important=/!\s*important\s*$/i.test(value);
      if(important)value=value.replace(/!\s*important\s*$/i,'').trim();
      if(name&&value){rules.push({name,value,important});if(name.startsWith('--'))variables[name]=value;}
    }
    part='';colon=-1;invalid=false;
  }
  const text=String(input);
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='\\'){part+=c;if(i+1<text.length)part+=text[++i];else invalid=true;continue;}
    if(quote){part+=c;if(c===quote)quote='';else if(c==='\n'||c==='\r'){quote='';invalid=true;}continue;}
    if(c==='"'||c==="'"){quote=c;part+=c;continue;}
    if(c==='/'&&text[i+1]==='*'){const end=text.indexOf('*/',i+2);if(end<0)break;i=end+1;part+=' ';continue;}
    if('([{'.includes(c))stack.push(c);
    else if(')]}'.includes(c)&&stack.pop()!==({')':'(',']':'[','}':'{'})[c])invalid=true;
    if(c===';'&&!stack.length){finish();continue;}
    if(c===':'&&!stack.length&&colon<0)colon=part.length;
    part+=c;
  }
  finish();return {rules,variables};
}
CSSTextParser.parse=parseDeclarationText;
