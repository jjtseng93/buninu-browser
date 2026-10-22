// Runs solely in page-realm.js. Flat DOM references and reactive values, not a
// retained QML AST/component tree. The page owns timers/listeners and disposal.
export function createQmlRuntime(reactive, Qt) {
  const { state, untrack } = reactive;
  let disposers = null;
  const effect = fn => {
    const stop = reactive.effect(fn);
    disposers?.push(stop);
    return stop;
  };
  const elements = new WeakMap(), parents = new WeakMap(), factories = new WeakMap(), started = new WeakSet();
  const listen = (element, name, fn) => {
    element.addEventListener(name, fn);
    disposers?.push(() => element.removeEventListener(name, fn));
  };
  const enabled = value => {
    for (let v = value; v; v = parents.get(v)) if (v.enabled === false || v.visible === false) return false;
    return true;
  };
  const host = globalThis.__qmlHost;
  const Quickshell = {
    env: (name) => host?.env(name) ?? null,
    execDetached: (cmd) => host.run(cmd, () => {}),
  };
  const nodes = [],
    handlers = new WeakMap(),
    initial = [];
  const signal = () => {
    const listeners = new Set();
    const emit = (...args) => {
      for (const fn of [...listeners]) untrack(() => fn(...args));
    };
    emit.connect = (fn) => listeners.add(fn);
    emit.disconnect = (fn) => listeners.delete(fn);
    return emit;
  };
  const Hyprland = { rawEvent: signal() };
  const on = (value, name, fn) => {
    let map = handlers.get(value);
    if (!map) handlers.set(value, (map = new Map()));
    map.set(name, fn);
  };
  const emit = (value, name, ...args) =>
    untrack(() => handlers.get(value)?.get(name)?.(...args));
  const start = () => {
    if (!nodes.some(node => started.has(node.value))) host?.hyprEvents((event) => Hyprland.rawEvent(event));
    let pending = initial.splice(0),
      last;
    for (let pass = 0; pending.length && pass < 100; pass++) {
      const retry = [];
      for (const init of pending) {
        try {
          init();
        } catch (e) {
          last = e;
          retry.push(init);
        }
      }
      if (retry.length === pending.length) throw last;
      pending = retry;
    }
    if (pending.length) throw last;
    reactive.flush();
    for (const { value: v, type } of [...nodes]) {
      if (started.has(v)) continue;
      started.add(v);
      if (type === 'Repeater') {
        let instances = [];
        const clear = () => { for (const instance of instances) instance.dispose(); instances = []; };
        disposers?.push(clear);
        v.itemAt = index => instances[index]?.value ?? null;
        effect(() => {
          const model = v.model ?? [];
          if (typeof model === 'number' && (!Number.isFinite(model) || model < 0 || model > 1000)) throw Error('Repeater count must be between 0 and 1000');
          const data = typeof model === 'number'
            ? Array.from({length: Math.max(0, Math.floor(model))}, (_, i) => i) : model;
          if (!Array.isArray(data) || data.length > 1000) throw Error('Repeater supports arrays or counts up to 1000');
          untrack(() => {
            clear();
            for (let index = 0; index < data.length; index++) {
              const previous = disposers, stops = [], before = nodes.length, pendingBefore = initial.length;
              const dispose = owned => {
                for (const stop of stops.splice(0).reverse()) stop();
                for (const node of owned) {
                  elements.get(node.value)?.remove();
                  const at=nodes.indexOf(node); if(at>=0)nodes.splice(at,1);
                }
              };
              disposers = stops;
              let value;
              try { value = factories.get(v)(index, data[index]); }
              catch(error) { initial.splice(pendingBefore); dispose(nodes.slice(before)); clear(); v.count=0; throw error; }
              finally { disposers = previous; }
              const owned = nodes.slice(before);
              instances.push({value, dispose: () => dispose(owned)});
            }
            v.count = instances.length;
          });
        });
      } else if (type === 'TapHandler') {
        const target = elements.get(parents.get(v));
        if (!target) throw Error('TapHandler needs a visual parent');
        if (v.gesturePolicy !== 1) throw Error('Only TapHandler.ReleaseWithinBounds is supported');
        listen(target, 'click', event => {
          if (!v.enabled || !enabled(parents.get(v)) || !(v.acceptedButtons & (event.button === 2 ? 2 : event.button === 1 ? 4 : 1))) return;
          const rect = target.getBoundingClientRect();
          emit(v, 'onTapped', {position: {x:event.clientX-rect.x,y:event.clientY-rect.y}}, event.button ?? 0);
        });
      } else if (type === 'HoverHandler') {
        const target = elements.get(parents.get(v));
        if (!target) throw Error('HoverHandler needs a visual parent');
        effect(() => {target.style.cursor = v.enabled && v.cursorShape === 13 ? 'pointer' : 'auto';});
        listen(target, 'mouseenter', () => {v.hovered = v.enabled && enabled(parents.get(v));});
        listen(target, 'mouseleave', () => {v.hovered = false;});
      } else if (type === 'FileView') {
        let lastPath, lastWatch, unwatch;
        effect(() => {
          const path = v.path,
            watch = v.watchChanges;
          if (path === lastPath && watch === lastWatch) return;
          lastPath = path;
          lastWatch = watch;
          unwatch?.();
          if (path) {
            untrack(() => v.reload());
            if (watch)
              unwatch = host.watch(path, () => emit(v, 'onFileChanged'));
          }
        });
      } else if (type === 'Process') {
        let stop = null;
        effect(() => {
          if (v.running && !stop) {
            stop = host.run(v.command, (result) => {
              stop = null;
              if (v.stdout) {
                v.stdout.text = result.stdout;
                emit(v.stdout, 'onStreamFinished');
              }
              if (v.stderr) {
                v.stderr.text = result.stderr;
                emit(v.stderr, 'onStreamFinished');
              }
              if (!result.error) emit(v, 'onExited', result.exitCode, 0);
              v.running = false;
            });
          } else if (!v.running && stop) {
            stop();
            stop = null;
          }
        });
      } else if (type === 'Timer') {
        let timer;
        const schedule = () => {
          clearTimeout(timer);
          if (v.running)
            timer = setTimeout(
              () => {
                if (!v.repeat) v.running = false;
                emit(v, 'onTriggered');
                schedule();
              },
              Math.max(1, v.interval),
            );
        };
        effect(() => {
          v.running;
          v.interval;
          schedule();
        });
        v.restart = () => {
          v.running = true;
          schedule();
        };
        v.start = () => {
          v.running = true;
        };
        v.stop = () => {
          v.running = false;
        };
      } else if (type === 'Connections') {
        let links = [];
        effect(() => {
          for (const [signal, fn] of links) signal.disconnect(fn);
          links = [];
          const target = v.target;
          if (!target || v.enabled === false) return;
          for (const [name, fn] of handlers.get(v) ?? []) {
            const key = name.slice(2, 3).toLowerCase() + name.slice(3);
            if (target[key]?.connect) {
              target[key].connect(fn);
              links.push([target[key], fn]);
            } else if (!v.ignoreUnknownSignals)
              throw Error('Unknown QML signal: ' + key);
          }
        });
      } else if (type === 'TextMetrics' || type === 'FontMetrics') {
        const canvas = document.createElement('canvas'),
          ctx = canvas.getContext('2d');
        const measure = (text) => {
          ctx.font = `${v.font.pixelSize}px ${v.font.family}`;
          return ctx.measureText(String(text));
        };
        effect(() => {
          const m = measure(v.text || '0');
          if (type === 'TextMetrics') {
            v.advanceWidth = m.width;
            v.width = m.width;
          } else v.advanceWidth = (text) => measure(text).width;
          v.height = v.font.pixelSize;
          v.averageCharacterWidth = measure('0').width;
        });
      }
      for (const [name, fn] of handlers.get(v) ?? []) {
        const key = name.slice(2, 3).toLowerCase() + name.slice(3);
        if (v[key]?.connect) v[key].connect(fn);
      }
      for (const [name, fn] of handlers.get(v) ?? [])
        if (name.endsWith('Changed')) {
          const key = name.slice(2, -7);
          const prop = key[0].toLowerCase() + key.slice(1);
          let prev = v[prop];
          effect(() => {
            const next = v[prop];
            if (!Object.is(prev, next)) {
              prev = next;
              untrack(fn);
            }
          });
        }
    }
    reactive.flush();
  };
  const cssColor = (v) =>
    v && typeof v === 'object' && 'r' in v
      ? `rgba(${Math.round(v.r * 255)},${Math.round(v.g * 255)},${Math.round(v.b * 255)},${v.a})`
      : v;
  const viewport = state({ width: innerWidth, height: innerHeight });
  addEventListener('resize', () => {
    viewport.width = innerWidth;
    viewport.height = innerHeight;
  });
  const make = (element, type, parent = null) => {
    if(nodes.length>=2000)throw Error('QML live object limit (2000)');
    const value = state({
      width: null,
      height: null,
      implicitWidth: null,
      implicitHeight: null,
      x: 0,
      y: 0,
      color: ['Text', 'Label', 'TextField', 'Button'].includes(type)
        ? 'black'
        : 'transparent',
      radius: 0,
      opacity: 1,
      visible: true,
      enabled: true,
      clip: false,
      text: '',
      title: '',
      font: state({ pixelSize: 16, family: 'sans-serif', bold: false }),
      border: state({ width: 0, color: 'black' }),
      anchors: state({ fill: null, centerIn: null, horizontalCenter: null, margins: 0 }),
      horizontalAlignment: 0,
      textFormat: 0,
      spacing: 0,
      placeholderText: '',
      readOnly: false,
      selectByMouse: false,
      Accessible: state({ name: '' }),
    });
    nodes.push({ value, type });
    elements.set(value, element); parents.set(value, parent);
    Object.defineProperty(value, 'horizontalCenter', {get: () => ({item:value, edge:'horizontalCenter'})});
    if (type === 'Repeater') Object.assign(value, {model:[], count:0, itemAt:()=>null});
    if (type === 'TapHandler') Object.assign(value, {acceptedButtons:1, gesturePolicy:1});
    if (type === 'HoverHandler') Object.assign(value, {cursorShape:0, hovered:false});
    if (type === 'FileView') {
      Object.assign(value, {
        path: '',
        loaded: false,
        watchChanges: false,
        blockLoading: false,
        printErrors: true,
      });
      let body = '',
        readPath;
      value.reload = () => {
        const result = host.read(value.path);
        readPath = value.path;
        body = result.text;
        value.loaded = !result.error;
        emit(value, result.error ? 'onLoadFailed' : 'onLoaded', result.error);
      };
      value.text = () => {
        if (readPath !== value.path) value.reload();
        return body;
      };
      value.data = () => new TextEncoder().encode(value.text()).buffer;
      value.waitForJob = () => {
        if (readPath !== value.path) value.reload();
      };
    }
    if (type === 'Process')
      Object.assign(value, {
        running: false,
        command: [],
        stdout: null,
        stderr: null,
      });
    if (type === 'Timer')
      Object.assign(value, {
        interval: 1000,
        running: false,
        repeat: false,
        restart: () => {
          value.running = true;
        },
        start: () => {
          value.running = true;
        },
        stop: () => {
          value.running = false;
        },
      });
    if (type === 'Connections')
      Object.assign(value, {
        target: null,
        enabled: true,
        ignoreUnknownSignals: false,
      });
    if (
      [
        'Repeater',
        'TapHandler',
        'HoverHandler',
        'QtObject',
        'Singleton',
        'FileView',
        'Process',
        'Timer',
        'Connections',
        'StdioCollector',
        'TextMetrics',
        'FontMetrics',
      ].includes(type)
    )
      return value;
    if (type === 'Text' || type === 'Label') {
      const ctx = document.createElement('canvas').getContext('2d');
      effect(() => {
        ctx.font = `${value.font.bold?'bold ':''}${value.font.pixelSize}px ${value.font.family}`;
        const metrics = ctx.measureText(String(value.text));
        value.implicitWidth = metrics.width;
        value.implicitHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent || value.font.pixelSize;
      });
    }
    if (type === 'TextField') {
      element.addEventListener('input', () => {
        value.text = element.value;
      });
      element.addEventListener('keydown', (event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 'a'
        ) {
          element.selectionStart = 0;
          element.selectionEnd = element.value.length;
          event.preventDefault();
        }
      });
    }
    if (type === 'Button')
      element.addEventListener('keydown', (event) => {
        if (
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey &&
          ['Enter', ' '].includes(event.key)
        ) {
          event.preventDefault();
          if (value.enabled) element.click();
        }
      });
    effect(() => {
      const s = element.style,
        fill = value.anchors.fill,
        center = value.anchors.centerIn,
        horizontal = value.anchors.horizontalCenter;
      const margin = value.anchors.margins;
      const width = fill
        ? fill.width - margin * 2
        : (value.width ?? value.implicitWidth);
      const height = fill
        ? fill.height - margin * 2
        : (value.height ?? value.implicitHeight);
      const inColumn =
        element.parentElement?.getAttribute('data-qml-type') === 'Column';
      s.position = inColumn ? 'relative' : 'absolute';
      s.flexShrink = '0';
      s.boxSizing = 'border-box';
      s.width = width == null ? 'auto' : `${width}px`;
      s.height = height == null ? 'auto' : `${height}px`;
      s.left = `${fill ? margin : center ? center.width / 2 : horizontal ? (horizontal.item===parent?0:horizontal.item.x) + horizontal.item.width / 2 : value.x}px`;
      s.top = `${fill ? margin : center ? center.height / 2 : value.y}px`;
      s.transform = center ? 'translate(-50%, -50%)' : horizontal ? 'translateX(-50%)' : 'none';
      s.display = value.visible
        ? type === 'Column'
          ? 'flex'
          : 'block'
        : 'none';
      if (type === 'Column') {
        s.flexDirection = 'column';
        s.gap = `${value.spacing}px`;
        s.alignItems = 'flex-start';
      }
      s.opacity = String(value.opacity);
      s.pointerEvents = value.enabled ? 'auto' : 'none';
      s.overflow = value.clip ? 'hidden' : 'visible';
      if (['Text', 'Label', 'TextField', 'Button'].includes(type)) {
        if (type === 'TextField') {
          // Do not reset the caret/selection on unrelated reactive updates.
          if (element.value !== String(value.text))
            element.value = String(value.text);
          element.readOnly = value.readOnly;
          element.placeholder = value.placeholderText;
          s.userSelect = value.selectByMouse ? 'text' : 'none';
        } else element.textContent = String(value.text);
        if (type === 'TextField' || type === 'Button') {
          element.disabled = !value.enabled;
          s.padding = '8px 10px';
          s.backgroundColor = type === 'Button' ? '#bcebf0' : '#ffffff';
          s.border = '1px solid #6a8791';
          s.borderRadius = '5px';
          element.setAttribute(
            'aria-label',
            value.Accessible.name || String(value.text),
          );
        }
        s.color = cssColor(value.color);
        s.fontSize = `${value.font.pixelSize}px`;
        s.fontFamily = value.font.family;
        s.fontWeight = value.font.bold ? 'bold' : 'normal';
        s.whiteSpace = 'pre';
        s.textAlign =
          value.horizontalAlignment === 4 || type === 'Button'
            ? 'center'
            : 'left';
      } else {
        s.backgroundColor = cssColor(value.color);
        s.borderRadius = `${value.radius}px`;
        s.border = `${value.border.width}px solid ${cssColor(value.border.color)}`;
      }
      if (value.title) document.title = String(value.title);
    });
    return value;
  };
  // Bind through a setter supplied by generated code. A separate flag avoids
  // treating a binding's own write as an imperative assignment.
  const bind = (target, key, read, readonly = false, type = null) => {
    let writing = false;
    let stop;
    let cached = target[key];
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get() {
        return cached;
      },
      set(value) {
        if (!writing && readonly)
          throw new TypeError(`Readonly QML property: ${key}`);
        if (!writing) stop?.();
        cached = type === 'color' ? Qt.color(value) : value;
      },
    });
    initial.push(() => {
      read();
      stop = effect(() => {
        const value = read();
        writing = true;
        try {
          target[key] = value;
        } finally {
          writing = false;
        }
      });
    });
  };
  const alias = (target, key, read, write, readonly) =>
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get: read,
      set(value) {
        if (readonly) throw new TypeError(`Readonly QML alias: ${key}`);
        write(value);
      },
    });
  const create = (type, index, parent, before) => {
    const element = document.createElement(type==='TextField'?'input':type==='Button'?'button':'div');
    element.setAttribute('data-qml-node', String(index));
    element.setAttribute('data-qml-type', type);
    if(type==='TextField') element.setAttribute('type','text');
    if(type==='Button') element.setAttribute('type','button');
    (elements.get(parent) ?? document.body).insertBefore(element, elements.get(before) ?? null);
    if(['Repeater','TapHandler','HoverHandler'].includes(type))element.style.display='none';
    return make(element, type, parent);
  };
  return {
    create,
    element: value => elements.get(value),
    listen: (value, name, fn) => listen(elements.get(value),name,event=>{if(enabled(value))fn(event);}),
    delegate: (value, factory) => factories.set(value, factory),
    make,
    bind,
    alias,
    viewport,
    signal,
    on,
    start,
    Qt,
    Quickshell,
    Hyprland,
  };
}
