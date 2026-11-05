import {trimCSSWhitespace} from '../style/css-value-tokens.js';
import CSSTextParser from '../../vendor/happy-dom/packages/happy-dom/src/css/declaration/utilities/CSSTextParser.ts';

// Shared inline/rule declaration tokenizer. Avoid the upstream regex splitting
// a quoted semicolon or nested function into separate declarations.
export function parseDeclarationText(input) {
  const rules=[],variables=Object.create(null),stack=[];
  let part='',quote='',colon=-1,invalid=false,atRule=false;
  function finish(){
    if(!atRule&&!invalid&&!quote&&!stack.length&&colon>0){
      const name=trimCSSWhitespace(part.slice(0,colon));
      let value=trimCSSWhitespace(part.slice(colon+1));
      const important=/![ \t\n\r\f]*important[ \t\n\r\f]*$/i.test(value);
      if(important)value=trimCSSWhitespace(value.replace(/![ \t\n\r\f]*important[ \t\n\r\f]*$/i,''));
      if(name&&value){rules.push({name,value,important});if(name.startsWith('--'))variables[name]=value;}
    }
    part='';colon=-1;invalid=false;atRule=false;
  }
  const text=String(input);
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='\\'){part+=c;if(i+1<text.length)part+=text[++i];else invalid=true;continue;}
    if(quote){part+=c;if(c===quote)quote='';else if(c==='\n'||c==='\r'){quote='';invalid=true;}continue;}
    if(c==='"'||c==="'"){quote=c;part+=c;continue;}
    if(c==='/'&&text[i+1]==='*'){const end=text.indexOf('*/',i+2);if(end<0)break;i=end+1;part+=' ';continue;}
    // At-rules in a declaration block are discarded as complete rules. Their
    // closing brace is a boundary even without a semicolon; consuming until
    // the next semicolon would swallow the following valid declaration.
    if(c==='@'&&!/[^ \t\n\r\f]/.test(part)&&startsIdentifier(text,i+1))atRule=true;
    const endsAtRule=atRule&&c==='}'&&stack.length===1&&stack[0]==='{';
    if('([{'.includes(c))stack.push(c);
    else if(')]}'.includes(c)){
      if(stack.at(-1)===({')':'(',']':'[','}':'{'})[c])stack.pop();
      else invalid=true;
    }
    if(endsAtRule||(c===';'&&!stack.length)){finish();continue;}
    if(c===':'&&!stack.length&&colon<0)colon=part.length;
    part+=c;
  }
  finish();return {rules,variables};
}
CSSTextParser.parse=parseDeclarationText;

function startsIdentifier(text,index) {
  const start=c=>c!==undefined&&(/[a-z_]/i.test(c)||c.charCodeAt(0)>=0x80);
  const escape=i=>text[i]==='\\'&&text[i+1]!==undefined&&!/[\n\r\f]/.test(text[i+1]);
  return start(text[index])||escape(index)||text[index]==='-'&&
    (text[index+1]==='-'||start(text[index+1])||escape(index+1));
}
