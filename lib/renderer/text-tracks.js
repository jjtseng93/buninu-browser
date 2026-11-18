// WebVTT cue text has its own small markup vocabulary. Build fresh nodes
// instead of feeding the subtitle payload to the HTML parser.
const entities = {amp:'&', lt:'<', gt:'>', lrm:'\u200e', rlm:'\u200f', nbsp:'\u00a0'};
function decodeCueText(text) {
  return text.replace(/&(amp|lt|gt|lrm|rlm|nbsp);/g, (_, name) => entities[name]);
}
function cueFragment(document, text) {
  const fragment = document.createDocumentFragment();
  const stack = [{tag:'', node:fragment}];
  for (const token of text.match(/[^<]+|<[^>]*(?:>|$)/g) ?? []) {
    const parent = stack.at(-1);
    if (!token.startsWith('<')) {
      parent.node.appendChild(document.createTextNode(decodeCueText(token)));
      continue;
    }
    const close = /^<\/(\w+)>$/.exec(token);
    if (close) {
      if (close[1] === 'ruby' && parent.tag === 'rt') stack.pop();
      if (stack.at(-1).tag === close[1]) stack.pop();
      continue;
    }
    const tag = /^<(b|i|u|ruby|rt|c|v|lang)((?:\.[^\s.>]+)*)(?:\s+([^>]*))?>$/.exec(token);
    if (!tag || tag[1] === 'rt' && parent.tag !== 'ruby') continue;
    const node = document.createElement(['c','v','lang'].includes(tag[1]) ? 'span' : tag[1]);
    if (tag[2]) node.className = tag[2].slice(1).split('.').join(' ');
    if (tag[1] === 'v') node.title = decodeCueText(tag[3] ?? '');
    if (tag[1] === 'lang') node.lang = decodeCueText(tag[3] ?? '');
    parent.node.appendChild(node);
    stack.push({tag:tag[1], node});
  }
  return fragment;
}

export function textCueInterfaces({EventTarget, document, DOMException}) {
  const internal = Symbol();
  const records = new WeakMap();
  function timestamp(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError('Cue time must be finite');
    return number;
  }
  class TextTrackCue extends EventTarget {
    constructor(token) {
      super();
      if (token !== internal) throw new TypeError('Illegal constructor');
    }
    get track() { return records.get(this).track; }
    get id() { return records.get(this).id; }
    set id(value) { records.get(this).id = String(value); }
    get startTime() { return records.get(this).startTime; }
    set startTime(value) { records.get(this).startTime = timestamp(value); }
    get endTime() { return records.get(this).endTime; }
    set endTime(value) { records.get(this).endTime = timestamp(value); }
    get pauseOnExit() { return records.get(this).pauseOnExit; }
    set pauseOnExit(value) { records.get(this).pauseOnExit = Boolean(value); }
  }
  class VTTCue extends TextTrackCue {
    constructor(startTime, endTime, text) {
      super(internal);
      if (arguments.length < 3) throw new TypeError('VTTCue requires three arguments');
      records.set(this, {track:null, id:'', startTime:timestamp(startTime), endTime:timestamp(endTime),
        text:String(text), pauseOnExit:false, vertical:'', snapToLines:true, line:'auto', lineAlign:'start',
        position:'auto', positionAlign:'auto', size:100, align:'center'});
    }
    get text() { return records.get(this).text; }
    set text(value) { records.get(this).text = String(value); }
    getCueAsHTML() { return cueFragment(document, this.text); }
  }
  const enums = {vertical:['','rl','lr'], lineAlign:['start','center','end'],
    positionAlign:['line-left','center','line-right','auto'], align:['start','center','end','left','right']};
  for (const key of [...Object.keys(enums),'size','position','line','snapToLines']) {
    Object.defineProperty(VTTCue.prototype, key, {configurable:true, enumerable:true,
      get() { return records.get(this)[key]; },
      set(value) {
        if (enums[key]) {
          value = String(value);
          if (!enums[key].includes(value)) return;
        } else if (key === 'snapToLines') value = Boolean(value);
        else if (!(value === 'auto' && key !== 'size')) {
          value = timestamp(value);
          if (key !== 'line' && (value < 0 || value > 100))
            throw new DOMException('Cue percentage outside 0 to 100', 'IndexSizeError');
        }
        records.get(this)[key] = value;
      }});
  }
  return {TextTrackCue, VTTCue};
}
