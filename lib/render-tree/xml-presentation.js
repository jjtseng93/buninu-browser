import * as S from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

const HTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';
const metadata = new Set(['base','basefont','bgsound','head','link','meta','noframes','script','style','template','title']);
const svgMetadata = new Set(['script','style','title','desc','defs','metadata']);
export const XML_PREVIEW_LIMIT = 65536;
const NODE_LIMIT = 4096;

/** A bounded presentation of the authoritative XML tree. It creates no DOM
 * nodes, loads no resources, and never serializes an arbitrarily large value
 * before truncating it. HTML/SVG presentation and author styles use the real
 * element tree instead; an ordinary XML tree gets a readable source view. */
export function xmlPresentation(document, styled = false) {
  if (styled && document.documentElement) return Object.freeze({rendered:true});
  let text = '', truncated = false, nodes = 0, rendered = styled;
  const append = value => {
    const left = XML_PREVIEW_LIMIT - text.length;
    if (value.length > left) { text += value.slice(0,left); truncated = true; }
    else text += value;
  };
  const escaped = (value, attribute = false) => {
    // Escape only the bounded prefix, rather than copying a huge Text/Attr.
    const left = XML_PREVIEW_LIMIT - text.length;
    if (value.length > left) truncated = true;
    append(value.slice(0,left).replace(attribute ? /[&<"\t\n\r]/g : /[&<>\r]/g,
      c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\t':'&#9;','\n':'&#10;','\r':'&#13;'})[c]));
  };
  const name = node => {
    const local=node.localName,prefix=node.prefix;
    // DOM APIs can also construct very long names; bound the temporary
    // qualified-name string before adding it to the limited preview.
    if(local.length+(prefix?.length??-1)+1>XML_PREVIEW_LIMIT)truncated=true;
    return prefix===null?local.slice(0,XML_PREVIEW_LIMIT):`${prefix.slice(0,XML_PREVIEW_LIMIT)}:${local.slice(0,XML_PREVIEW_LIMIT)}`;
  };
  const stack = [{children:document[S.nodeArray],index:0,close:null,hidden:false}];
  while (stack.length && !truncated) {
    const frame = stack[stack.length-1];
    if (frame.index === frame.children.length) {
      if (frame.close) append(`</${frame.close}>`);
      stack.pop();continue;
    }
    if (++nodes > NODE_LIMIT) { truncated = true;break; }
    const node = frame.children[frame.index++];
    switch (node.nodeType) {
      case 1: {
        const hidden = frame.hidden || node.namespaceURI === SVG && svgMetadata.has(node.localName)
          || node.namespaceURI === HTML && metadata.has(node.localName);
        if (!hidden && (node.namespaceURI === SVG || node.namespaceURI === HTML)) rendered = true;
        if (rendered) return Object.freeze({rendered:true});
        const tag = name(node), children = node.namespaceURI===HTML&&node.localName==='template'?node.content[S.nodeArray]:node[S.nodeArray];
        append('<');append(tag);
        for (const attribute of node[S.attributes]) {
          if (truncated) break;
          append(` ${name(attribute)}="`);escaped(attribute.value,true);append('"');
        }
        append(children.length ? '>' : '/>');
        if (children.length) stack.push({children,index:0,close:tag,hidden});
        break;
      }
      case 3: escaped(node.data);break;
      case 4: append('<![CDATA[');append(node.data);append(']]>');break;
      case 7: append('<?');append(node.target);if(node.data){append(' ');append(node.data);}append('?>');break;
      case 8: append('<!--');append(node.data);append('-->');break;
      case 10:
        append('<!DOCTYPE ');append(node.name);
        if(node.publicId){append(' PUBLIC "');escaped(node.publicId,true);append('"');}
        if(node.systemId){append(node.publicId?' "':' SYSTEM "');escaped(node.systemId,true);append('"');}
        append('>');break;
    }
  }
  return Object.freeze({rendered,text:(text || '(Empty XML document)') + (truncated ? '\n… XML preview truncated; use download to save the original response.' : ''),truncated});
}
