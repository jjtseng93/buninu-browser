import {
  Parser,
  parse,
  parseExpressionAt,
  tokenizer,
} from '../../vendor/acorn/dist/acorn.mjs';

// Small, strict QML subset. Acorn owns JavaScript tokenization/parsing, including
// strings, comments, regexes and template literals; unsupported QML fails loudly.
export function parseQml(source) {
  // Preserve offsets while Acorn parses QML's cast operator as a binary operator.
  // The compiler recognizes the original 'as' spelling and emits a checked cast.
  const js = (code) => {
    const parts = [...tokenizer(code, { ecmaVersion: 'latest' })];
    for (let n = parts.length - 2; n >= 0; n--) {
      const t = parts[n],
        next = parts[n + 1];
      if (
        code.slice(t.start, t.end) === 'as' &&
        /^[A-Z]/.test(code.slice(next.start, next.end))
      )
        code = code.slice(0, t.start) + 'in' + code.slice(t.end);
    }
    return code;
  };
  if (source.length > 256 * 1024)
    throw new SyntaxError('QML experiment: source exceeds 256 KiB');
  const tokens = [...tokenizer(source, { ecmaVersion: 'latest' })];
  const javascriptSource = js(source);
  let i = 0,
    count = 0;
  const text = () => source.slice(tokens[i]?.start, tokens[i]?.end);
  const fail = (message) => {
    throw new SyntaxError(
      `QML: ${message} at offset ${tokens[i]?.start ?? source.length}`,
    );
  };
  const take = (value) => {
    if (text() !== value) fail(`expected ${value}, got ${text()}`);
    i++;
  };
  const name = () => {
    if (!/^[A-Za-z_$][\w$]*$/.test(text())) fail('expected identifier');
    let result = text();
    i++;
    while (text() === '.') {
      i++;
      result += '.' + text();
      i++;
    }
    return result;
  };
  const imports = [],
    pragmas = [];
  while (text() === 'pragma') {
    const start = tokens[i++].end;
    while (
      i < tokens.length &&
      !/[\r\n]/.test(source.slice(start, tokens[i].start)) &&
      text() !== ';'
    )
      i++;
    pragmas.push(source.slice(start, tokens[i - 1]?.end ?? start).trim());
    if (text() === ';') i++;
  }
  while (text() === 'import') {
    const start = tokens[i++].end;
    while (
      i < tokens.length &&
      !/[\r\n]/.test(source.slice(start, tokens[i].start)) &&
      text() !== ';'
    )
      i++;
    imports.push(source.slice(start, tokens[i - 1]?.end ?? start).trim());
    if (text() === ';') i++;
  }
  function object(depth = 0) {
    if (depth > 64 || ++count > 2000) fail('object limit exceeded');
    const type = name();
    let bindingTarget = null;
    if (text() === 'on') {
      i++;
      bindingTarget = name();
    }
    take('{');
    const properties = [],
      children = [],
      components = [];
    while (i < tokens.length && text() !== '}') {
      if (text() === ';') {
        i++;
        continue;
      }
      if (text() === 'component') {
        i++;
        const componentName = name();
        take(':');
        components.push({ name: componentName, object: object(depth + 1) });
        continue;
      }
      let afterName = i + 1;
      while (tokens[afterName]?.type.label === '.') afterName += 2;
      if (
        tokens[afterName]?.type.label === '{' ||
        source.slice(tokens[afterName]?.start, tokens[afterName]?.end) === 'on'
      ) {
        const child = object(depth + 1);
        if (/^[a-z]/.test(child.type)) {
          if (child.children.length || child.components.length)
            fail('unsupported nested property group');
          for (const p of child.properties)
            properties.push({ ...p, key: child.type + '.' + p.key });
        } else children.push(child);
        continue;
      }
      if (text() === 'function') {
        const start = tokens[i].start;
        // Acorn parses the complete remaining JS prefix; QML's outer closing
        // brace is not JavaScript, so locate the function body with tokens first.
        let params = i;
        while (params < tokens.length && tokens[params].type.label !== '(')
          params++;
        let endParams = params,
          paren = 0;
        do {
          const label = tokens[endParams++]?.type.label;
          if (label === '(') paren++;
          if (label === ')') paren--;
        } while (endParams < tokens.length && paren);
        let body = endParams;
        while (body < tokens.length && tokens[body].type.label !== '{') body++;
        if (body === tokens.length) fail('missing function body');
        let j = body,
          level = 0;
        do {
          const label = tokens[j++]?.type.label;
          if (label === '{' || label === '${') level++;
          if (label === '}') level--;
        } while (j < tokens.length && level);
        let code = source.slice(start, tokens[j - 1].end);
        // Erase QML annotations only at parameter/return-type positions. Braces
        // in destructuring and default values are JavaScript, not the body.
        const erase = (from, to) => {
          code =
            code.slice(0, from - start) +
            ' '.repeat(to - from) +
            code.slice(to - start);
        };
        let depth = 0,
          braces = 0,
          brackets = 0,
          hasDefault = false;
        for (let at = params; at < endParams; at++) {
          const label = tokens[at].type.label;
          if (label === '(') depth++;
          else if (label === ')') depth--;
          else if (label === '{' || label === '${') braces++;
          else if (label === '}') braces--;
          else if (label === '[') brackets++;
          else if (label === ']') brackets--;
          if (depth !== 1 || braces || brackets) continue;
          if (label === ',') hasDefault = false;
          if (label === '=') hasDefault = true;
          if (label === ':' && !hasDefault) {
            let end = at + 1;
            while (
              end < endParams &&
              !['=', ',', ')'].includes(tokens[end].type.label)
            )
              end++;
            erase(tokens[at].start, tokens[end].start);
            at = end - 1;
          }
        }
        if (tokens[endParams]?.type.label === ':')
          erase(tokens[endParams].start, tokens[body].start);
        const ast = parse(js(code), { ecmaVersion: 'latest' });
        if (ast.body.length !== 1 || ast.body[0].type !== 'FunctionDeclaration')
          fail('invalid function');
        properties.push({ key: ast.body[0].id.name, code, ast, method: true });
        i = j;
        continue;
      }
      if (text() === 'signal') {
        i++;
        const key = name();
        const args = [];
        if (text() !== '(') {
          properties.push({ key, signal: true, args });
          continue;
        }
        take('(');
        while (text() !== ')') {
          const type = name(),
            argument = name();
          args.push(argument);
          if (text() === ',') i++;
          else break;
        }
        take(')');
        properties.push({ key, signal: true, args });
        continue;
      }
      let custom = false,
        propertyType = null,
        readonly = false,
        required = false,
        defaultProperty = false;
      if (text() === 'default') {
        defaultProperty = true;
        i++;
      }
      if (text() === 'required') {
        required = true;
        i++;
      }
      if (text() === 'readonly') {
        readonly = true;
        i++;
      }
      if (
        text() === 'property' &&
        source.slice(tokens[i + 1]?.start, tokens[i + 1]?.end) !== ':'
      ) {
        i++;
        custom = true;
        propertyType = name();
      }
      const key = name();
      if (custom && text() !== ':') {
        const code = required
          ? 'undefined'
          : ({
              int: '0',
              real: '0',
              double: '0',
              bool: 'false',
              string: '""',
              url: '""',
              var: 'undefined',
              point: '({x:0,y:0})',
              size: '({width:0,height:0})',
              rect: '({x:0,y:0,width:0,height:0})',
              color: '"transparent"',
            }[propertyType] ?? 'null');
        properties.push({
          key,
          custom,
          propertyType,
          required,
          readonly,
          defaultProperty,
          code,
          ast: parseExpressionAt(code, 0, { ecmaVersion: 'latest' }),
        });
        continue;
      }
      take(':');
      let objectEnd = i + 1;
      while (tokens[objectEnd]?.type.label === '.') objectEnd += 2;
      if (
        /^[A-Za-z_$][\w$]*$/.test(text()) &&
        tokens[objectEnd]?.type.label === '{'
      ) {
        properties.push({
          key,
          custom,
          propertyType,
          readonly,
          required,
          defaultProperty,
          object: object(depth + 1),
        });
        continue;
      }
      const start = tokens[i]?.start;
      if (start === undefined) fail('missing value');
      let ast,
        end,
        block = false;
      if (
        /^(?:.*\.)?on[A-Z_]/.test(key) &&
        [
          'if',
          'for',
          'while',
          'do',
          'switch',
          'try',
          'throw',
          'return',
        ].includes(text())
      ) {
        const parser = new Parser(
          { ecmaVersion: 'latest', allowReturnOutsideFunction: true },
          javascriptSource,
          start,
        );
        parser.nextToken();
        const statement = parser.parseStatement(null);
        end = statement.end;
        const code = '{' + source.slice(start, end) + '}';
        ast = parse(js(code), {
          ecmaVersion: 'latest',
          allowReturnOutsideFunction: true,
        });
        properties.push({
          key,
          custom,
          propertyType,
          code,
          ast,
          block: true,
          readonly,
          defaultProperty,
        });
        while (tokens[i]?.start < end) i++;
        continue;
      }
      if (text() === '{') {
        block = true;
        let nesting = 0,
          j = i;
        do {
          const label = tokens[j]?.type.label;
          if (label === '{' || label === '${') nesting++;
          if (label === '}') nesting--;
          j++;
        } while (j < tokens.length && nesting);
        if (nesting) fail('unterminated block');
        end = tokens[j - 1].end;
        const body = source.slice(start, end);
        let literal;
        if (!/^(?:.*\.)?on[A-Z_]/.test(key))
          try {
            literal = parseExpressionAt(js(body), 0, { ecmaVersion: 'latest' });
          } catch {}
        if (
          literal?.type === 'ObjectExpression' &&
          literal.end === body.length
        ) {
          ast = literal;
          block = false;
        } else
          ast = parse(js(body), {
            ecmaVersion: 'latest',
            allowReturnOutsideFunction: true,
          });
      } else {
        ast = parseExpressionAt(javascriptSource, start, {
          ecmaVersion: 'latest',
          preserveParens: true,
        });
        end = ast.end;
      }
      const code = source.slice(start, end);
      // Normalize offsets to each expression for the compiler's identifier rewrite.
      if (!block)
        ast = parseExpressionAt(js(code), 0, {
          ecmaVersion: 'latest',
          preserveParens: true,
        });
      properties.push({
        key,
        custom,
        propertyType,
        code,
        ast,
        block,
        readonly,
        defaultProperty,
      });
      while (tokens[i]?.start < end) i++;
    }
    take('}');
    return { type, properties, children, components, bindingTarget };
  }
  const root = object();
  if (i !== tokens.length) fail('unexpected trailing input');
  return { imports, pragmas, root };
}
