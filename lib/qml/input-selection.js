import { computeElementStyle } from '../style/computed-style.js';
import { hasQmlDomImages } from './canvas-dom.js';

const spans = new WeakMap();

// QML controls retain the real input for editing; only their selected value is
// split into ordinary inline render nodes. HTML controls keep their old path.
export function qmlInputSelection(element, text, style, make) {
  if (!hasQmlDomImages(element.ownerDocument)) return null;
  const raw = element.getAttribute('data-qml-selection');
  if (!raw) return null;
  const { start, end, background, color } = JSON.parse(raw);
  const from = Math.max(0, Math.min(text.length, start)),
    to = Math.max(from, Math.min(text.length, end));
  if (from === to) return null;
  const textNode = (part, text, textStyle = style, domNode = element) => make(part, 'text', {
    text, style: textStyle, pseudo: 'value', children: Object.freeze([]),
  }, domNode);
  let span = spans.get(element);
  if (!span) { span = element.ownerDocument.createElement('span'); spans.set(element, span); }
  span.style.pointerEvents = 'none';
  span.style.backgroundColor = background;
  span.style.color = color;
  const selectedStyle = computeElementStyle(span, style);
  const children = [];
  if (from) children.push(textNode('before', text.slice(0, from)));
  children.push(make('selection', 'inline', {
    tagName: 'SPAN', style: selectedStyle,
    children: Object.freeze([textNode('selected', text.slice(from, to), selectedStyle, span)]),
  }, span));
  if (to < text.length) children.push(textNode('after', text.slice(to)));
  return children;
}

export function qmlInputSelectionChanged(records) {
  return records.some(record => record.type === 'attributes' && record.attributeName === 'data-qml-selection');
}
