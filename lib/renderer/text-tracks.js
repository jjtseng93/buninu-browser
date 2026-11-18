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

export function textCueInterfaces({EventTarget, document, DOMException, mediaPrototype, trackPrototype}) {
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
  const tracks = new WeakMap(), lists = new WeakMap(), media = new WeakMap(), elements = new WeakMap();
  const kinds = ['subtitles','captions','descriptions','chapters','metadata'];
  function indexed(target, items) {
    const proxy = new Proxy(target, {
      get(object, key, receiver) {
        if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) return items()[Number(key)];
        return Reflect.get(object, key, receiver);
      },
      has(object, key) {
        if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) return Number(key) < items().length;
        return Reflect.has(object,key);
      }
    });
    lists.set(proxy, items);
    return proxy;
  }
  class TextTrackCueList {
    constructor(token, items) {
      if (token !== internal) throw new TypeError('Illegal constructor');
      return indexed(this, items);
    }
    get length() { return lists.get(this)().length; }
    getCueById(id) { return lists.get(this)().find(cue => cue.id === String(id)) ?? null; }
    [Symbol.iterator]() { return lists.get(this)()[Symbol.iterator](); }
  }
  class TextTrackList extends EventTarget {
    constructor(token, items) {
      super();
      if (token !== internal) throw new TypeError('Illegal constructor');
      return indexed(this, items);
    }
    get length() { return lists.get(this)().length; }
    getTrackById(id) { return lists.get(this)().find(track => track.id === String(id)) ?? null; }
    [Symbol.iterator]() { return lists.get(this)()[Symbol.iterator](); }
  }
  class TextTrack extends EventTarget {
    constructor(token, data) {
      super();
      if (token !== internal) throw new TypeError('Illegal constructor');
      tracks.set(this, data);
      data.items = [];
      const sorted = () => data.items.slice().sort((a,b) => a.startTime-b.startTime || b.endTime-a.endTime);
      data.cues = new TextTrackCueList(internal, sorted);
      data.active = new TextTrackCueList(internal, () => {
        const owner = data.element ? data.element.parentElement : data.owner;
        const time = owner?.currentTime;
        return sorted().filter(cue => cue.startTime <= time && time < cue.endTime);
      });
    }
    get kind() {
      const data = tracks.get(this);
      if (!data.element) return data.kind;
      const kind = data.element.getAttribute('kind')?.toLowerCase();
      return kind == null ? 'subtitles' : kinds.includes(kind) ? kind : 'metadata';
    }
    get label() { const d=tracks.get(this); return d.element?.getAttribute('label') ?? d.label ?? ''; }
    get language() { const d=tracks.get(this); return d.element?.getAttribute('srclang') ?? d.language ?? ''; }
    get id() { return tracks.get(this).element?.id ?? ''; }
    get mode() { return tracks.get(this).mode; }
    set mode(value) {
      value=String(value);
      if (['disabled','hidden','showing'].includes(value)) tracks.get(this).mode=value;
    }
    get cues() { return this.mode === 'disabled' ? null : tracks.get(this).cues; }
    get activeCues() { return this.mode === 'disabled' ? null : tracks.get(this).active; }
    addCue(cue) {
      const record = records.get(cue);
      if (!record) throw new TypeError('Expected a TextTrackCue');
      if (record.track === this) return;
      if (record.track) record.track.removeCue(cue);
      tracks.get(this).items.push(cue);
      record.track=this;
    }
    removeCue(cue) {
      const record = records.get(cue);
      if (!record) throw new TypeError('Expected a TextTrackCue');
      if (record.track !== this) throw new DOMException('Cue belongs to another track','NotFoundError');
      const items = tracks.get(this).items;
      items.splice(items.indexOf(cue),1);
      record.track=null;
    }
  }
  function mediaState(owner) {
    let data = media.get(owner);
    if (!data) {
      const added = [];
      const list = new TextTrackList(internal, () => [
        ...Array.from(owner.children).filter(child => child.localName === 'track').map(child => child.track), ...added
      ]);
      data = {added, list};
      media.set(owner,data);
    }
    return data;
  }
  Object.defineProperties(mediaPrototype, {
    textTracks:{configurable:true, enumerable:true, get() { return mediaState(this).list; }},
    addTextTrack:{configurable:true, enumerable:true, writable:true, value:function addTextTrack(kind,label='',language='') {
      kind = String(kind);
      if (!kinds.includes(kind)) throw new TypeError('Invalid text track kind');
      const track = new TextTrack(internal,{kind,label:String(label),language:String(language),mode:'hidden',owner:this});
      mediaState(this).added.push(track);
      return track;
    }}
  });
  Object.defineProperty(trackPrototype,'track',{configurable:true, enumerable:true, get() {
    if (!elements.has(this)) elements.set(this,new TextTrack(internal,{element:this,mode:'disabled'}));
    return elements.get(this);
  }});
  return {TextTrackCue, VTTCue, TextTrack, TextTrackList, TextTrackCueList};
}
