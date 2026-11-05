import * as symbols from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// Keep rule boundaries independent of braces/semicolons in CSS strings, URLs,
// comments and escapes. The existing declaration parser still parses properties.
function chunks(source) {
  const result=[];let start=0,open=-1,depth=0,paren=0,bracket=0,quote='';
  for(let i=0;i<source.length;i++) {
    const c=source[i];
    if(c==='\\'){i++;continue;}
    if(quote){if(c===quote)quote='';continue;}
    if(c==='"'||c==="'"){quote=c;continue;}
    if(c==='/'&&source[i+1]==='*'){const end=source.indexOf('*/',i+2);if(end<0)break;i=end+1;continue;}
    if(c==='(')paren++;else if(c===')')paren=Math.max(0,paren-1);
    if(c==='[')bracket++;else if(c===']')bracket=Math.max(0,bracket-1);
    if(paren||bracket)continue;
    if(c==='{'){if(depth++===0)open=i;}
    else if(c==='}'&&depth&&--depth===0){result.push({prelude:source.slice(start,open).trim(),body:source.slice(open+1,i)});start=i+1;open=-1;}
    else if(c===';'&&!depth){result.push({prelude:source.slice(start,i).trim(),body:null});start=i+1;}
  }
  if(open>=0&&!quote)result.push({prelude:source.slice(start,open).trim(),body:source.slice(open+1)});
  return result;
}

function stripComments(text) {
  let result='',quote='';
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='\\'){result+=c;if(i+1<text.length)result+=text[++i];continue;}
    if(quote){result+=c;if(c===quote)quote='';continue;}
    if(c==='"'||c==="'"){quote=c;result+=c;continue;}
    if(c==='/'&&text[i+1]==='*'){const end=text.indexOf('*/',i+2);if(end<0)break;i=end+1;result+=' ';continue;}
    result+=c;
  }
  return result;
}

export function parseCSSOMRules(window, text, sheet, parent=null, depth=0) {
  if(depth>128)return [];
  const rules=[];
  for(const {prelude:original,body} of chunks(String(text))) {
    const prelude=stripComments(original).trim();
    if(!prelude)continue;
    const at=/^@([\w-]+)\b\s*([\s\S]*)$/.exec(prelude);
    const name=at?.[1].toLowerCase(),condition=at?.[2]??'';
    const type=at ? ({media:4,supports:12,layer:body===null?17:16,'font-face':5,page:6,keyframes:7,'-webkit-keyframes':7,import:3,namespace:10,property:18})[name] : parent?.type===7?8:1;
    if(type===undefined || (body===null && ![3,10,17].includes(type)))continue;
    const raw={type,conditionText:condition,[symbols.parentStyleSheet]:sheet,[symbols.parentRule]:parent};
    if([4,12,16,7].includes(type)) {
      raw.cssRules=parseCSSOMRules(window,body,sheet,raw,depth+1);
      Object.defineProperty(raw,'cssText',{get:()=>`${prelude} { ${raw.cssRules.map(r=>r.cssText).join(' ')} }`});
      Object.defineProperty(raw,'renderText',{get:()=>`${prelude} { ${raw.cssRules.map(renderRuleText).join(' ')} }`});
    }else if([1,5,6,8].includes(type)) {
      if(type===1){
        const probe=new window.CSSStyleSheet();probe.replaceSync(`${prelude} {}`);
        if(probe.cssRules.length!==1||probe.cssRules[0].type!==1)continue;
      }
      if(type===1)raw.cssRules=[];
      raw[symbols.selectorText]=prelude;
      Object.defineProperty(raw,'selectorText',{get:()=>raw[symbols.selectorText]});
      raw.style=window.document.createElement('span').style;raw.style.cssText=body;
      const initial=raw.style.cssText;
      Object.defineProperty(raw,'cssText',{get:()=>`${raw[symbols.selectorText]} {${raw.style.cssText?' '+raw.style.cssText+' ':''}}`});
      // Preserve declarations the renderer understands but the DOM parser does not.
      Object.defineProperty(raw,'renderText',{get:()=>`${raw[symbols.selectorText]} { ${raw.style.cssText===initial?body:raw.style.cssText} }`});
    }else {
      Object.defineProperty(raw,'cssText',{get:()=>body===null?`${prelude};`:`${prelude} { ${body} }`});
    }
    rules.push(raw);
  }
  return rules;
}

export function renderRuleText(rule) { return rule.renderText ?? rule.cssText; }
