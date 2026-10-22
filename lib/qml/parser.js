import {parse, parseExpressionAt, tokenizer} from '../../vendor/acorn/dist/acorn.mjs';

// Small, strict QML subset. Acorn owns JavaScript tokenization/parsing, including
// strings, comments, regexes and template literals; unsupported QML fails loudly.
export function parseQml(source) {
  if (source.length > 256 * 1024) throw new SyntaxError('QML experiment: source exceeds 256 KiB');
  const tokens = [...tokenizer(source, {ecmaVersion: 'latest'})];
  let i = 0, count = 0;
  const text = () => source.slice(tokens[i]?.start, tokens[i]?.end);
  const fail = message => { throw new SyntaxError(`QML: ${message} at offset ${tokens[i]?.start ?? source.length}`); };
  const take = value => { if (text() !== value) fail(`expected ${value}, got ${text()}`); i++; };
  const name = () => {
    if (!/^[A-Za-z_$][\w$]*$/.test(text())) fail('expected identifier');
    let result = text(); i++;
    while (text() === '.') { i++; result += '.' + text(); i++; }
    return result;
  };
  const imports = [], pragmas = [];
  while (text() === 'pragma') {
    const start = tokens[i++].end;
    while (i < tokens.length && !/[\r\n]/.test(source.slice(start, tokens[i].start)) && text() !== ';') i++;
    pragmas.push(source.slice(start, tokens[i - 1]?.end ?? start).trim());
    if (text() === ';') i++;
  }
  while (text() === 'import') {
    const start = tokens[i++].end;
    while (i < tokens.length && !/[\r\n]/.test(source.slice(start, tokens[i].start)) && text() !== ';') i++;
    imports.push(source.slice(start, tokens[i - 1]?.end ?? start).trim());
    if (text() === ';') i++;
  }
  function object(depth = 0) {
    if (depth > 64 || ++count > 2000) fail('object limit exceeded');
    const type = name(); take('{');
    const properties = [], children = [];
    while (i < tokens.length && text() !== '}') {
      if (text() === ';') { i++; continue; }
      let afterName = i + 1;
      while (tokens[afterName]?.type.label === '.') afterName += 2;
      if (tokens[afterName]?.type.label === '{') {
        children.push(object(depth + 1)); continue;
      }
      if (text() === 'function') {
        const start = tokens[i].start;
        // Acorn parses the complete remaining JS prefix; QML's outer closing
        // brace is not JavaScript, so locate the function body with tokens first.
        let j=i; while(j<tokens.length && tokens[j].type.label !== '{') j++;
        let level=0; do {const label=tokens[j++]?.type.label;if(label==='{'||label==='${')level++;if(label==='}')level--;} while(j<tokens.length&&level);
        const code=source.slice(start,tokens[j-1].end);
        const ast=parse(code,{ecmaVersion:'latest'});
        if(ast.body.length!==1||ast.body[0].type!=='FunctionDeclaration')fail('invalid function');
        properties.push({key:ast.body[0].id.name,code,ast,method:true});i=j;continue;
      }
      if (text() === 'signal') {
        i++; const key=name(); take('('); const args=[];
        while(text()!==')') { const type=name(), argument=name(); args.push(argument); if(text()===',')i++;else break; }
        take(')'); properties.push({key,signal:true,args}); continue;
      }
      let custom = false, propertyType = null, readonly = false, required = false;
      if (text() === 'required') {required=true;i++;}
      if (text() === 'readonly') {readonly=true;i++;}
      if (text() === 'property') { i++; custom = true; propertyType = name(); }
      const key = name();
      if(required && text()!==':') {properties.push({key,custom,propertyType,required,code:'undefined',ast:parseExpressionAt('undefined',0,{ecmaVersion:'latest'})});continue;}
      take(':');
      let objectEnd=i+1;while(tokens[objectEnd]?.type.label==='.')objectEnd+=2;
      if(/^[A-Za-z_$][\w$]*$/.test(text()) && tokens[objectEnd]?.type.label==='{') {
        properties.push({key,custom,propertyType,readonly,required,object:object(depth+1)});continue;
      }
      const start = tokens[i]?.start;
      if (start === undefined) fail('missing value');
      let ast, end, block = false;
      if (text() === '{') {
        block = true; let nesting = 0, j = i;
        do {
          const label = tokens[j]?.type.label;
          if (label === '{' || label === '${') nesting++;
          if (label === '}') nesting--;
          j++;
        } while (j < tokens.length && nesting);
        if (nesting) fail('unterminated block');
        end = tokens[j - 1].end;
        ast = parse(source.slice(start, end), {ecmaVersion: 'latest', allowReturnOutsideFunction: true});
      } else {
        ast = parseExpressionAt(source, start, {ecmaVersion: 'latest', preserveParens: true}); end = ast.end;
      }
      const code = source.slice(start, end);
      // Normalize offsets to each expression for the compiler's identifier rewrite.
      if (!block) ast = parseExpressionAt(code, 0, {ecmaVersion: 'latest', preserveParens: true});
      properties.push({key, custom, propertyType, code, ast, block, readonly});
      while (tokens[i]?.start < end) i++;
    }
    take('}');
    return {type, properties, children};
  }
  const root = object();
  if (i !== tokens.length) fail('unexpected trailing input');
  return {imports, pragmas, root};
}
