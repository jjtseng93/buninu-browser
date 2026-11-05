// Shared CSS.supports()/@supports grammar. Unknown, balanced general-enclosed
// constructs are false; malformed syntax is distinct so `not` cannot enable it.
export function supportsCondition(source, declaration, allowBareDeclaration = false) {
  const text = String(source).replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  function parse(text, depth = 0, bare = false) {
    if (!text || depth > 128) return null;
    const stack = [], operators = [];
    let quote = '', colon = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') { if (++i >= text.length) return null; continue; }
      if (quote) { if (c === quote) quote = ''; else if (c === '\n' || c === '\r') return null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if ('([{'.includes(c)) stack.push(c);
      else if (')]}'.includes(c)) { if (stack.pop() !== ({')':'(',']':'[','}':'{'})[c]) return null; }
      if (!stack.length) {
        if (c === ':' && colon < 0) colon = i;
        const op = /[aAoO]/.test(c) && i > 0 && /\s/.test(text[i-1]) ? /^(and|or)\s+/i.exec(text.slice(i)) : null;
        if (op && i > 0 && /\s/.test(text[i-1])) {
          operators.push({at:i,end:i+op[0].length,op:op[1].toLowerCase()});
          i += op[0].length-1;
        }
      }
    }
    if (quote || stack.length) return null;
    if (bare && colon >= 0) return declaration(text.slice(0,colon).trim(),text.slice(colon+1).trim());
    if (operators.length) {
      const op=operators[0].op;
      if (operators.some(item=>item.op!==op)) return null;
      let start=0;const values=[];
      for (const item of operators) { values.push(term(text.slice(start,item.at).trim(),depth+1));start=item.end; }
      values.push(term(text.slice(start).trim(),depth+1));
      if (values.includes(null)) return null;
      return op==='and' ? values.every(Boolean) : values.some(Boolean);
    }
    if (/^not\s+/i.test(text)) {
      const value=term(text.replace(/^not\s+/i,''),depth+1);
      return value===null ? null : !value;
    }
    return term(text,depth+1);
  }
  function term(text,depth) {
    if (depth>128) return null;
    if (text.startsWith('(') && text.endsWith(')')) {
      // Ensure these delimiters enclose the whole term, not adjacent terms.
      let level=0,quote='';
      for(let i=0;i<text.length;i++) {
        const c=text[i];if(c==='\\'){i++;continue;}
        if(quote){if(c===quote)quote='';continue;}
        if(c==='"'||c==="'"){quote=c;continue;}
        if(c==='(')level++;else if(c===')'&&--level===0&&i!==text.length-1)return null;
      }
      const inner=text.slice(1,-1).trim();
      if (!inner) return false;
      if (/^[\w-]+\s*:/.test(inner)) return parse(inner,depth+1,true);
      // An unknown identifier in parentheses is general-enclosed.
      if (/^[\w-]+(?:\s+[^()]*)?$/.test(inner) && !/^(not|and|or)\b/i.test(inner)) return false;
      return parse(inner,depth+1);
    }
    if (/^[\w-]+\([\s\S]*\)$/.test(text)) return false;
    return null;
  }
  return parse(text,0,allowBareDeclaration) === true;
}

// Validate component-value balance before accepting deferred var() syntax.
// Delimiters inside quoted strings are data, not declaration separators.
export function declarationValueSyntax(text) {
  const stack=[];let quote='',variables=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='\\'){if(++i>=text.length)return null;continue;}
    if(quote){if(c===quote)quote='';else if(c==='\n'||c==='\r')return null;continue;}
    if(c==='"'||c==="'"){quote=c;continue;}
    if(!stack.length&&(c===';'||c==='!'))return null;
    if('([{'.includes(c)) {
      const isVar=c==='('&&/(?:^|[^\w-])var$/i.test(text.slice(Math.max(0,i-4),i));
      if(isVar) {
        if(!/^\s*--[\w-]+\s*(?:,|\))/.test(text.slice(i+1)))return null;
        variables=true;
      }
      if(stack.length>=128)return null;
      stack.push(c);
    }else if(')]}'.includes(c)&&stack.pop()!==({')':'(',']':'[','}':'{'})[c])return null;
  }
  return quote||stack.length ? null : {variables};
}
