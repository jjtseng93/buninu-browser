import {parseWebVTT} from '../media/webvtt.js';

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

export function textCueInterfaces({EventTarget, defineHandler, registerIndexedTarget, queueTask, document, DOMException, mediaPrototype, trackPrototype,
  Event, fetchResource, nodeOf, wrap, observe, isDisposed, captionsChanged}) {
  const internal = Symbol();
  const records = new WeakMap();
  function timestamp(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError('Cue time must be finite');
    return number;
  }
  class TextTrackCue extends EventTarget {
    constructor(token = undefined) {
      super();
      if (token !== internal) throw new TypeError('Illegal constructor');
    }
    get track() { return records.get(this).track; }
    get id() { return records.get(this).id; }
    set id(value) { records.get(this).id = String(value); }
    get startTime() { return records.get(this).startTime; }
    set startTime(value) { const d=records.get(this); d.startTime=timestamp(value); if(d.track)invalidateTimeline(d.track); }
    get endTime() { return records.get(this).endTime; }
    set endTime(value) { const d=records.get(this); d.endTime=timestamp(value); if(d.track)invalidateTimeline(d.track); }
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
    set text(value) {
      const data=records.get(this);
      data.text=String(value);
      if (data.track) tracks.get(data.track).captionDirty=true;
      if (data.track) scheduleUpdate(data.track);
    }
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
        const data=records.get(this);
        if(data[key]===value)return;
        data[key]=value;
        if(data.track){tracks.get(data.track).captionDirty=true;scheduleUpdate(data.track);}

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
    constructor(token = undefined, items) {
      if (token !== internal) throw new TypeError('Illegal constructor');
      return indexed(this, items);
    }
    get length() { return lists.get(this)().length; }
    getCueById(id) { return lists.get(this)().find(cue => cue.id === String(id)) ?? null; }
    [Symbol.iterator]() { return lists.get(this)()[Symbol.iterator](); }
  }
  class TextTrackList extends EventTarget {
    constructor(token = undefined, items) {
      super();
      if (token !== internal) throw new TypeError('Illegal constructor');
      const list = indexed(this, items);
      registerIndexedTarget(this, list);
      return list;
    }
    get length() { return lists.get(this)().length; }
    getTrackById(id) { return lists.get(this)().find(track => track.id === String(id)) ?? null; }
    [Symbol.iterator]() { return lists.get(this)()[Symbol.iterator](); }
  }
  function updateActive(track, advancing) {
    const data = tracks.get(track);
    const before = data.previous ?? [];
    const after = data.mode === 'disabled' ? [] : [...data.active];
    data.notified=data.members;
    const owner=data.element ? data.element.parentElement : data.owner;
    const same=after.length === before.length && after.every((cue,i) => cue === before[i]);
    if (!data.captionDirty && same) return;
    data.captionDirty=false;
    if (owner && media.has(nodeOf(owner))) {
      const lines=[];
      for (const entry of media.get(nodeOf(owner)).list) {
        if(entry.mode !== 'showing' || !['captions','subtitles'].includes(entry.kind)) continue;
        for(const cue of entry.activeCues) {
          const {text,align,line,lineAlign,snapToLines,size,position,positionAlign,vertical}=records.get(cue);
          lines.push({text:decodeCueText(text.replace(/<[^>]*(?:>|$)/g,'')),align,line,lineAlign,snapToLines,size,position,positionAlign,vertical});
        }
      }
      captionsChanged(nodeOf(owner),lines);
    }
    if (same) return;
    data.previous = after;
    if (advancing && owner && before.some(cue => cue.pauseOnExit && !after.includes(cue))) owner.pause();
    for (const cue of before) if (!after.includes(cue)) cue.dispatchEvent(new Event('exit'));
    for (const cue of after) if (!before.includes(cue)) cue.dispatchEvent(new Event('enter'));
    track.dispatchEvent(new Event('cuechange'));
    data.element?.dispatchEvent(new Event('cuechange'));
  }
  function invalidateTimeline(track) {
    const data=tracks.get(track);
    data.sorted=null;
    data.until=-Infinity;
    scheduleUpdate(track);
  }
  function scheduleUpdate(track, advancing = false) {
    const data = tracks.get(track);
    data.advancing=advancing;
    if (data.scheduled) return;
    data.scheduled = true;
    queueMicrotask(() => {
      data.scheduled = false;
      if (!isDisposed()) updateActive(track,data.advancing);
    });
  }
  class TextTrack extends EventTarget {
    constructor(token = undefined, data) {
      super();
      if (token !== internal) throw new TypeError('Illegal constructor');
      tracks.set(this, data);
      data.items = [];
      const sorted = () => data.sorted ??= data.items.slice().sort((a,b) => a.startTime-b.startTime || b.endTime-a.endTime);
      data.cues = new TextTrackCueList(internal, sorted);
      data.active = new TextTrackCueList(internal, () => {
        const owner = data.element ? data.element.parentElement : data.owner;
        const time = owner?.currentTime;
        if (time >= data.from && time < data.until) return data.members;
        const members=[];
        let until=Infinity;
        for (const cue of sorted()) {
          if (cue.startTime > time) {until=Math.min(until,cue.startTime);break;}
          if (time < cue.endTime) {members.push(cue);until=Math.min(until,cue.endTime);}
        }
        data.from=time;data.until=until;data.members=members;
        return members;
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
      const data = tracks.get(this);
      if (!['disabled','hidden','showing'].includes(value) || data.mode === value) return;
      data.mode=value;
      const owner=data.element ? data.element.parentElement : data.owner;
      if (owner && ['video','audio'].includes(owner.localName)) {
        const state=mediaState(owner);
        if (!state.changePending) {
          state.changePending=true;
          queueTask(()=>{state.changePending=false;state.list.dispatchEvent(new Event('change'));});
        }
      }
      data.captionDirty=true;
      scheduleUpdate(this);
      if (data.element) loadTrack(this);
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
      invalidateTimeline(this);
    }
    removeCue(cue) {
      const record = records.get(cue);
      if (!record) throw new TypeError('Expected a TextTrackCue');
      if (record.track !== this) throw new DOMException('Cue belongs to another track','NotFoundError');
      const items = tracks.get(this).items;
      items.splice(items.indexOf(cue),1);
      record.track=null;
      invalidateTimeline(this);
    }
  }
  defineHandler(TextTrackCue.prototype, 'enter');
  defineHandler(TextTrackCue.prototype, 'exit');
  defineHandler(TextTrack.prototype, 'cuechange');

  for (const type of ['addtrack','removetrack','change']) defineHandler(TextTrackList.prototype,type);
  function notifyTrack(list,type,track) {
    queueTask(()=>{
      const event=new Event(type);
      Object.defineProperty(event,'track',{value:track,enumerable:true});
      list.dispatchEvent(event);
    });
  }
  function mediaState(owner) {
    const node=nodeOf(owner);
    let data = media.get(node);
    if (!data) {
      const added = [];
      const list = new TextTrackList(internal, () => [
        ...Array.from(owner.children).filter(child => child.localName === 'track').map(child => child.track), ...added
      ]);
      data = {added, list};
      media.set(node,data);
      const observer=observe(records=>{
        for (const record of records) {
          for (const child of record.removedNodes) if (child.localName==='track')
            notifyTrack(list,'removetrack',elementTrack(wrap(child)));
          for (const child of record.addedNodes) if (child.localName==='track')
            notifyTrack(list,'addtrack',elementTrack(wrap(child)));
        }
      });
      observer.observe(node,{childList:true});
    }
    return data;
  }
  Object.defineProperties(mediaPrototype, {
    textTracks:{configurable:true, enumerable:true, get() { return mediaState(this).list; }},
    addTextTrack:{configurable:true, enumerable:true, writable:true, value:function addTextTrack(kind,label='',language='') {
      kind = String(kind);
      if (!kinds.includes(kind)) throw new TypeError('Invalid text track kind');
      const track = new TextTrack(internal,{kind,label:String(label),language:String(language),mode:'hidden',owner:this});
      const state=mediaState(this);
      state.added.push(track);
      notifyTrack(state.list,'addtrack',track);
      return track;
    }}
  });
  function loadTrack(track) {
    const data = tracks.get(track);
    const node = nodeOf(data.element);
    const owner = node.parentElement;
    const src = node.getAttribute('src');
    if (!src) {
      data.request?.abort();
      data.request = null;
      data.url = null;
      data.readyState = 0;
      for (const cue of data.loaded) if (cue.track === track) track.removeCue(cue);
      data.loaded = [];
      return;
    }
    if (!['AUDIO','VIDEO'].includes(owner?.tagName) || data.mode === 'disabled') return;
    let url;
    try { url = new URL(src,node.baseURI).href; } catch { url = src; }
    if (url === data.url) return;
    data.request?.abort();
    const request = new AbortController();
    data.request = request;
    data.url = url;
    data.readyState = 1;
    for (const cue of data.loaded) if (cue.track === track) track.removeCue(cue);
    data.loaded = [];
    const cors = owner.getAttribute('crossorigin');
    const current = () => !isDisposed() && data.request === request && node.parentElement === owner && node.getAttribute('src') === src;
    (async () => {
      let parsed;
      try {
        const response = await fetchResource(url, {mode:cors === null ? 'same-origin' : 'cors',
          credentials:cors?.toLowerCase() === 'use-credentials' ? 'include' : 'same-origin', signal:request.signal});
        if (response.ok) parsed = parseWebVTT(await response.text());
      } catch { /* Network errors and malformed WebVTT both fail this track. */ }
      if (!current()) return;
      if (parsed) for (const item of parsed) {
        const cue = new VTTCue(item.startTime,item.endTime,item.text);
        cue.id = item.id;
        for (const setting of item.settings.split(/[ \t]+/)) {
          const match = /^(vertical|align|size|position|line):([^:]+)$/.exec(setting);
          if (!match) continue;
          const [, key, value] = match;
          if (key === 'vertical' || key === 'align') cue[key] = value;
          else {
            const [number, alignment] = value.split(',');
            const percentage = /^(?:\d+|\d*\.\d+)%$/.test(number);
            if (percentage && Number.parseFloat(number) <= 100) {
              cue[key] = Number.parseFloat(number);
              if (key === 'line') cue.snapToLines = false;
            } else if (key === 'line' && /^-?\d+$/.test(number)) cue.line = Number(number);
            else continue;
            if (alignment && key !== 'size') cue[key + 'Align'] = alignment;
          }
        }
        track.addCue(cue);
        data.loaded.push(cue);
      }
      data.readyState = parsed ? 2 : 3;
      data.element.dispatchEvent(new Event(parsed ? 'load' : 'error'));
    })();
  }
  function elementTrack(element) {
    if (elements.has(element)) return elements.get(element);
    const data = {element, mode:element.hasAttribute('default') ? 'showing' : 'disabled', loaded:[], readyState:0};
    const track = new TextTrack(internal,data);
    elements.set(element,track);
    const observer = observe(() => loadTrack(track));
    observer.observe(nodeOf(element), {attributes:true, attributeFilter:['src']});
    loadTrack(track);
    return track;
  }
  Object.defineProperties(trackPrototype,{
    track:{configurable:true, enumerable:true, get() {return elementTrack(this);}},
    readyState:{configurable:true, enumerable:true, get() {return tracks.get(elementTrack(this)).readyState;}}
  });
  return {
    interfaces:{TextTrackCue, VTTCue, TextTrack, TextTrackList, TextTrackCueList},
    timeChanged(node, advancing, time) {
      const data = media.get(node);
      if (data) for (const track of data.list) {
        const t=tracks.get(track);
        if (t.mode === 'disabled' || advancing && !t.scheduled && t.notified && time >= t.from && time < t.until && t.notified===t.members) continue;
        scheduleUpdate(track,advancing);
      }
    },
    discover(element) {
      mediaState(element.parentElement);
      const track = elementTrack(element);
      loadTrack(track);
    }
  };
}
