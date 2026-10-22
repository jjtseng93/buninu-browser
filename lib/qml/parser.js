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
  const imports = [];
  while (text() === 'import') {
    const start = tokens[i++].end;
    while (i < tokens.length && !/[\r\n]/.test(source.slice(start, tokens[i].start)) && text() !== ';') i++;
    imports.push(source.slice(start, tokens[i]?.start ?? source.length).trim());
    if (text() === ';') i++;
  }
  function object(depth = 0) {
    if (depth > 64 || ++count > 2000) fail('object limit exceeded');
    const type = name(); take('{');
    const properties = [], children = [];
    while (i < tokens.length && text() !== '}') {
      if (text() === ';') { i++; continue; }
      if (tokens[i + 1] && source.slice(tokens[i + 1].start, tokens[i + 1].end) === '{') {
        children.push(object(depth + 1)); continue;
      }
      let custom = false, propertyType = null;
      if (text() === 'property') { i++; custom = true; propertyType = name(); }
      const key = name(); take(':');
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
        ast = parseExpressionAt(source, start, {ecmaVersion: 'latest'}); end = ast.end;
      }
      const code = source.slice(start, end);
      // Normalize offsets to each expression for the compiler's identifier rewrite.
      if (!block) ast = parseExpressionAt(code, 0, {ecmaVersion: 'latest'});
      properties.push({key, custom, propertyType, code, ast, block});
      while (tokens[i]?.start < end) i++;
    }
    take('}');
    return {type, properties, children};
  }
  const root = object();
  if (i !== tokens.length) fail('unexpected trailing input');
  return {imports, root};
}
