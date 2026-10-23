// Qt Text's markup is content, not generated QML HTML. Build an inert, restricted
// DOM fragment; embedded scripts, handlers and external resource tags are never
// transferred to the live document. Rendering stays in the browser's CSS engine.
export function createQmlText(document, markdown) {
  const cache = new WeakMap();
  const tags = new Set(
    'a b strong i em u s strike sub sup span font br p div pre code ul ol li h1 h2 h3 h4 h5 h6 blockquote table thead tbody tr td th hr'.split(
      ' ',
    ),
  );
  const blocks = new Set(
    'p div pre li h1 h2 h3 h4 h5 h6 blockquote tr'.split(' '),
  );
  function copy(source, target, collapse = false, pre = false) {
    for (const child of source.childNodes) {
      if (child.nodeType === 3) {
        // Markdown emits formatting newlines between block tags. They are not
        // extra text lines, and must not inflate a Text item's implicitHeight.
        if (/^\s*$/.test(child.textContent) &&
            (blocks.has(child.previousSibling?.localName) || blocks.has(child.nextSibling?.localName))) continue;
        const text = collapse && !pre ? child.textContent.replace(/[ \t\r\n\f]+/g, ' ') : child.textContent;
        target.appendChild(document.createTextNode(text));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.localName.toLowerCase();
      if (['script', 'style', 'iframe', 'object', 'embed'].includes(tag))
        continue;
      if (!tags.has(tag)) {
        copy(child, target, collapse, pre);
        continue;
      }
      const node = document.createElement(tag === 'font' ? 'span' : tag);
      if (blocks.has(tag) || ['blockquote', 'ul', 'ol'].includes(tag))
        node.style.margin = '0';
      if (tag === 'a') {
        const href = child.getAttribute('href');
        if (href && !/^\s*(?:javascript|vbscript|data):/i.test(href)) {
          node.setAttribute('href', href);
          node.style.pointerEvents = 'auto';
        }
      }
      if (tag === 'font') {
        if (child.hasAttribute('color'))
          node.style.color = child.getAttribute('color');
        if (child.hasAttribute('face'))
          node.style.fontFamily = child.getAttribute('face');
      }
      for (const key of [
        'color',
        'background-color',
        'font-family',
        'font-size',
        'font-weight',
        'font-style',
        'text-decoration',
        'vertical-align',
        'white-space',
      ]) {
        const value = child.style?.getPropertyValue(key);
        if (value && !/url\s*\(|expression\s*\(/i.test(value))
          node.style.setProperty(key, value);
      }
      copy(child, node, collapse, pre || tag === 'pre');
      target.appendChild(node);
    }
  }
  const plain = (node) => {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out += child.textContent;
      else if (child.nodeType === 1) {
        if (child.localName === 'br') out += '\n';
        else {
          out += plain(child);
          if (blocks.has(child.localName) && !out.endsWith('\n')) out += '\n';
        }
      }
    }
    return out;
  };
  return (value) => {
    const source = String(value.text),
      format = value.textFormat ?? 0;
    let entry = cache.get(value);
    if (entry?.source === source && entry.format === format) return entry;
    const container = entry?.container ?? document.createElement('span');
    container.style.display = 'contents';
    container.replaceChildren();
    const isPlain =
      format === 0 ||
      (format === 2 && !/<[a-z][\w:-]*(?:\s|\/?>)/i.test(source));
    if (isPlain) container.textContent = source;
    else if ([1, 2, 3, 4].includes(format)) {
      const html = format === 4 ? markdown(source) : source;
      const template = document.createElement('template');
      template.innerHTML = html;
      copy(template.content, container, format === 4);
    } else throw Error('Unsupported QML textFormat: ' + format);
    entry = {
      source,
      format,
      container,
      plain: isPlain ? source : plain(container).replace(/\n$/, ''),
    };
    cache.set(value, entry);
    return entry;
  };
}
