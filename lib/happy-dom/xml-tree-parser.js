import './cdata-section.js';
import XMLParser from '../../vendor/happy-dom/packages/happy-dom/src/xml-parser/XMLParser.ts';
import XMLEncodeUtility from '../../vendor/happy-dom/packages/happy-dom/src/utilities/XMLEncodeUtility.ts';
import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

const XML = 'http://www.w3.org/XML/1998/namespace';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const HTML = 'http://www.w3.org/1999/xhtml';

// A private parser result, not a search for <parsererror>: that is also a legal
// element in an author's XML. Native parseError covers EOF and namespace errors
// that do not consistently populate the parser's errorMessage field.
export class XMLTreeParser extends XMLParser {
  valid = true;
  error = null;
  source = '';
  parse(source) {
    this.source = String(source).replace(/\r\n?/g, '\n');
    try { return super.parse(this.source); }
    finally { this.source = ''; }
  }
  parsePlainText(text) {
    // A parser's token boundaries are not DOM Text boundaries. Keep the native
    // entity/root validation, but coalesce consecutive exclusive Text chunks;
    // CDATA, comments, processing instructions and elements remain boundaries.
    const parent = this.currentNode?.namespaceURI === HTML && this.currentNode.localName === 'template'
      ? this.currentNode.content : this.currentNode;
    const previous = parent?.lastChild;
    super.parsePlainText(text);
    const added = parent?.lastChild;
    if (added !== previous && added?.nodeType === 3 && previous?.nodeType === 3 && previous.nextSibling === added) {
      previous.appendData(added.data);
      parent.removeChild(added);
    }
  }
  parseError(_source, message) { this.valid = false; this.error ??= message || 'Malformed XML'; }
  invalidNamespace() { this.valid = false; this.readState = 'error'; }
  parseProcessingInstruction(text) {
    // XML permits either quote and whitespace around '=' in its declaration.
    // Keep the existing tree builder, whose declaration matcher is narrower.
    const end = this.source.indexOf('?>', this.startTagIndex);
    if (end < 0) { this.parseError('', 'Processing instruction not terminated'); this.readState = 'error'; return; }
    const instruction = this.source.slice(this.startTagIndex, end);
    const match = /^([^\t\r\n ]+)(?:[\t\r\n ]+([\s\S]*))?$/.exec(instruction);
    if (!match) { this.parseError('', 'Invalid processing instruction'); this.readState = 'error'; return; }
    if (match[1] === 'xml') {
      text = (instruction + '?').replace(/\b(version|encoding|standalone)\s*=\s*(['"])([^'"]*)\2/g, '$1="$3"');
      super.parseProcessingInstruction(text);
    } else {
      this.currentNode[S.appendChild](this.rootNode.createProcessingInstruction(match[1], match[2] ?? ''), true);
      this.readState = 'any';
    }
    this.markupRegExp.lastIndex = end + 2;
  }
  parseComment(text) {
    this.currentNode[S.appendChild](this.rootNode.createComment(text), true);
    this.readState = 'any';
  }
  parseDocumentType(text) {
    if (!this.source.startsWith('DOCTYPE', this.startTagIndex)) return super.parseDocumentType(text);
    // A declaration can contain quoted '>' or a bracketed internal subset.
    // Keep its document type metadata; never load an external DTD/resource.
    let quote = '', depth = 0, subset = -1, end = -1;
    for (let i = this.startTagIndex; i < this.source.length; i++) {
      const c = this.source[i];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (this.source.startsWith('<!--', i) || this.source.startsWith('<?', i)) {
        const comment = this.source.startsWith('<!--', i), close = comment ? '-->' : '?>';
        const found = this.source.indexOf(close, i + (comment ? 4 : 2));
        if (found < 0) break;
        i = found + close.length - 1; continue;
      }
      if (c === '[') { if (!depth) subset = i; depth++; }
      else if (c === ']') depth--;
      else if (c === '>' && depth === 0) { end = i; break; }
    }
    if (end < 0) { this.parseError('', 'Document type not terminated'); this.readState = 'error'; return; }
    const header = this.source.slice(this.startTagIndex, subset < 0 ? end : subset);
    const match = /^DOCTYPE[\t\n\r ]+([^\t\n\r ]+)(?:[\t\n\r ]+(?:SYSTEM[\t\n\r ]+("[^"]*"|'[^']*')|PUBLIC[\t\n\r ]+("[^"]*"|'[^']*')[\t\n\r ]+("[^"]*"|'[^']*')))?[\t\n\r ]*$/.exec(header);
    if (!match || this.currentNode !== this.rootNode || this.rootNode.documentElement || this.rootNode.doctype) {
      this.parseError('', 'Invalid document type'); this.readState = 'error'; return;
    }
    const unquote = value => value ? value.slice(1, -1) : '';
    this.rootNode[S.appendChild](this.window.document.implementation.createDocumentType(match[1], unquote(match[3]), unquote(match[2] || match[4])), true);
    this.readState = 'any';
    this.markupRegExp.lastIndex = end + 1;
  }
  parseEndOfStartTag(source, selfClosed) {
    const namespaces = this.namespacePrefixStack.at(-1);
    namespaces.set('xml', XML);
    const attributes = [...source.matchAll(/([^\s=<>"']+)\s*=\s*(["'])(.*?)\2/gs)].map(match => ({
      name:match[1], value:XMLEncodeUtility.decodeXMLAttributeValue(match[3].replace(/[\t\r\n]/g, ' ')),
    }));
    // Resolve all declarations first, regardless of their source order. Reject
    // namespace well-formedness errors before the native attribute map can
    // merge duplicate expanded names or assign its limited HTML namespaces.
    let defaultNamespace;
    for (const {name, value} of attributes) if (name === 'xmlns' || name.startsWith('xmlns:')) {
      const prefix = name === 'xmlns' ? '' : name.slice(6);
      if (prefix === 'xmlns' || value === XMLNS || prefix === 'xml' && value !== XML
        || prefix !== 'xml' && value === XML || prefix && !value) {
        this.invalidNamespace(); return;
      }
      namespaces.set(prefix, value);
      if (prefix === '') defaultNamespace = value;
    }
    const expanded = new Set();
    for (const attribute of attributes) {
      const parts = attribute.name.split(':');
      if (parts.length > 2 || parts.some(part => !part)) { this.invalidNamespace(); return; }
      const prefix = parts.length === 2 ? parts[0] : null, local = parts.at(-1);
      const namespace = attribute.name === 'xmlns' || prefix === 'xmlns' ? XMLNS
        : prefix ? namespaces.get(prefix) : null;
      if (prefix && !namespace) { this.invalidNamespace(); return; }
      const key = `${namespace ?? ''}\0${local}`;
      if (expanded.has(key)) { this.invalidNamespace(); return; }
      expanded.add(key);
      Object.assign(attribute, {namespace, prefix, local});
    }
    // XML prefixes do not change an element's interface. The native factory
    // looks up the entire qualified name, so resolve declarations first and
    // select the class by localName before the normal attribute/append steps.
    const prefix = this.nextElement?.prefix;
    if (prefix && namespaces.get(prefix) || !prefix && defaultNamespace !== undefined) {
      const namespace = prefix ? namespaces.get(prefix) : defaultNamespace || null;
      const local = this.nextElement.localName;
      const element = this.rootNode.createElementNS(namespace, local);
      element[S.prefix] = prefix;
      element[S.tagName] = prefix ? (namespace === HTML ? local.toUpperCase() : `${prefix}:${local}`) : local;
      // The native default-xmlns upgrade uses this key as a factory name.
      // Preserve its source case rather than feeding an uppercase HTML key
      // back into the case-sensitive XML element factory.
      this.nextElement = element;
    }
    if (this.nextElement?.prefix === 'xmlns') { this.invalidNamespace(); return; }
    if (this.nextElement?.prefix === 'xml') this.nextElement[S.namespaceURI] = XML;
    const parent = this.currentNode;
    super.parseEndOfStartTag(source, selfClosed);
    if (this.readState !== 'any') return;
    const element = selfClosed ? (parent.namespaceURI === HTML && parent.localName === 'template'
      ? parent.content.lastChild : parent.lastChild) : this.currentNode;
    if (element?.[S.namespaceURI] === '') element[S.namespaceURI] = null;
    for (const {name, namespace, prefix, local} of attributes) {
      const attribute = element?.getAttributeNode(name);
      if (!attribute) continue;
      element.removeAttributeNode(attribute);
      attribute[S.namespaceURI] = namespace;
      attribute[S.prefix] = prefix;
      attribute[S.localName] = local;
      element.setAttributeNodeNS(attribute);
    }
    // Native XMLParser pushes the prefix map even for self-closing elements.
    // Its default-namespace stack also needs explicit empty/default bindings
    // on prefixed elements, which do not change that element's own namespace.
    if (selfClosed) this.namespacePrefixStack.pop();
    else if (defaultNamespace !== undefined) this.defaultNamespaceStack[this.defaultNamespaceStack.length - 1] = defaultNamespace;
  }
}

/** Parse once in an inert window. The caller decides whether the resulting
 * document becomes active or stays detached. No entity/resource loaders run. */
export function parseXMLTree(window, source) {
  try {
    source = String(source);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(source))
      return {valid:false, document:null, error:'Invalid XML character'};
    if (typeof Bun.XML?.parse === 'function') Bun.XML.parse(source);
    const parser = new XMLTreeParser(window), document = parser.parse(source);
    return {document, valid:parser.valid, error:parser.error};
  } catch (error) {
    return {valid:false, document:null, error:String(error?.message ?? error)};
  }
}
