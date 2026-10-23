// Runs solely in page-realm.js. Flat DOM references and reactive values, not a
// retained QML AST/component tree. The page owns timers/listeners and disposal.
export function createQmlRuntime(
  reactive,
  Qt,
  createQmlModels,
  createQmlText,
  createQmlShapes,
  createQmlImages,
  createQmlTextures,
) {
  const { state, untrack } = reactive;
  let disposers = null;
  const effect = (fn) => {
    const stop = reactive.effect(fn);
    disposers?.push(stop);
    return stop;
  };
  const elements = new WeakMap(),
    parents = new WeakMap(),
    factories = new WeakMap(),
    started = new WeakSet();
  const propertyWrites = new WeakMap(),
    aliases = new WeakMap();
  const watchWrite = (target, key, callback) => {
    let map = propertyWrites.get(target);
    if (!map) propertyWrites.set(target, (map = new Map()));
    map.set(key, callback);
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor?.set) {
      let cached = target[key];
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        get: () => cached,
        set: (value) => {
          cached = value;
          callback();
        },
      });
    }
  };
  const owners = new WeakMap(),
    descriptions = new WeakMap(),
    structure = state({ version: 0 });
  const nonvisual = new Set([
    'LinearGradient',
    'XmlListModel',
    'XmlListModelRole',
    'WorkerScript',
    'LoggingCategory',
    'ListModel',
    'DelegateModel',
    'DelegateModelGroup',
    'PointHandler',
    'Binding',
    'Gradient',
    'GradientStop',
    'IpcHandler',
    'DragHandler',
    'FrameAnimation',
    'Behavior',
    'NumberAnimation',
    'PropertyAnimation',
    'PauseAnimation',
    'SequentialAnimation',
    'ParallelAnimation',
    'ScriptAction',
    'PropertyAction',
    'Component',
    'ShellRoot',
    'Scale',
    'Translate',
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
    'SplitParser',
    'TextMetrics',
    'FontMetrics',
  ]);
  const propertyName = (name) =>
    name.replace(/^(_*)([A-Z])/, (_, prefix, c) => prefix + c.toLowerCase());
  const childSets = new WeakMap();
  const childSet = (parent) => {
    if (!parent) return null;
    let box = childSets.get(parent);
    if (!box)
      childSets.set(
        parent,
        (box = { items: new Set(), version: state({ value: 0 }) }),
      );
    return box;
  };
  const moveChild = (value, previous, next) => {
    for (const [parent, adding] of [
      [previous, false],
      [next, true],
    ]) {
      const box = childSet(parent);
      if (!box) continue;
      if (adding) box.items.add(value);
      else box.items.delete(value);
      untrack(() => box.version.value++);
    }
  };
  const childrenOf = (parent) => {
    const box = childSet(parent);
    if (!box) return [];
    box.version.value;
    return [...box.items].filter(
      (value) => !nonvisual.has(owners.get(value)?.type),
    );
  };
  const metricsCache = new Map(),
    fontEpoch = state({ value: 0 });
  let metricsContext;
  const measureText = (font, text) => {
    fontEpoch.value;
    text = String(text);
    const key = font + '\0' + text;
    if (metricsCache.has(key)) return metricsCache.get(key);
    metricsContext ??= document.createElement('canvas').getContext('2d');
    metricsContext.font = font;
    const measured = metricsContext.measureText(text);
    // CanvasKit's empty paragraph can report a space advance; QML's empty
    // string still has a font line box, but no horizontal ink or advance.
    const metrics = text
      ? measured
      : {
          ...measured,
          width: 0,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: 0,
          actualBoundingBoxAscent: 0,
          actualBoundingBoxDescent: 0,
        };
    if (metricsCache.size >= 2048)
      metricsCache.delete(metricsCache.keys().next().value);
    if (text.length < 8192) metricsCache.set(key, metrics);
    return metrics;
  };
  document.fonts?.addEventListener?.('loadingdone', () => {
    metricsCache.clear();
    fontEpoch.value++;
  });
  const margin = (v, edge) =>
    v.anchors[edge + 'Margin'] ?? v.anchors.margins ?? 0;
  const anchor = (v, line) => {
    if (!line) return null;
    const item = line.item,
      parent = parents.get(v),
      edge = line.edge;
    const origin =
      item === parent
        ? 0
        : edge === 'top' ||
            edge === 'bottom' ||
            edge === 'verticalCenter' ||
            edge === 'baseline'
          ? item.y
          : item.x;
    return (
      origin +
      ({
        left: 0,
        top: 0,
        right: item.width,
        bottom: item.height,
        horizontalCenter: item.width / 2,
        verticalCenter: item.height / 2,
        baseline: item.baselineOffset,
      }[edge] ?? 0)
    );
  };
  const dimension = (v, key, topLevel = false) => {
    const a = v.anchors,
      start = key === 'width' ? 'left' : 'top',
      end = key === 'width' ? 'right' : 'bottom';
    if (a.fill) return a.fill[key] - margin(v, start) - margin(v, end);
    if (a[start] && a[end])
      return (
        anchor(v, a[end]) -
        anchor(v, a[start]) -
        margin(v, start) -
        margin(v, end)
      );
    if (owners.get(v)?.type === 'FloatingWindow') return viewport[key];
    return (
      v[key === 'width' ? 'implicitWidth' : 'implicitHeight'] ??
      (topLevel ? viewport[key] : 0)
    );
  };
  const position = (v, axis) => {
    const a = v.anchors,
      h = axis === 'x',
      start = h ? 'left' : 'top',
      end = h ? 'right' : 'bottom',
      center = h ? 'horizontalCenter' : 'verticalCenter',
      size = h ? v.width : v.height;
    if (!h && a.baseline)
      return anchor(v, a.baseline) - v.baselineOffset + (a.baselineOffset || 0);
    if (a.fill) return margin(v, start);
    if (a[start]) return anchor(v, a[start]) + margin(v, start);
    if (a[end]) return anchor(v, a[end]) - margin(v, end) - size;
    if (a.centerIn)
      return (
        ((h ? a.centerIn.width : a.centerIn.height) - size) / 2 +
        (a[center + 'Offset'] || 0)
      );
    if (a[center])
      return anchor(v, a[center]) - size / 2 + (a[center + 'Offset'] || 0);
    return 0;
  };
  const listen = (element, name, fn) => {
    element.addEventListener(name, fn);
    disposers?.push(() => element.removeEventListener(name, fn));
  };
  // QML Items do not take keyboard focus merely because a pointer hits them.
  // tabindex permits forceActiveFocus(), but HTML's implicit click focus must
  // only apply to actual input controls; panel keyboard owners retain focus.
  listen(document, 'mousedown', (event) => {
    if (!event.target?.closest?.('input,textarea,select,button'))
      event.preventDefault();
  });
  const enabled = (value) => {
    for (let v = value; v; v = parents.get(v))
      if (
        !nonvisual.has(owners.get(v)?.type) &&
        (v.enabled === false || v.visible === false)
      )
        return false;
    return true;
  };
  const focusElements = new WeakMap(),
    focusTargets = new WeakMap();
  let activeFocusValues = new Set(),
    activeWindow = null;
  const isFocusScope = (value) =>
    ['FocusScope', 'ListView', 'GridView'].includes(owners.get(value)?.type);
  function activateFocus(value) {
    const next = new Set();
    if (value) {
      next.add(value);
      for (
        let parent = parents.get(value);
        parent;
        parent = parents.get(parent)
      ) {
        if (isFocusScope(parent)) {
          next.add(parent);
          focusTargets.set(parent, value);
        }
      }
    }
    for (const item of activeFocusValues)
      if (!next.has(item)) item.activeFocus = false;
    for (const item of next) item.activeFocus = true;
    activeFocusValues = next;
    const window = value?.Window.window ?? null;
    if (activeWindow && activeWindow !== window)
      activeWindow.activeFocusItem = null;
    if (window) window.activeFocusItem = value;
    activeWindow = window;
  }
  function focusTarget(value) {
    const selected = isFocusScope(value) && focusTargets.get(value);
    if (selected && elements.get(selected)?.isConnected && enabled(selected)) {
      for (let p = parents.get(selected); p; p = parents.get(p))
        if (p === value) return selected;
    }
    return value;
  }
  const button = (event) =>
    event.button === 2
      ? 2
      : event.button === 1
        ? 4
        : event.button >= 3 && event.button < 27
          ? 2 ** event.button
          : event.button === 0
            ? 1
            : 0;
  const pointer = (value, element, event) => {
    const rect = element.getBoundingClientRect();
    return {
      x: event.clientX - rect.x,
      y: event.clientY - rect.y,
      button: button(event),
      buttons: event.buttons ?? 0,
      modifiers:
        (event.shiftKey ? Qt.ShiftModifier : 0) |
        (event.ctrlKey ? Qt.ControlModifier : 0) |
        (event.altKey ? Qt.AltModifier : 0) |
        (event.metaKey ? Qt.MetaModifier : 0),
      accepted: true,
    };
  };
  const ipcHandlers = new Map();
  const behaviors = new WeakMap(),
    animationStops = new WeakMap();
  let animationWrite = false;
  const ease = (t, type) =>
    type === 1
      ? t * t
      : type === 2
        ? 1 - (1 - t) ** 2
        : type === 3
          ? t < 0.5
            ? 2 * t * t
            : 1 - (-2 * t + 2) ** 2 / 2
          : type === 5
            ? t ** 3
            : type === 6
              ? 1 - (1 - t) ** 3
              : type === 7
                ? t < 0.5
                  ? 4 * t ** 3
                  : 1 - (-2 * t + 2) ** 3 / 2
                : type === 10
                  ? 1 - (1 - t) ** 4
                  : type === 14
                    ? 1 - (1 - t) ** 5
                    : type === 18
                      ? Math.sin((t * Math.PI) / 2)
                      : type === 22
                        ? t === 1
                          ? 1
                          : 1 - 2 ** (-10 * t)
                        : t;
  const animate = (animation, done = () => {}, override = null) => {
    animationStops.get(animation)?.();
    let cancelled = false,
      frame,
      childStops = [],
      repeat = 0;
    const stop = () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      for (const stop of childStops) stop();
    };
    animationStops.set(animation, stop);
    const type = owners.get(animation)?.type;
    const cycle = () => {
      if (cancelled) return;
      const finish = () => {
        if (cancelled) return;
        if (animation.loops === -1 || ++repeat < (animation.loops || 1)) {
          cycle();
          return;
        }
        animationStops.delete(animation);
        animation.running = false;
        emit(animation, 'onFinished');
        emit(animation, 'onStopped');
        done();
      };
      if (type === 'SequentialAnimation' || type === 'ParallelAnimation') {
        const children = nodes
          .filter((n) => parents.get(n.value) === animation)
          .map((n) => n.value);
        let at = 0;
        if (!children.length) {
          finish();
          return;
        }
        const next = () => {
          if (at === children.length) {
            finish();
            return;
          }
          childStops.push(animate(children[at++], next));
        };
        if (type === 'SequentialAnimation') next();
        else
          for (const child of children)
            childStops.push(
              animate(child, () => {
                if (++at === children.length) finish();
              }),
            );
        return;
      }
      if (type === 'ScriptAction') {
        emit(animation, 'script');
        finish();
        return;
      }
      if (type === 'PropertyAction') {
        if (animation.target)
          animation.target[animation.property] = animation.value;
        finish();
        return;
      }
      const targets = override
        ? [override.target]
        : (animation.targets?.length
            ? animation.targets
            : [animation.target]
          ).filter(Boolean);
      const keys = override
        ? [override.key]
        : String(animation.properties || animation.property || '')
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean);
      const writes = targets.flatMap((target) =>
        keys.map((key) => ({
          target,
          key,
          from: override
            ? override.from
            : (animation.from ?? Number(target[key])),
          to: override ? override.to : animation.to,
        })),
      );
      const duration = Math.max(0, Number(animation.duration) || 0),
        startedAt = performance.now();
      const tick = (now) => {
        if (cancelled) return;
        const progress = duration
            ? Math.min(1, (now - startedAt) / duration)
            : 1,
          t = ease(progress, animation.easing?.type);
        animationWrite = true;
        try {
          for (const w of writes)
            if (Number.isFinite(w.from) && Number.isFinite(w.to))
              w.target[w.key] = w.from + (w.to - w.from) * t;
        } finally {
          animationWrite = false;
        }
        if (progress < 1) frame = requestAnimationFrame(tick);
        else finish();
      };
      frame = requestAnimationFrame(tick);
    };
    cycle();
    return stop;
  };
  const host = globalThis.__qmlHost;
  const textContent = createQmlText(document, (source) => {
    if (!host?.markdown)
      throw Error('QML MarkdownText needs the local application host');
    return host.markdown(source);
  });
  const sharedValues = new Map(),
    scopedQt = new Map(),
    components = new Map(),
    later = new Map();
  const destroyedNodes = new WeakSet();
  function disposeScope(stops) {
    const owned = nodes.filter((node) => node.scope === stops);
    // Children have their own Component.onDestruction too. Emit while sibling
    // state and bindings still exist; nested factories dispose their own scopes.
    for (const node of owned)
      if (!destroyedNodes.has(node.value)) {
        destroyedNodes.add(node.value);
        try {
          emit(node.value, 'Component.onDestruction');
        } catch (error) {
          console.error('QML destruction handler:', error);
        }
      }
    for (const stop of stops.splice(0).reverse()) {
      try {
        stop();
      } catch (error) {
        console.error('QML cleanup:', error);
      }
    }
    for (const node of owned) {
      moveChild(node.value, parents.get(node.value), null);
      elements.get(node.value)?.remove();
      const at = nodes.indexOf(node);
      if (at >= 0) nodes.splice(at, 1);
    }
    untrack(() => structure.version++);
  }
  const instantiate = (factory, parent, properties = {}) => {
    const previous = disposers,
      stops = [],
      pendingBefore = initial.length;
    disposers = stops;
    let value,
      disposed = false;
    const destroy = () => {
      if (disposed) return;
      disposed = true;
      disposeScope(stops);
    };
    try {
      value = factory(parent, properties);
      value.destroy = (delay = 0) =>
        delay > 0 ? setTimeout(destroy, delay) : destroy();
    } catch (error) {
      initial.splice(pendingBefore);
      destroy();
      throw error;
    } finally {
      disposers = previous;
    }
    // Ownership follows the requested parent, not whichever unrelated binding
    // or Loader happened to invoke the factory during a reactive flush.
    (owners.has(parent) ? owners.get(parent).scope : previous)?.push(destroy);
    return value;
  };
  const qt = (base) => {
    if (scopedQt.has(base)) return scopedQt.get(base);
    const value = {
      ...Qt,
      openUrlExternally(url) {
        if (!host) return false;
        try {
          host.run(['xdg-open', new URL(String(url), base).href], () => {});
          return true;
        } catch {
          return false;
        }
      },
      resolvedUrl: (path) => new URL(String(path), base).href,
      callLater(fn, ...args) {
        later.set(fn, args);
        queueMicrotask(() => {
          const args = later.get(fn);
          if (args) {
            later.delete(fn);
            fn(...args);
          }
        });
      },
      createComponent(path) {
        const url = new URL(String(path), base).href,
          key = url + '\n' + [...sharedValues.keys()].sort().join('\n');
        if (components.has(key)) return components.get(key);
        let factory,
          error = '',
          compiledKeys = [...sharedValues.keys()].sort().join('\n');
        try {
          if (!host) throw Error('Dynamic local components need a QML host');
          factory = new Function(
            'mount',
            'properties',
            'return ' + host.compile(url, [...sharedValues.keys()]),
          );
        } catch (e) {
          error = String(e.message);
        }
        const result = {
          status: factory ? 1 : 3,
          errorString: () => error,
          // Releasing a Component does not destroy objects it already created.
          destroy() { if (components.get(key) === result) components.delete(key); },
          createObject(parent, properties = {}) {
            if (!factory) return null;
            try {
              const keys = [...sharedValues.keys()].sort().join('\n');
              if (keys !== compiledKeys) {
                factory = new Function(
                  'mount',
                  'properties',
                  'return ' + host.compile(url, [...sharedValues.keys()]),
                );
                compiledKeys = keys;
              }
              return instantiate(factory, parent, properties);
            } catch (e) {
              error = String(e.message);
              console.error('QML createObject: ' + (e.stack || error));
              return null;
            }
          },
        };
        components.set(key, result);
        return result;
      },
    };
    scopedQt.set(base, value);
    return value;
  };
  const Quickshell = {
    env: (name) => host?.env(name) ?? null,
    shellDir: host?.shellDir ?? '',
    processId: host?.processId ?? 0,
    execDetached: (cmd) => host.run(cmd, () => {}),
  };
  const nodes = [],
    handlers = new WeakMap(),
    baselines = new WeakMap(),
    initial = [];
  // Connections must follow a changed target before a same-handler emission.
  // Drain only invalidated wiring, never unrelated layout/render effects.
  const pendingConnections = new Set();
  let connectingSignals = false;
  const syncConnections = () => {
    if (connectingSignals) return;
    connectingSignals = true;
    try {
      let passes = 0;
      while (pendingConnections.size) {
        if (++passes > 100) throw Error('QML Connections binding cycle');
        const batch = [...pendingConnections];
        pendingConnections.clear();
        for (const stop of batch) untrack(() => stop.run());
      }
    } finally { connectingSignals = false; }
  };
  const signal = () => {
    const listeners = new Set();
    const emit = (...args) => {
      syncConnections();
      for (const fn of [...listeners]) untrack(() => fn(...args));
    };
    Object.defineProperty(emit, 'listenerCount', { get: () => listeners.size });
    emit.connect = (fn) => listeners.add(fn);
    emit.disconnect = (fn) => listeners.delete(fn);
    return emit;
  };
  const Hyprland = { rawEvent: signal() };
  Quickshell.lastWindowClosed = signal();
  const on = (value, name, fn) => {
    // QML signal handlers execute with their declaring object as `this`,
    // including handlers connected later or merged with inherited handlers.
    fn = fn.bind(value);
    let map = handlers.get(value);
    if (!map) handlers.set(value, (map = new Map()));
    const previous = map.get(name);
    map.set(name, previous ? (...args) => { previous(...args); fn(...args); } : fn);
    if (name.endsWith('Changed') && /^on[A-Z_]/.test(name)) {
      let values = baselines.get(value);
      if (!values) baselines.set(value, (values = new Map()));
      values.set(name, value[propertyName(name.slice(2, -7))]);
    }
  };
  const emit = (value, name, ...args) =>
    untrack(() => handlers.get(value)?.get(name)?.(...args));
  const start = () => {
    if (!nodes.some((node) => started.has(node.value)))
      host?.hyprEvents((event) => Hyprland.rawEvent(event));
    let pending = initial.splice(0),
      last;
    for (let pass = 0; pending.length && pass < 100; pass++) {
      const retry = [],
        revision = reactive.revision;
      for (const init of pending) {
        try {
          init();
        } catch (e) {
          if (e.qmlFatal) throw e;
          last = e;
          retry.push(init);
        }
      }
      const incomplete = reactive.flush(true);
      if (incomplete) last = incomplete;
      if (retry.length === pending.length && reactive.revision === revision)
        throw last;
      pending = retry;
    }
    if (pending.length) throw last;
    reactive.flush();
    for (const node of [...nodes])
      if (node.paint && !node.painted) {
        node.painted = true;
        const previous = disposers;
        disposers = node.scope;
        try {
          effect(node.paint);
        } finally {
          disposers = previous;
        }
      }
    for (const node of [...nodes]) {
      const { value: v, type } = node;
      if (started.has(v)) continue;
      started.add(v);
      const previousScope = disposers;
      disposers = node.scope;
      try {
        for (const [name, fn] of handlers.get(v) ?? []) {
          const key = propertyName(name.slice(2));
          if (!name.endsWith('Changed') && v[key]?.connect) v[key].connect(fn);
        }
        for (const [name, fn] of handlers.get(v) ?? [])
          if (name.endsWith('Changed')) {
            const key = name.slice(2, -7);
            const prop = propertyName(key);
            let prev = baselines.get(v)?.has(name)
              ? baselines.get(v).get(name)
              : v[prop];
            effect(() => {
              const next = v[prop];
              if (!Object.is(prev, next)) {
                prev = next;
                untrack(fn);
              }
            });
          }
        const element = elements.get(v),
          eventHandlers = handlers.get(v);
        if (!nonvisual.has(type)) {
          const dispatchKey = (target, eventType, event, seen = new Set()) => {
            if (
              seen.has(target) ||
              !enabled(target) ||
              target.Keys?.enabled === false
            )
              return false;
            seen.add(target);
            for (const next of target.Keys?.forwardTo ?? [])
              if (next && dispatchKey(next, eventType, event, seen))
                return true;
            const callbacks = handlers.get(target);
            const name =
              event.key === 'ContextMenu'
                ? 'Menu'
                : event.key === 'AltGraph'
                  ? 'AltGr'
                  : event.key === ' '
                    ? 'Space'
                    : event.key === 'Enter'
                      ? event.code === 'NumpadEnter'
                        ? 'Enter'
                        : 'Return'
                      : event.key === 'Tab' && event.shiftKey
                        ? 'Backtab'
                        : event.key?.replace(/^Arrow/, '');
            const key =
              Qt['Key_' + name] ??
              (event.key?.length === 1
                ? event.key.toUpperCase().charCodeAt(0)
                : 0);
            const specific =
              eventType === 'keydown' ? 'Keys.on' + name + 'Pressed' : null;
            const data = {
              key,
              text: event.key?.length === 1 ? event.key : '',
              modifiers:
                (event.shiftKey ? Qt.ShiftModifier : 0) |
                (event.ctrlKey ? Qt.ControlModifier : 0) |
                (event.altKey ? Qt.AltModifier : 0) |
                (event.metaKey ? Qt.MetaModifier : 0),
              isAutoRepeat: !!event.repeat,
              accepted: !!callbacks?.has(specific),
            };
            if (specific && callbacks?.has(specific))
              emit(target, specific, data);
            if (!data.accepted)
              emit(
                target,
                eventType === 'keydown' ? 'Keys.onPressed' : 'Keys.onReleased',
                data,
              );
            return data.accepted;
          };
          for (const eventType of ['keydown', 'keyup'])
            listen(element, eventType, (event) => {
              if (event.defaultPrevented) return;
              if (dispatchKey(v, eventType, event)) {
                event.preventDefault();
                event.stopPropagation();
              }
            });
          if (['TextInput', 'TextField'].includes(type))
            listen(element, 'keydown', (event) => {
              if (
                event.key === 'Enter' &&
                !event.defaultPrevented &&
                enabled(v)
              ) {
                emit(v, 'onAccepted');
                emit(v, 'onEditingFinished');
                event.preventDefault();
                event.stopPropagation();
              }
            });
        }
        if (['TextInput', 'TextField', 'TextEdit'].includes(type))
          listen(element, 'keydown', (event) => {
            if (!enabled(v) || event.defaultPrevented) return;
            const editing =
              [
                'Backspace',
                'Delete',
                'ArrowLeft',
                'ArrowRight',
                'Home',
                'End',
              ].includes(event.key) ||
              (type === 'TextEdit' &&
                ['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key));
            const typing =
              !v.readOnly &&
              event.key?.length === 1 &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey;
            const shortcut =
              (event.ctrlKey || event.metaKey) &&
              ['a', 'c', 'v', 'x'].includes(event.key?.toLowerCase());
            if (editing || typing || shortcut) event.stopPropagation();
          });
        if (eventHandlers?.has('onClicked') && type !== 'MouseArea')
          listen(element, 'click', (event) => {
            if (enabled(v)) emit(v, 'onClicked', pointer(v, element, event));
          });
        if (type === 'MouseArea') {
          const areaTarget = v.propagateComposedEvents
            ? (elements.get(parents.get(v)) ?? element)
            : element;
          const update = (event) => {
            const data = pointer(v, element, event);
            v.mouseX = data.x;
            v.mouseY = data.y;
            return data;
          };
          // A rejected Qt MouseArea press falls through to the next item in
          // stacking order, not just to DOM ancestors. Retain that recipient
          // for the release/click of this gesture (including nested overlays).
          let passTarget = null, forwarding = false;
          const forward = (event, target) => {
            if (!target || areaTarget.contains(target) || forwarding) return;
            forwarding = true;
            try {
              target.dispatchEvent(new MouseEvent(event.type, {
                bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY,
                button: event.button, buttons: event.buttons, detail: event.detail,
                ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
              }));
              event.preventDefault();
              event.stopPropagation();
            } finally { forwarding = false; }
          };
          listen(areaTarget, 'mousedown', (event) => {
            if (!enabled(v) || forwarding) return;
            const data = update(event);
            data.accepted = !!(v.acceptedButtons & button(event));
            if (data.accepted) {
              v.pressed = true;
              emit(v, 'onPressed', data);
            }
            passTarget = null;
            if (!data.accepted) {
              v.pressed = false;
              const old = areaTarget.style.pointerEvents;
              areaTarget.style.pointerEvents = 'none';
              try {
                passTarget = document.elementFromPoint(event.clientX, event.clientY);
                if (passTarget && areaTarget.contains(passTarget)) passTarget = null;
                forward(event, passTarget);
              }
              finally { areaTarget.style.pointerEvents = old; }
            }
          });
          for (const type of ['mouseup', 'click', 'dblclick'])
            listen(areaTarget, type, event => { if (passTarget) forward(event, passTarget); });
          listen(document, 'mousemove', (event) => {
            if (v.pressed || v.hoverEnabled)
              emit(v, 'onPositionChanged', update(event));
          });
          listen(document, 'mouseup', (event) => {
            if (!v.pressed) return;
            v.pressed = false;
            emit(v, 'onReleased', update(event));
          });
          listen(areaTarget, 'click', (event) => {
            if (!passTarget && enabled(v) && v.acceptedButtons & button(event))
              emit(v, 'onClicked', update(event));
          });
          listen(areaTarget, 'dblclick', (event) => {
            if (!passTarget && enabled(v)) emit(v, 'onDoubleClicked', update(event));
          });
          listen(areaTarget, 'mouseenter', (event) => {
            v.containsMouse = true;
            if (v.hoverEnabled) {
              update(event);
              emit(v, 'onEntered');
            }
          });
          listen(areaTarget, 'mouseleave', () => {
            v.containsMouse = false;
            if (v.hoverEnabled) emit(v, 'onExited');
          });
          listen(areaTarget, 'wheel', (event) => {
            if (!enabled(v) || !eventHandlers?.has('onWheel')) return;
            const data = {
              ...update(event),
              angleDelta: { x: -event.deltaX, y: -event.deltaY },
              pixelDelta: { x: 0, y: 0 },
              phase: 0,
              inverted: false,
              accepted: true,
            };
            emit(v, 'onWheel', data);
            if (data.accepted) event.preventDefault();
          });
        }
        models.start(v, type);
        if (type === 'WorkerScript') {
          let worker, current;
          const open = () => {
            const source = v.source;
            if (source === current) return;
            current = source;
            worker?.();
            worker = null;
            v.ready = false;
            if (!source) return;
            if (!host?.worker)
              throw Error('WorkerScript needs the local application host');
            worker = host.worker(
              new URL(source, descriptions.get(v).url).href,
              (message) => emit(v, 'onMessage', message),
              () => (v.ready = true),
              (error) => {
                v.ready = false;
                console.error('QML WorkerScript: ' + error);
              },
            );
          };
          v.sendMessage = (message) => {
            open();
            if (!worker) throw Error('WorkerScript source is empty');
            worker.send(message);
          };
          effect(open);
          disposers?.push(() => worker?.());
        }
        if (type === 'IpcHandler') {
          let target;
          effect(() => {
            if (target) ipcHandlers.delete(target);
            target = v.enabled ? v.target : null;
            if (target) ipcHandlers.set(target, v);
          });
          disposers?.push(() => {
            if (target) ipcHandlers.delete(target);
          });
        }
        if (type === 'Binding') {
          let oldTarget,
            oldKey,
            oldValue,
            applied = false;
          const restore = () => {
            if (applied && oldTarget && v.restoreMode !== 0)
              oldTarget[oldKey] = oldValue;
            applied = false;
          };
          effect(() => {
            const target = v.target,
              key = v.property,
              when = v.when,
              next = v.value;
            untrack(() => {
              if (!when || target !== oldTarget || key !== oldKey) restore();
              if (!when || !target || !key) return;
              if (!applied) {
                oldTarget = target;
                oldKey = key;
                oldValue = target[key];
                applied = true;
              }
              target[key] = next;
            });
          });
          disposers?.push(restore);
        }
        if (type === 'PointHandler') {
          const target = elements.get(parents.get(v));
          const update = (event) => {
            const p = pointer(v, target, event);
            v.point = {
              position: { x: p.x, y: p.y },
              scenePosition: { x: event.clientX, y: event.clientY },
            };
          };
          listen(target, 'mousedown', (event) => {
            if (
              v.enabled &&
              enabled(parents.get(v)) &&
              v.acceptedButtons & button(event)
            ) {
              update(event);
              v.active = true;
            }
          });
          listen(document, 'mousemove', (event) => {
            if (v.active) update(event);
          });
          listen(document, 'mouseup', (event) => {
            if (v.active) {
              update(event);
              v.active = false;
            }
          });
        }
        if (type === 'DropArea') {
          const data = (event) => {
            const transfer = event.dataTransfer,
              rect = element.getBoundingClientRect(),
              types = [...(transfer?.types ?? [])];
            const get = (name) => transfer?.getData(name) || '';
            return {
              x: event.clientX - rect.x,
              y: event.clientY - rect.y,
              source: null,
              keys: types,
              formats: types,
              urls: get('text/uri-list')
                .split(/\r?\n/)
                .filter((line) => line && !line.startsWith('#')),
              text: get('text/plain'),
              hasText: types.includes('text/plain'),
              hasUrls: types.includes('text/uri-list'),
              proposedAction: 1,
              supportedActions: 7,
              action: 1,
              accepted: true,
              getDataAsString: get,
              acceptProposedAction() {
                this.accepted = true;
                this.action = this.proposedAction;
              },
              accept(action) {
                this.accepted = true;
                this.action = action;
              },
            };
          };
          for (const [eventType, handler] of [
            ['dragenter', 'onEntered'],
            ['dragover', 'onPositionChanged'],
            ['drop', 'onDropped'],
          ])
            listen(element, eventType, (event) => {
              if (!enabled(v)) return;
              const d = data(event);
              if (v.keys.length && !v.keys.some((key) => d.keys.includes(key)))
                return;
              v.drag = { x: d.x, y: d.y, source: d.source };
              emit(v, handler, d);
              v.containsDrag = eventType !== 'drop' && d.accepted;
              if (d.accepted) {
                event.preventDefault();
                event.stopPropagation();
              }
            });
          listen(element, 'dragleave', () => {
            v.containsDrag = false;
            emit(v, 'onExited');
          });
        }
        if (type === 'FrameAnimation') {
          let frame, last;
          const tick = (now) => {
            frame = undefined;
            if (!v.running || v.paused) return;
            v.frameTime = last === undefined ? 0 : (now - last) / 1000;
            last = now;
            v.smoothFrameTime = v.smoothFrameTime
              ? 0.9 * v.smoothFrameTime + 0.1 * v.frameTime
              : v.frameTime;
            v.elapsedTime += v.frameTime;
            v.currentFrame++;
            emit(v, 'onTriggered');
            frame = requestAnimationFrame(tick);
          };
          effect(() => {
            if (v.running && !v.paused) {
              if (frame === undefined) {
                last = undefined;
                frame = requestAnimationFrame(tick);
              }
            } else if (frame !== undefined) {
              cancelAnimationFrame(frame);
              frame = undefined;
            }
          });
          disposers?.push(() => {
            if (frame !== undefined) cancelAnimationFrame(frame);
          });
        }
        if (type === 'DragHandler') {
          const target = elements.get(parents.get(v));
          let origin = null,
            translation,
            startTarget;
          listen(target, 'mousedown', (event) => {
            if (
              !v.enabled ||
              !enabled(parents.get(v)) ||
              !(v.acceptedButtons & button(event))
            )
              return;
            origin = { x: event.clientX, y: event.clientY };
            translation = { ...v.persistentTranslation };
            startTarget = { x: v.target?.x || 0, y: v.target?.y || 0 };
          });
          listen(document, 'mousemove', (event) => {
            if (!origin) return;
            const x = v.xAxis.enabled ? event.clientX - origin.x : 0,
              y = v.yAxis.enabled ? event.clientY - origin.y : 0;
            if (!v.active && Math.hypot(x, y) < v.dragThreshold) return;
            v.centroid = {
              position: {
                x: pointer(v, target, event).x,
                y: pointer(v, target, event).y,
              },
              scenePosition: { x: event.clientX, y: event.clientY },
            };
            v.active = true;
            v.activeTranslation = { x, y };
            v.persistentTranslation = {
              x: translation.x + x,
              y: translation.y + y,
            };
            if (v.target) {
              if (v.xAxis.enabled)
                v.target.x = Math.max(
                  v.xAxis.minimum,
                  Math.min(v.xAxis.maximum, startTarget.x + x),
                );
              if (v.yAxis.enabled)
                v.target.y = Math.max(
                  v.yAxis.minimum,
                  Math.min(v.yAxis.maximum, startTarget.y + y),
                );
            }
            event.preventDefault();
          });
          listen(document, 'mouseup', () => {
            origin = null;
            v.activeTranslation = { x: 0, y: 0 };
            v.active = false;
          });
        }
        if (type === 'Image') images(v, element, descriptions.get(v).url);
        if (
          [
            'NumberAnimation',
            'PropertyAnimation',
            'PauseAnimation',
            'SequentialAnimation',
            'ParallelAnimation',
          ].includes(type)
        ) {
          disposers?.push(() => animationStops.get(v)?.());
          effect(() => {
            if (v.running) {
              if (!animationStops.has(v))
                untrack(() => {
                  emit(v, 'onStarted');
                  animate(v);
                });
            } else {
              animationStops.get(v)?.();
              animationStops.delete(v);
            }
          });
        }
        if (type === 'Repeater') {
          let instances = [];
          const clear = () => {
            for (const instance of instances) instance.dispose();
            instances = [];
          };
          disposers?.push(clear);
          v.itemAt = (index) => instances[index]?.value ?? null;
          effect(() => {
            const model = v.model ?? [];
            if (
              typeof model === 'number' &&
              (!Number.isFinite(model) || model < 0 || model > 1000)
            )
              throw Error('Repeater count must be between 0 and 1000');
            const data =
              typeof model === 'number'
                ? Array.from(
                    { length: Math.max(0, Math.floor(model)) },
                    (_, i) => i,
                  )
                : model;
            if (!Array.isArray(data) || data.length > 1000)
              throw Error('Repeater supports arrays or counts up to 1000');
            untrack(() => {
              clear();
              for (let index = 0; index < data.length; index++) {
                const previous = disposers,
                  stops = [],
                  before = nodes.length,
                  pendingBefore = initial.length;
                const dispose = () => disposeScope(stops);
                disposers = stops;
                let value;
                try {
                  value = factories.get(v)(index, data[index]);
                } catch (error) {
                  initial.splice(pendingBefore);
                  dispose();
                  clear();
                  v.count = 0;
                  throw error;
                } finally {
                  disposers = previous;
                }
                instances.push({
                  value,
                  dispose,
                });
              }
              v.count = instances.length;
            });
          });
        } else if (type === 'Loader') {
          let currentSource,
            currentComponent,
            currentVersion,
            currentActive,
            currentItem = null,
            loading = false,
            disposed = false,
            initialProperties = v._initialProperties ?? {};
          const clear = () => {
            currentItem?.destroy?.();
            v.item = null;
            v.status = 0;
            v.progress = 0;
          };
          disposers?.push(() => {
            disposed = true;
            clear();
          });
          let settingSource = false;
          const load = () => {
            if (settingSource || loading || disposed) return;
            const source = v.source,
              component = v.sourceComponent,
              active = v.active,
              version = v._reload;
            if (
              active === currentActive &&
              source === currentSource &&
              component === currentComponent &&
              version === currentVersion
            )
              return;
            loading = true;
            try {
              untrack(() => {
                clear();
                currentActive = active;
                currentSource = source;
                currentComponent = component;
                currentVersion = version;
                if (!active || (!source && !component)) return;
                v.status = 2;
                const factory =
                  component ||
                  qt(descriptions.get(v).url).createComponent(source);
                if (!factory || factory.status === 3) {
                  v.status = 3;
                  console.error(
                    'QML Loader: ' +
                      (factory?.errorString?.() || 'Invalid component'),
                  );
                  return;
                }
                const props = { ...initialProperties };
                if (
                  descriptions.get(v).properties.includes('width') ||
                  v.anchors.fill ||
                  (v.anchors.left && v.anchors.right)
                )
                  props.width = Qt.binding(() => v.width);
                if (
                  descriptions.get(v).properties.includes('height') ||
                  v.anchors.fill ||
                  (v.anchors.top && v.anchors.bottom)
                )
                  props.height = Qt.binding(() => v.height);
                v.item = factory.createObject(v, props);
                v.status = v.item ? 1 : 3;
                v.progress = v.item ? 1 : 0;
                if (v.item) emit(v, 'onLoaded');
              });
            } finally {
              loading = false;
            }
          };
          // A synchronous Loader must materialize a dirtied active binding before
          // the very next statement reads item, without flushing unrelated effects.
          Object.defineProperty(v, 'item', {
            configurable: true,
            enumerable: true,
            get() {
              if (!loading && !disposed) untrack(load);
              return currentItem;
            },
            set(next) {
              currentItem = next;
            },
          });
          v.setSource = (source, properties = {}) => {
            initialProperties = properties;
            settingSource = true;
            try {
              v.source = String(source);
              v._reload++;
            } finally {
              settingSource = false;
            }
            load();
          };
          for (const key of ['active', 'source', 'sourceComponent'])
            watchWrite(v, key, () => untrack(load));
          effect(load);
          effect(() => {
            v.implicitWidth = v.item?.implicitWidth ?? v.item?.width ?? 0;
            v.implicitHeight = v.item?.implicitHeight ?? v.item?.height ?? 0;
          });
        } else if (type === 'TapHandler') {
          const target = elements.get(parents.get(v));
          if (!target) throw Error('TapHandler needs a visual parent');
          const update = (event) => {
            const data = pointer(v, target, event);
            v.point = {
              position: { x: data.x, y: data.y },
              scenePosition: { x: event.clientX, y: event.clientY },
              pressedButtons: event.buttons ?? 0,
              modifiers: data.modifiers,
            };
            return v.point;
          };
          listen(target, 'mousedown', (event) => {
            if (
              v.enabled &&
              enabled(parents.get(v)) &&
              v.acceptedButtons & button(event)
            ) {
              update(event);
              v.pressed = true;
            }
          });
          listen(document, 'mousemove', (event) => {
            if (v.pressed) update(event);
          });
          listen(document, 'mouseup', (event) => {
            if (v.pressed) {
              update(event);
              v.pressed = false;
            }
          });
          listen(target, 'click', (event) => {
            if (
              !v.enabled ||
              !enabled(parents.get(v)) ||
              !(v.acceptedButtons & button(event))
            )
              return;
            const point = update(event);
            if (
              parents.get(v).containmentMask &&
              !parents.get(v).contains(point.position)
            )
              return;
            v.tapCount = event.detail || 1;
            emit(v, 'onTapped', point, button(event));
            if ((event.detail ?? 1) <= 1)
              emit(v, 'onSingleTapped', point, button(event));
          });
          listen(target, 'dblclick', (event) => {
            if (
              v.enabled &&
              enabled(parents.get(v)) &&
              v.acceptedButtons & button(event)
            ) {
              const point = update(event);
              if (
                parents.get(v).containmentMask &&
                !parents.get(v).contains(point.position)
              )
                return;
              if (v.tapCount !== 2) {
                v.tapCount = 2;
                emit(v, 'onTapped', point, button(event));
              }
              emit(v, 'onDoubleTapped', point, button(event));
            }
          });
        } else if (type === 'HoverHandler') {
          const target = elements.get(parents.get(v));
          if (!target) throw Error('HoverHandler needs a visual parent');
          effect(() => {
            target.style.cursor =
              v.enabled && v.cursorShape === 13 ? 'pointer' : 'auto';
          });
          const updateHover = (event) => {
            const parent = parents.get(v);
            if (!v.enabled || !enabled(parent)) {
              v.hovered = false;
              return;
            }
            const data = pointer(v, target, event);
            let inside = parent.contains(data);
            for (let p = parents.get(parent); inside && p; p = parents.get(p))
              if (p.clip) {
                const rect = elements.get(p).getBoundingClientRect();
                inside =
                  event.clientX >= rect.left &&
                  event.clientX < rect.right &&
                  event.clientY >= rect.top &&
                  event.clientY < rect.bottom;
              }
            v.hovered = inside;
            if (inside)
              v.point = {
                position: { x: data.x, y: data.y },
                scenePosition: { x: event.clientX, y: event.clientY },
              };
          };
          listen(document, 'mousemove', updateHover);
          listen(document, 'mouseout', updateHover);
          effect(() => {
            if (!v.enabled || !enabled(parents.get(v))) v.hovered = false;
          });
          listen(document, 'mouseleave', () => {
            v.hovered = false;
          });
        } else if (type === 'FileView') {
          let lastPath, lastWatch, unwatch;
          disposers?.push(() => unwatch?.());
          effect(() => {
            const path = v.path,
              watch = v.watchChanges;
            if (path === lastPath && watch === lastWatch) return;
            lastPath = path;
            lastWatch = watch;
            unwatch?.();
            if (path) {
              if (v.preload) untrack(() => v.reload());
              if (watch)
                unwatch = host.watch(path, () => emit(v, 'onFileChanged'));
            }
          });
        } else if (type === 'Process') {
          let child = null,
            generation = 0;
          disposers?.push(() => {
            generation++;
            child?.();
          });
          v.write = (text) => {
            if (!child?.write)
              throw Error('Process is not running or stdin is disabled');
            child.write(text);
          };
          v.signal = (signal) => child?.signal?.(signal);
          v.closeWriteChannel = () => child?.closeWriteChannel?.();
          const parser = (value) => {
            let pending = '', byteCount = 0, cachedData = new ArrayBuffer(0);
            const chunks = [], dataRevision = state({ value: 0 });
            let cachedRevision = 0;
            const collector = value && owners.get(value)?.type === 'StdioCollector';
            if (collector) {
              value.text = '';
              Object.defineProperty(value, 'data', { configurable: true, enumerable: true, get() {
                const revision = dataRevision.value;
                if (revision !== cachedRevision) {
                  const data = new Uint8Array(byteCount);
                  let at = 0;
                  for (const bytes of chunks) { data.set(bytes, at); at += bytes.length; }
                  cachedData = data.buffer; cachedRevision = revision;
                }
                return cachedData;
              } });
            }
            return (chunk, final = false, bytes = null) => {
              if (!value) return;
              if (collector) {
                if (bytes?.length) { chunks.push(new Uint8Array(bytes)); byteCount += bytes.length; }
                if (final || !value.waitForEnd) dataRevision.value++;
              }
              if (owners.get(value)?.type === 'SplitParser') {
                pending += chunk;
                const marker = value.splitMarker;
                if (!marker) {
                  if (pending) {
                    emit(value, 'onRead', pending);
                    pending = '';
                  }
                  return;
                }
                let at;
                while ((at = pending.indexOf(marker)) >= 0) {
                  emit(value, 'onRead', pending.slice(0, at));
                  pending = pending.slice(at + marker.length);
                }
                if (final && pending) {
                  emit(value, 'onRead', pending);
                  pending = '';
                }
              } else if (final) {
                value.text = pending + chunk;
                emit(value, 'onStreamFinished');
              } else {
                pending += chunk;
                if (!value.waitForEnd) value.text = pending;
              }
            };
          };
          effect(() => {
            const running = v.running;
            if (running && !child)
              untrack(() => {
                const thisRun = ++generation,
                  out = parser(v.stdout),
                  err = parser(v.stderr);
                child = host.run(
                  v.command,
                  (result) => {
                    if (thisRun !== generation) return;
                    child = null;
                    v.processId = 0;
                    out('', true);
                    err('', true);
                    v.running = false;
                    if (!result.error) emit(v, 'onExited', result.exitCode, 0);
                  },
                  {
                    stdin: v.stdinEnabled,
                    cwd: v.workingDirectory,
                    environment: v.environment,
                    clearEnvironment: v.clearEnvironment,
                    stdout: (chunk, bytes) => {
                      if (thisRun === generation) out(chunk, false, bytes);
                    },
                    stderr: (chunk, bytes) => {
                      if (thisRun === generation) err(chunk, false, bytes);
                    },
                  },
                );
                v.processId = child.processId ?? 0;
                if (v.processId) emit(v, 'onStarted');
              });
            else if (!running && child) {
              generation++;
              child();
              child = null;
              v.processId = 0;
            }
          });
        } else if (type === 'Timer') {
          let timer;
          disposers?.push(() => clearTimeout(timer));
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
          disposers?.push(() => {
            for (const [signal, fn] of links) signal.disconnect(fn);
          });
          const wiring = effect(() => {
            for (const [signal, fn] of links) signal.disconnect(fn);
            links = [];
            const target = v.target;
            if (!target || v.enabled === false) return;
            for (const [name, fn] of handlers.get(v) ?? []) {
              const key = propertyName(name.slice(2));
              if (target[key]?.connect) {
                target[key].connect(fn);
                links.push([target[key], fn]);
              } else if (
                key.endsWith('Changed') &&
                key.slice(0, -7) in target
              ) {
                const property = key.slice(0, -7);
                let previous = untrack(() => target[property]);
                const stop = effect(() => {
                  const next = target[property];
                  if (!Object.is(next, previous)) {
                    previous = next;
                    untrack(fn);
                  }
                });
                links.push([{ disconnect: stop }, fn]);
              } else if (!v.ignoreUnknownSignals)
                throw Error('Unknown QML signal: ' + key);
            }
          });
          wiring.onInvalidate = () => pendingConnections.add(wiring);
          disposers?.push(() => pendingConnections.delete(wiring));
        }
      } finally {
        disposers = previousScope;
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
    const objectLimit = host ? 30000 : 2000;
    if (nodes.length >= objectLimit)
      throw Object.assign(
        Error('QML live object limit (' + objectLimit + ')'),
        { qmlFatal: true },
      );
    const value = state({
      width: null,
      height: null,
      implicitWidth: null,
      implicitHeight: null,
      x: 0,
      y: 0,
      color: [
        'Text',
        'Label',
        'TextField',
        'TextInput',
        'TextEdit',
        'Button',
      ].includes(type)
        ? 'black'
        : 'transparent',
      radius: 0,
      opacity: 1,
      visible: true,
      enabled: true,
      clip: false,
      text: '',
      title: '',
      font: state({
        pixelSize: 16,
        family: 'sans-serif',
        bold: false,
        italic: false,
        letterSpacing: 0,
        capitalization: 0,
        features: {},
      }),
      border: state({ width: 0, color: 'black' }),
      anchors: state({
        fill: null,
        centerIn: null,
        horizontalCenter: null,
        verticalCenter: null,
        left: null,
        right: null,
        top: null,
        bottom: null,
        baseline: null,
        baselineOffset: 0,
        margins: 0,
        leftMargin: null,
        rightMargin: null,
        topMargin: null,
        bottomMargin: null,
        horizontalCenterOffset: 0,
        verticalCenterOffset: 0,
      }),
      scale: 1,
      rotation: 0,
      z: 0,
      transform: null,
      containmentMask: null,
      objectName: '',
      activeFocus: false,
      focus: false,
      activeFocusOnTab: false,
      topPadding: 0,
      bottomPadding: 0,
      leftPadding: 0,
      rightPadding: 0,
      maximumLineCount: Infinity,
      lineCount: 1,
      renderType: 0,
      verticalAlignment: 32,
      wrapMode: 0,
      elide: 0,
      lineHeight: 1,
      lineHeightMode: 0,
      baselineOffset: 0,
      linkColor: '#0000ff',
      hoveredLink: '',
      truncated: false,
      contentWidth: 0,
      contentHeight: 0,
      horizontalAlignment: 0,
      textFormat: ['Text', 'Label'].includes(type) ? 2 : 0,
      spacing: 0,
      placeholderText: '',
      readOnly: false,
      selectByMouse: false,
      Drag: state({
        active: false,
        source: null,
        keys: [],
        mimeData: {},
        supportedActions: 1,
        proposedAction: 1,
        dragType: 2,
        imageSource: '',
        hotSpot: state({ x: 0, y: 0 }),
      }),
      Accessible: state({ name: '', role: 0, checked: false }),
      Layout: state({
        fillWidth: false,
        fillHeight: false,
        minimumWidth: 0,
        minimumHeight: 0,
        maximumWidth: Infinity,
        maximumHeight: Infinity,
        preferredWidth: -1,
        preferredHeight: -1,
        alignment: 0,
        margins: 0,
        leftMargin: null,
        rightMargin: null,
        topMargin: null,
        bottomMargin: null,
      }),
      Keys: state({ enabled: true, forwardTo: [] }),
    });
    const node = { value, type, scope: disposers };
    nodes.push(node);
    owners.set(value, node);
    for (const key of [
      'font',
      'border',
      'anchors',
      'Accessible',
      'Keys',
      'Layout',
    ])
      owners.set(value[key], node);
    elements.set(value, element);
    if (parent?.contentItem && !nonvisual.has(type))
      parent = parent.contentItem;
    parents.set(value, parent);
    moveChild(value, null, parent);
    if (parent && element.parentElement !== elements.get(parent))
      elements.get(parent)?.appendChild(element);
    Object.defineProperty(value, 'parent', {
      configurable: true,
      get: () => parents.get(value),
      set: (next) => {
        for (let p = next; p; p = parents.get(p))
          if (p === value) throw Error('Cyclic Item parent');
        moveChild(value, parents.get(value), next);
        parents.set(value, next);
        (elements.get(next) ?? document.body).appendChild(element);
        untrack(() => structure.version++);
      },
    });
    if (!nonvisual.has(type)) {
      for (const edge of [
        'left',
        'right',
        'top',
        'bottom',
        'horizontalCenter',
        'verticalCenter',
        'baseline',
      ]) {
        const line = { item: value, edge };
        Object.defineProperty(value, edge, { get: () => line });
      }
      for (const key of ['children', 'data'])
        Object.defineProperty(value, key, { get: () => childrenOf(value) });
      Object.defineProperty(value, 'childrenRect', {
        get: () => {
          const children = childrenOf(value);
          if (!children.length) return { x: 0, y: 0, width: 0, height: 0 };
          const x = Math.min(...children.map((v) => v.x)),
            y = Math.min(...children.map((v) => v.y));
          return {
            x,
            y,
            width: Math.max(...children.map((v) => v.x + (v.width || 0))) - x,
            height: Math.max(...children.map((v) => v.y + (v.height || 0))) - y,
          };
        },
      });
    }
    value.forceActiveFocus = () => {
      if (enabled(value))
        untrack(() => elements.get(focusTarget(value)).focus());
    };
    value.contains = (point) =>
      point.x >= 0 &&
      point.y >= 0 &&
      point.x < value.width &&
      point.y < value.height &&
      (!value.containmentMask || value.containmentMask.contains(point));
    value.mapToItem = (item, x, y) => {
      const a = element.getBoundingClientRect(),
        b = elements.get(item)?.getBoundingClientRect() ?? { x: 0, y: 0 };
      return { x: a.x - b.x + x, y: a.y - b.y + y };
    };
    value.mapFromItem = (item, x, y) => {
      const a = element.getBoundingClientRect(),
        b = elements.get(item)?.getBoundingClientRect() ?? { x: 0, y: 0 };
      return { x: b.x - a.x + x, y: b.y - a.y + y };
    };
    let windowValue = type === 'FloatingWindow' ? value : parent;
    while (windowValue && owners.get(windowValue)?.type !== 'FloatingWindow')
      windowValue = parents.get(windowValue);
    value.Window = { window: windowValue ?? null };
    let viewValue = parent;
    while (
      viewValue &&
      !['ListView', 'GridView'].includes(owners.get(viewValue)?.type)
    )
      viewValue = parents.get(viewValue);
    value.ListView = {
      view: owners.get(viewValue)?.type === 'ListView' ? viewValue : null,
    };
    value.GridView = {
      view: owners.get(viewValue)?.type === 'GridView' ? viewValue : null,
    };
    if (type === 'FloatingWindow') {
      value.sceneGraphError = signal();
      value.afterAnimating = signal();
      value.afterSynchronizing = signal();
      value.frameSwapped = signal();
      value.activeFocusItem = null;
      let frame,
        hadFrame = false;
      const tick = () => {
        frame = undefined;
        if (
          !value.afterAnimating.listenerCount &&
          !value.afterSynchronizing.listenerCount &&
          !value.frameSwapped.listenerCount
        )
          return;
        if (hadFrame) value.frameSwapped();
        value.afterAnimating();
        textures.flush();
        value.afterSynchronizing();
        hadFrame = true;
        frame = requestAnimationFrame(tick);
      };
      for (const event of [value.afterAnimating, value.afterSynchronizing, value.frameSwapped]) {
        const connect = event.connect;
        event.connect = (fn) => {
          connect(fn);
          if (frame === undefined) frame = requestAnimationFrame(tick);
        };
      }
      disposers?.push(() => {
        if (frame !== undefined) cancelAnimationFrame(frame);
      });

      value.itemRect = (item) => {
        const a = elements.get(item)?.getBoundingClientRect(),
          b = element.getBoundingClientRect();
        return a
          ? { x: a.x - b.x, y: a.y - b.y, width: a.width, height: a.height }
          : { x: 0, y: 0, width: 0, height: 0 };
      };
    }
    untrack(() => structure.version++);
    if (type === 'Behavior')
      Object.assign(value, {
        enabled: true,
        targetProperty: null,
        animation: null,
      });
    if (
      [
        'NumberAnimation',
        'PropertyAnimation',
        'PauseAnimation',
        'SequentialAnimation',
        'ParallelAnimation',
        'ScriptAction',
        'PropertyAction',
      ].includes(type)
    )
      Object.assign(value, {
        target: null,
        targets: [],
        property: '',
        properties: '',
        from: undefined,
        to: undefined,
        duration: 250,
        easing: state({ type: 0 }),
        running: false,
        loops: 1,
        start: () => {
          value.running = true;
        },
        stop: () => {
          animationStops.get(value)?.();
          animationStops.delete(value);
          value.running = false;
        },
        restart: () => {
          value.stop();
          value.running = true;
        },
        complete: () => {
          if (value.target && value.property && value.to !== undefined)
            value.target[value.property] = value.to;
          value.stop();
        },
      });
    if (['Flickable', 'ListView', 'GridView'].includes(type)) {
      Object.assign(value, {
        contentX: 0,
        contentY: 0,
        contentWidth: 0,
        contentHeight: 0,
        contentItem: null,
        interactive: true,
        boundsBehavior: 0,
        boundsMovement: 0,
        flickableDirection: 0,
        moving: false,
        flicking: false,
        dragging: false,
        originX: 0,
        originY: 0,
        leftMargin: 0,
        rightMargin: 0,
        topMargin: 0,
        bottomMargin: 0,
      });
      const content = document.createElement('div');
      content.setAttribute('data-qml-content', '');
      for (const child of [...element.children]) content.appendChild(child);
      element.appendChild(content);
      value.contentItem = make(content, 'Item', value);
      effect(() => {
        value.contentItem.width = value.contentWidth;
        value.contentItem.height = value.contentHeight;
        value.contentItem.x = -value.contentX;
        value.contentItem.y = -value.contentY;
      });
      for (const [key, read] of Object.entries({
        atXBeginning: () => value.contentX <= -value.leftMargin,
        atXEnd: () =>
          value.contentX >=
          value.contentWidth - value.width + value.rightMargin,
        atYBeginning: () => value.contentY <= -value.topMargin,
        atYEnd: () =>
          value.contentY >=
          value.contentHeight - value.height + value.bottomMargin,
      }))
        Object.defineProperty(value, key, { get: read });
      value.movementStarted = signal();
      value.movementEnded = signal();
      value.flickStarted = signal();
      value.flickEnded = signal();
      value.cancelFlick = () => {
        if (value.flicking) value.flickEnded();
        value.flicking = false;
        if (value.moving) value.movementEnded();
        value.moving = false;
      };
      value.returnToBounds = () => {
        value.contentX = Math.max(
          -value.leftMargin,
          Math.min(
            Math.max(
              -value.leftMargin,
              value.contentWidth - value.width + value.rightMargin,
            ),
            value.contentX,
          ),
        );
        value.contentY = Math.max(
          -value.topMargin,
          Math.min(
            Math.max(
              -value.topMargin,
              value.contentHeight - value.height + value.bottomMargin,
            ),
            value.contentY,
          ),
        );
      };
      listen(element, 'wheel', (event) => {
        if (!enabled(value) || !value.interactive || event.defaultPrevented)
          return;
        if (value.flickableDirection !== 2) value.contentX += event.deltaX;
        if (value.flickableDirection !== 1) value.contentY += event.deltaY;
        value.returnToBounds();
        event.preventDefault();
      });
    }
    if (type === 'IpcHandler')
      Object.assign(value, { target: '', enabled: true });
    if (type === 'Binding')
      Object.assign(value, {
        target: null,
        property: '',
        value: undefined,
        when: true,
        delayed: false,
        restoreMode: 3,
      });
    if (type === 'Gradient')
      Object.assign(value, { orientation: 0, stops: [] });
    if (type === 'GradientStop')
      Object.assign(value, { position: 0, color: 'black' });
    if (type === 'WorkerScript')
      Object.assign(value, { source: '', ready: false });
    if (type === 'LoggingCategory')
      Object.assign(value, { name: '', defaultLogLevel: 0 });
    if (type === 'PointHandler')
      Object.assign(value, {
        target: parent,
        acceptedButtons: 1,
        active: false,
        point: { position: { x: 0, y: 0 }, scenePosition: { x: 0, y: 0 } },
      });
    if (type === 'DropArea')
      Object.assign(value, {
        keys: [],
        containsDrag: false,
        drag: { x: 0, y: 0, source: null },
      });
    if (type === 'DragHandler')
      Object.assign(value, {
        target: parent,
        acceptedButtons: 1,
        active: false,
        dragThreshold: 10,
        persistentTranslation: { x: 0, y: 0 },
        activeTranslation: { x: 0, y: 0 },
        centroid: { position: { x: 0, y: 0 }, scenePosition: { x: 0, y: 0 } },
        xAxis: state({ enabled: true, minimum: -Infinity, maximum: Infinity }),
        yAxis: state({ enabled: true, minimum: -Infinity, maximum: Infinity }),
      });
    if (type === 'FrameAnimation')
      Object.assign(value, {
        running: false,
        paused: false,
        frameTime: 0,
        smoothFrameTime: 0,
        elapsedTime: 0,
        currentFrame: 0,
        start: () => {
          value.running = true;
        },
        stop: () => {
          value.running = false;
        },
        restart: () => {
          value.elapsedTime = 0;
          value.currentFrame = 0;
          value.running = true;
        },
      });
    if (type === 'Image')
      Object.assign(value, {
        source: '',
        sourceSize: state({ width: 0, height: 0 }),
        sourceClipRect: { x: 0, y: 0, width: 0, height: 0 },
        fillMode: 0,
        asynchronous: false,
        cache: true,
        status: 0,
        progress: 0,
        smooth: true,
        mipmap: false,
        paintedWidth: 0,
        paintedHeight: 0,
        mirror: false,
      });
    if (type === 'Component')
      Object.assign(value, {
        status: 1,
        createObject: (parent, properties = {}) =>
          instantiate(factories.get(value), parent, properties),
        errorString: () => '',
      });
    if (type === 'Loader')
      Object.assign(value, {
        active: true,
        source: '',
        sourceComponent: null,
        asynchronous: false,
        item: null,
        status: 0,
        progress: 0,
        _reload: 0,
        setSource: (source, properties = {}) => {
          value.source = String(source);
          value._initialProperties = properties;
        },
      });
    if (type === 'Scale')
      Object.assign(value, {
        xScale: 1,
        yScale: 1,
        origin: state({ x: 0, y: 0 }),
      });
    if (type === 'ShapePath')
      Object.assign(value, {
        fillGradient: null,
        fillItem: null,
        fillRule: 0,
        strokeColor: 'black',
        fillColor: 'transparent',
        strokeWidth: 1,
        capStyle: 16,
        joinStyle: 0,
        strokeStyle: 0,
        dashPattern: [],
        dashOffset: 0,
      });
    if (type === 'Grid')
      Object.assign(value, {
        columns: 4,
        rows: 0,
        rowSpacing: null,
        columnSpacing: null,
      });
    if (type === 'PathSvg') value.path = '';
    if (type === 'LinearGradient')
      Object.assign(value, { x1: 0, y1: 0, x2: 0, y2: 0 });

    if (type === 'Repeater')
      Object.assign(value, { model: [], count: 0, itemAt: () => null });
    if (type === 'MouseArea')
      Object.assign(value, {
        acceptedButtons: 1,
        hoverEnabled: false,
        pressed: false,
        containsMouse: false,
        mouseX: 0,
        mouseY: 0,
        cursorShape: 0,
      });
    if (type === 'TapHandler')
      Object.assign(value, {
        acceptedButtons: 1,
        gesturePolicy: 1,
        tapCount: 0,
        pressed: false,
        point: { position: { x: 0, y: 0 }, scenePosition: { x: 0, y: 0 } },
      });
    if (type === 'HoverHandler')
      Object.assign(value, {
        cursorShape: 0,
        hovered: false,
        point: { position: { x: 0, y: 0 }, scenePosition: { x: 0, y: 0 } },
      });
    if (type === 'FileView') {
      Object.assign(value, {
        path: '',
        loaded: false,
        watchChanges: false,
        blockLoading: false,
        preload: true,
        atomicWrites: true,
        printErrors: true,
      });
      let body = '',
        readPath,
        pendingWrite,
        disposed = false;
      disposers?.push(() => {
        disposed = true;
        pendingWrite = null;
      });
      const save = () => {
        if (!pendingWrite || disposed) return;
        const request = pendingWrite;
        pendingWrite = null;
        const result = host.write(
          request.path,
          request.data,
          value.atomicWrites,
        );
        if (!result.error) {
          body =
            typeof request.data === 'string'
              ? request.data
              : new TextDecoder().decode(request.data);
          readPath = request.path;
          value.loaded = true;
        }
        emit(value, result.error ? 'onSaveFailed' : 'onSaved', result.error);
      };
      value.setText = (text) => {
        pendingWrite = { path: value.path, data: String(text) };
        queueMicrotask(save);
      };
      value.setData = (data) => {
        pendingWrite = { path: value.path, data: new Uint8Array(data) };
        queueMicrotask(save);
      };
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
        if (pendingWrite) save();
        if (readPath !== value.path) value.reload();
      };
    }
    if (type === 'StdioCollector') Object.assign(value, { text: '', data: new ArrayBuffer(0) });
    if (type === 'SplitParser') Object.assign(value, { splitMarker: '\n' });
    if (type === 'Process')
      Object.assign(value, {
        running: false,
        command: [],
        stdout: null,
        stderr: null,
        stdinEnabled: false,
        workingDirectory: '',
        environment: {},
        clearEnvironment: false,
        processId: 0,
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
    if (type === 'TextMetrics' || type === 'FontMetrics') {
      Object.assign(value, { elide: 0, elideWidth: 0, ascent: 0, descent: 0 });
      const measure = (text) =>
        measureText(
          `${value.font.bold ? 'bold ' : ''}${value.font.pixelSize}px ${value.font.family}`,
          text,
        );
      const elide = (text, mode, width) => {
        text = String(text);
        if (!mode || measure(text).width <= width) return text;
        if (measure('…').width > width) return '';
        const chars = Array.from(text),
          candidate = (n) =>
            mode === 1
              ? '…' + chars.slice(chars.length - n).join('')
              : mode === 3
                ? chars.slice(0, Math.ceil(n / 2)).join('') +
                  '…' +
                  chars.slice(chars.length - Math.floor(n / 2)).join('')
                : chars.slice(0, n).join('') + '…';
        let lo = 0,
          hi = chars.length;
        while (lo < hi) {
          const n = Math.ceil((lo + hi) / 2);
          if (measure(candidate(n)).width <= width) lo = n;
          else hi = n - 1;
        }
        return candidate(lo);
      };
      if (type === 'FontMetrics') value.elidedText = elide;
      effect(() => {
        const m = measure(value.text || '0');
        if (type === 'TextMetrics') {
          value.advanceWidth = m.width;
          value.width = m.width;
          value.elidedText = elide(value.text, value.elide, value.elideWidth);
        } else value.advanceWidth = (text) => measure(text).width;
        value.ascent = m.fontBoundingBoxAscent || value.font.pixelSize * 0.8;
        value.descent = m.fontBoundingBoxDescent || value.font.pixelSize * 0.2;
        value.height = value.ascent + value.descent;
        if (type === 'TextMetrics')
          value.boundingRect = {
            x: 0,
            y: -value.ascent,
            width: m.width,
            height: value.height,
          };
        else
          value.boundingRect = value.tightBoundingRect = (text) => {
            const m = measure(text);
            return {
              x: 0,
              y: -(m.actualBoundingBoxAscent || value.ascent),
              width: m.width,
              height: value.height,
            };
          };
        value.averageCharacterWidth = measure('0').width;
      });
    }
    textures.make(value, type, element);
    shapes.make(value, type, element, parent);
    models.make(value, type, element, parent);
    if (nonvisual.has(type)) return value;
    focusElements.set(element, value);
    listen(element, 'focus', () => activateFocus(value));
    listen(element, 'blur', (event) =>
      activateFocus(focusElements.get(event.relatedTarget) ?? null),
    );
    disposers?.push(() => {
      if (activeFocusValues.has(value)) activateFocus(null);
      focusElements.delete(element);
    });
    effect(() => {
      if (value.focus && enabled(value))
        untrack(() => {
          if (document.activeElement !== element) element.focus();
        });
    });
    effect(() => {
      element.tabIndex = value.activeFocusOnTab ? 0 : -1;
      if (value.objectName)
        element.setAttribute('data-qml-object-name', value.objectName);
      if (value.Accessible.name)
        element.setAttribute('aria-label', value.Accessible.name);
      if (value.Accessible.role)
        element.setAttribute(
          'role',
          value.Accessible.role === 44 ? 'checkbox' : 'button',
        );
      if (value.Accessible.role === 44)
        element.setAttribute('aria-checked', String(value.Accessible.checked));
    });
    if (type === 'Flow') Object.assign(value, { flow: 0, layoutDirection: 0 });
    if (['Row', 'Column', 'Grid', 'Flow'].includes(type))
      effect(() => {
        const children = childrenOf(value).filter(
          (v) =>
            v.visible !== false && (v.width || 0) > 0 && (v.height || 0) > 0,
        );
        let w = 0,
          h = 0;
        const gap = value.spacing || 0;
        if (type === 'Flow') {
          const vertical = value.flow === 1,
            limit = vertical
              ? value.height - value.topPadding - value.bottomPadding
              : value.width - value.leftPadding - value.rightPadding;
          let main = 0,
            cross = 0,
            line = 0,
            maxMain = 0;
          for (const child of children) {
            const size = vertical ? child.height : child.width,
              other = vertical ? child.width : child.height;
            if (main > 0 && limit > 0 && main + size > limit) {
              maxMain = Math.max(maxMain, main - gap);
              cross += line + gap;
              main = 0;
              line = 0;
            }
            child.x = vertical ? cross : main;
            child.y = vertical ? main : cross;
            main += size + gap;
            line = Math.max(line, other);
          }
          maxMain = Math.max(maxMain, main ? main - gap : 0);
          w = vertical ? cross + line : maxMain;
          h = vertical ? maxMain : cross + line;
        } else if (type === 'Grid') {
          const cols = Math.max(
              1,
              value.columns ||
                Math.ceil(children.length / Math.max(1, value.rows)),
            ),
            cw = [],
            rh = [];
          children.forEach((v, i) => {
            cw[i % cols] = Math.max(cw[i % cols] || 0, v.width);
            rh[Math.floor(i / cols)] = Math.max(
              rh[Math.floor(i / cols)] || 0,
              v.height,
            );
          });
          const gx = value.columnSpacing ?? gap,
            gy = value.rowSpacing ?? gap;
          children.forEach((v, i) => {
            v.x = cw.slice(0, i % cols).reduce((a, b) => a + b + gx, 0);
            v.y = rh
              .slice(0, Math.floor(i / cols))
              .reduce((a, b) => a + b + gy, 0);
          });
          w = cw.reduce((a, b) => a + b, 0) + Math.max(0, cw.length - 1) * gx;
          h = rh.reduce((a, b) => a + b, 0) + Math.max(0, rh.length - 1) * gy;
        } else
          for (const child of children) {
            if (type === 'Row') {
              child.x = w;
              w += child.width + gap;
              h = Math.max(h, child.height);
            } else {
              child.y = h;
              h += child.height + gap;
              w = Math.max(w, child.width);
            }
          }
        if (type === 'Row' && children.length) w -= gap;
        if (type === 'Column' && children.length) h -= gap;
        for (const child of children) {
          if (type !== 'Column') child.x += value.leftPadding;
          else if (!descriptions.get(child)?.properties.includes('x'))
            child.x = value.leftPadding;
          if (type !== 'Row') child.y += value.topPadding;
          else if (!descriptions.get(child)?.properties.includes('y'))
            child.y = value.topPadding;
        }
        value.implicitWidth = w + value.leftPadding + value.rightPadding;
        value.implicitHeight = h + value.topPadding + value.bottomPadding;
      });
    if (type === 'RowLayout' || type === 'ColumnLayout')
      effect(() => {
        const horizontal = type === 'RowLayout',
          main = horizontal ? 'width' : 'height',
          cross = horizontal ? 'height' : 'width',
          axis = horizontal ? 'x' : 'y',
          other = horizontal ? 'y' : 'x',
          suffix = horizontal ? 'Width' : 'Height',
          opposite = horizontal ? 'Height' : 'Width';
        const children = childrenOf(value).filter((c) => c.visible !== false),
          gap = value.spacing;
        const boxes = children.map((c) => {
          const l = c.Layout;
          const preferred =
            l['preferred' + suffix] >= 0
              ? l['preferred' + suffix]
              : c['implicit' + suffix];
          return {
            c,
            l,
            min: l['minimum' + suffix],
            max: l['maximum' + suffix],
            size: Math.max(
              l['minimum' + suffix],
              Math.min(l['maximum' + suffix], preferred),
            ),
            fill: l['fill' + suffix],
          };
        });
        const gaps = Math.max(0, boxes.length - 1) * gap,
          preferred = boxes.reduce((sum, b) => sum + b.size, gaps);
        const available = Math.max(0, value[main] - gaps);
        let remaining = available - boxes.reduce((sum, b) => sum + b.size, 0);
        for (let n = 0; n <= boxes.length && Math.abs(remaining) > 0.01; n++) {
          const adjustable = boxes.filter(
            (b) => b.fill && (remaining > 0 ? b.size < b.max : b.size > b.min),
          );
          if (!adjustable.length) break;
          const share = remaining / adjustable.length;
          let used = 0;
          for (const b of adjustable) {
            const next = Math.max(b.min, Math.min(b.max, b.size + share));
            used += next - b.size;
            b.size = next;
          }
          remaining -= used;
        }
        let offset = 0,
          maxCross = 0;
        const baseline = Math.max(
          0,
          ...boxes
            .filter((b) => b.l.alignment & 256)
            .map((b) => b.c.baselineOffset),
        );
        for (const b of boxes) {
          const { c, l } = b;
          const preferredCross =
            l['preferred' + opposite] >= 0
              ? l['preferred' + opposite]
              : c['implicit' + opposite];
          const size = Math.max(
            l['minimum' + opposite],
            Math.min(
              l['maximum' + opposite],
              l['fill' + opposite] ? value[cross] : preferredCross,
            ),
          );
          c[main] = b.size;
          c[cross] = size;
          c[axis] = offset;
          offset += b.size + gap;
          const alignment = l.alignment;
          c[other] =
            horizontal && alignment & 256
              ? baseline - c.baselineOffset
              : alignment & (horizontal ? 64 : 2)
                ? value[cross] - size
                : alignment & (horizontal ? 128 : 4)
                  ? (value[cross] - size) / 2
                  : 0;
          maxCross = Math.max(maxCross, size + c[other]);
        }
        value['implicit' + suffix] = preferred;
        value['implicit' + opposite] = maxCross;
      });
    if (
      [
        'Text',
        'Label',
        'Button',
        'TextField',
        'TextInput',
        'TextEdit',
      ].includes(type)
    ) {
      effect(() => {
        const font = `${value.font.bold ? 'bold ' : ''}${value.font.pixelSize}px ${value.font.family}`;
        const control = type === 'TextField' || type === 'Button';
        const content = ['Text', 'Label'].includes(type)
          ? textContent(value).plain
          : String(value.text);
        const metrics = measureText(font, content),
          explicit = descriptions.get(value)?.properties ?? [];
        const line =
          metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent ||
          value.font.pixelSize;
        const measure = (text) =>
          measureText(font, text).width +
          Math.max(0, Array.from(text).length - 1) * value.font.letterSpacing;
        const paragraphs = content.split('\n'),
          natural = Math.max(0, ...paragraphs.map(measure));
        const available = Math.max(
            0,
            value.width - value.leftPadding - value.rightPadding,
          ),
          lines = [];
        for (const paragraph of paragraphs) {
          if (!value.wrapMode || !available) {
            lines.push(paragraph);
            continue;
          }
          const pieces =
            value.wrapMode === 2
              ? Array.from(paragraph)
              : paragraph.match(/\S+\s*|\s+/g) || [''];
          let current = '';
          for (const piece of pieces) {
            if (current && measure(current + piece) > available) {
              lines.push(current);
              current = '';
            }
            if (value.wrapMode === 3 && measure(piece) > available) {
              for (const char of Array.from(piece)) {
                if (current && measure(current + char) > available) {
                  lines.push(current);
                  current = '';
                }
                current += char;
              }
            } else current += piece;
          }
          lines.push(current);
        }
        const count = Math.min(lines.length, value.maximumLineCount),
          lineBox =
            value.lineHeightMode === 1
              ? value.lineHeight
              : line * value.lineHeight;
        if (!explicit.includes('implicitWidth'))
          value.implicitWidth =
            natural + (control ? 22 : value.leftPadding + value.rightPadding);
        if (!explicit.includes('implicitHeight'))
          value.implicitHeight =
            count * lineBox +
            (control ? 18 : value.topPadding + value.bottomPadding);
        value.baselineOffset =
          (metrics.fontBoundingBoxAscent || value.font.pixelSize * 0.8) +
          value.topPadding;
        value.contentWidth = Math.max(0, ...lines.slice(0, count).map(measure));
        value.contentHeight = count * lineBox;
        value.lineCount = count;
        value.truncated =
          lines.length > count ||
          (!!value.elide &&
            lines.slice(0, count).some((line) => measure(line) > available));
      });
    }
    if (['TextField', 'TextInput', 'TextEdit'].includes(type)) {
      Object.assign(value, {
        cursorPosition: 0,
        selectionStart: 0,
        selectionEnd: 0,
        selectedText: '',
        passwordCharacter: '●',
        echoMode: 0,
        maximumLength: 32767,
        inputMethodComposing: false,
        acceptableInput: true,
        autoScroll: true,
        persistentSelection: false,
        cursorVisible: true,
        selectionColor: '#3874f2',
        selectedTextColor: 'white',
      });
      const selection = () => {
        value.cursorPosition = element.selectionDirection === 'backward'
          ? element.selectionStart ?? 0 : element.selectionEnd ?? 0;
        value.selectionStart = element.selectionStart ?? 0;
        value.selectionEnd = element.selectionEnd ?? 0;
        value.selectedText = String(value.text).slice(
          value.selectionStart,
          value.selectionEnd,
        );
      };
      value.select = (start, end) => {
        if (element.value !== String(value.text))
          element.value = String(value.text);
        const length = element.value.length;
        start = Math.max(0, Math.min(length, start));
        end = Math.max(0, Math.min(length, end));
        element.selectionDirection = end < start ? 'backward' : 'forward';
        element.selectionStart = Math.min(start, end);
        element.selectionEnd = Math.max(start, end);
        selection();
      };
      for(const operation of ['copy','cut','paste'])
        value[operation] = () => host.inputClipboard(element,operation);
      value.selectAll = () => value.select(0, String(value.text).length);
      value.deselect = () =>
        value.select(value.cursorPosition, value.cursorPosition);
      value.insert = (at, text) => {
        const old = String(value.text);
        value.text = old.slice(0, at) + String(text) + old.slice(at);
        element.value = value.text;
        value.select(at + String(text).length, at + String(text).length);
      };
      value.remove = (start, end) => {
        const old = String(value.text);
        value.text = old.slice(0, start) + old.slice(end);
        element.value = value.text;
        value.select(start, start);
      };
      const advance = (at) =>
        measureText(
          `${value.font.bold ? 'bold ' : ''}${value.font.pixelSize}px ${value.font.family}`,
          String(value.text).slice(0, at),
        ).width;
      value.positionAt = (x) => {
        const text = String(value.text);
        let lo = 0,
          hi = text.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (advance(mid) < x) lo = mid + 1;
          else hi = mid;
        }
        return lo > 0 && x - advance(lo - 1) < advance(lo) - x ? lo - 1 : lo;
      };
      value.positionToRectangle = (at) => ({
        x: advance(at),
        y: 0,
        width: 1,
        height: value.font.pixelSize,
      });
      Object.defineProperty(value, 'cursorRectangle', {
        get: () => value.positionToRectangle(value.cursorPosition),
      });
      effect(() => {
        element.maxLength = value.maximumLength;
        if (type !== 'TextEdit')
          element.type =
            value.echoMode === 2 || value.echoMode === 3 ? 'password' : 'text';
        if (
          element.selectionEnd !== value.cursorPosition &&
          value.selectionStart === value.selectionEnd
        )
          element.selectionStart = element.selectionEnd = value.cursorPosition;
      });
      effect(() => {
        // Presentation options only; editing and blinking belong to HTML controls.
        host?.inputPresentation?.(element, {
          persistent:value.persistentSelection, visible:value.cursorVisible,
          background:cssColor(value.selectionColor), selectedColor:cssColor(value.selectedTextColor),
          color:cssColor(value.color), height:value.font.pixelSize,
        });
      });
      for (const event of ['select', 'keyup', 'mouseup'])
        listen(element, event, selection);
      listen(element, 'compositionstart', () => {
        value.inputMethodComposing = true;
      });
      listen(element, 'compositionend', () => {
        value.inputMethodComposing = false;
      });
      listen(element, 'blur', () => emit(value, 'onEditingFinished'));

      element.addEventListener('input', () => {
        value.text = element.value;
        selection();
        emit(value, 'onTextEdited');
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
    const textNode = ['Text', 'Label', 'Button'].includes(type)
      ? document.createElement('span')
      : null;
    if (textNode) {
      textNode.style.display = 'contents';
      element.insertBefore(textNode, element.firstChild);
      listen(element, 'click', (event) => {
        const a = event.target?.closest?.('a[href]');
        if (a && element.contains(a)) {
          event.preventDefault();
          if (enabled(value))
            emit(value, 'onLinkActivated', a.getAttribute('href'));
        }
      });
    }
    let paintedStyles = {},
      paintedCss = null;
    node.paint = () => {
      // Compute final styles before touching the DOM: overrides within this
      // pass must not repeatedly invalidate style/layout or flip values back.
      const s = {},
        width = value.width,
        height = value.height;
      s.position = 'absolute';
      s.boxSizing = 'border-box';
      s.width = width == null ? 'auto' : Math.max(0, width) + 'px';
      s.height = height == null ? 'auto' : Math.max(0, height) + 'px';
      s.left = value.x + 'px';
      s.top = value.y + 'px';
      const textureSource = textures.keepLayout(value);
      s.display = value.visible || textureSource ? 'block' : 'none';
      const transform = value.transform;
      s.transformOrigin = transform ? '0 0' : '50% 50%';
      s.transform =
        [
          value.scale !== 1 ? 'scale(' + value.scale + ')' : '',
          value.rotation ? 'rotate(' + value.rotation + 'deg)' : '',
          transform?.xScale !== undefined
            ? 'scale(' + transform.xScale + ',' + transform.yScale + ')'
            : transform
              ? 'translate(' +
                (transform.x || 0) +
                'px,' +
                (transform.y || 0) +
                'px)'
              : '',
        ]
          .filter(Boolean)
          .join(' ') || 'none';
      s.zIndex = String(value.z);
      s.opacity = String(value.opacity);
      const children = childSet(value);
      if (children) children.version.value;
      const mouseHandler = [...(children?.items ?? [])].some(
        (child) => owners.get(child)?.type === 'TapHandler' && child.enabled,
      );
      const clickable =
        handlers.get(value)?.has('onClicked') ||
        mouseHandler ||
        [
          'Button',
          'TextField',
          'TextInput',
          'TextEdit',
          'FloatingWindow',
          'Flickable',
          'ListView',
          'GridView',
        ].includes(type) ||
        (type === 'MouseArea' && !value.propagateComposedEvents);
      s.pointerEvents = value.enabled && clickable ? 'auto' : 'none';
      s.overflow = value.clip ? 'hidden' : 'visible';
      if (
        [
          'Text',
          'Label',
          'TextField',
          'TextInput',
          'TextEdit',
          'Button',
        ].includes(type)
      ) {
        if (['TextField', 'TextInput', 'TextEdit'].includes(type)) {
          // Do not reset the caret/selection on unrelated reactive updates.
          if (element.value !== String(value.text))
            element.value = String(value.text);
          element.readOnly = value.readOnly;
          element.placeholder = value.placeholderText;
          s.userSelect = value.selectByMouse ? 'text' : 'none';
          if (type !== 'TextField') {
            s.backgroundColor = 'transparent';
            s.border = 'none';
            s.outline = 'none';
            s.padding = `${value.topPadding || 0}px ${value.rightPadding || 0}px ${value.bottomPadding || 0}px ${value.leftPadding || 0}px`;
          }
        } else if (textNode) {
          if (['Text', 'Label'].includes(type)) {
            const content = textContent(value);
            if (textNode.firstChild !== content.container)
              textNode.replaceChildren(content.container);
            for (const a of content.container.querySelectorAll('a'))
              a.style.color = cssColor(value.linkColor);
          } else textNode.textContent = String(value.text);
        }
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
        s.fontStyle = value.font.italic ? 'italic' : 'normal';
        s.letterSpacing = value.font.letterSpacing + 'px';
        s.textTransform =
          { 1: 'uppercase', 2: 'lowercase', 4: 'capitalize' }[
            value.font.capitalization
          ] || 'none';
        s.fontVariant =
          value.font.capitalization === 3 ? 'small-caps' : 'normal';
        s.whiteSpace = value.wrapMode ? 'pre-wrap' : 'pre';
        s.overflowWrap =
          value.wrapMode === 2 || value.wrapMode === 3 ? 'anywhere' : 'normal';
        // CSS numeric line-height multiplies font-size, whereas QML's
        // proportional mode multiplies the measured font line box (including
        // fallback glyphs). Use the same line extent as implicitHeight.
        s.lineHeight = (value.lineHeightMode === 1 ? value.lineHeight :
          value.lineCount > 0 ? value.contentHeight / value.lineCount :
          value.font.pixelSize * value.lineHeight) + 'px';
        s.textOverflow = value.elide ? 'ellipsis' : 'clip';
        if (value.elide) {
          s.overflow = 'hidden';
          s.textOverflow = 'ellipsis';
          if (!value.wrapMode && !String(value.text).includes('\n'))
            s.whiteSpace = 'nowrap';
        }
        if (value.verticalAlignment === 128 && !value.wrapMode && height > 0)
          s.lineHeight = height + 'px';
        s.textAlign =
          value.horizontalAlignment === 4 || type === 'Button'
            ? 'center'
            : value.horizontalAlignment === 2
              ? 'right'
              : 'left';
      } else {
        s.backgroundColor = ['Rectangle', 'FloatingWindow'].includes(type)
          ? cssColor(value.color)
          : 'transparent';
        s.borderRadius = `${value.radius}px`;
        s.border = `${value.border.width}px solid ${cssColor(value.border.color)}`;
      }
      if (type === 'ShapePath') {
        for (const [key, v] of Object.entries({
          stroke: cssColor(value.strokeColor),
          fill: cssColor(value.fillColor),
          'stroke-width': value.strokeWidth,
          'stroke-linecap':
            value.capStyle === 32
              ? 'round'
              : value.capStyle === 16
                ? 'square'
                : 'butt',
          'stroke-linejoin':
            value.joinStyle === 128
              ? 'round'
              : value.joinStyle === 64
                ? 'bevel'
                : 'miter',
          'stroke-dasharray':
            value.strokeStyle === 2
              ? value.dashPattern.map((n) => n * value.strokeWidth).join(' ')
              : 'none',
          'stroke-dashoffset': value.dashOffset * value.strokeWidth,
          'fill-rule': value.fillRule === 0 ? 'evenodd' : 'nonzero',
        }))
          element.setAttribute(key, String(v));
      }
      if (type === 'PathSvg') element.setAttribute('d', value.path);
      if (type === 'PathRectangle')
        for (const [key, v] of Object.entries({
          x: value.x,
          y: value.y,
          width: value.width,
          height: value.height,
          rx: value.radius,
          ry: value.radius,
        }))
          element.setAttribute(key, String(v ?? 0));
      if (type === 'Rectangle') s.backgroundImage = 'none';
      if (type === 'Rectangle' && value.gradient) {
        const stops = nodes
          .filter((n) => parents.get(n.value) === value.gradient)
          .map((n) => n.value);
        s.backgroundImage =
          'linear-gradient(' +
          (value.gradient.orientation === 1 ? 'to right' : 'to bottom') +
          ',' +
          stops
            .map((v) => cssColor(v.color) + ' ' + v.position * 100 + '%')
            .join(',') +
          ')';
      }

      const style = element.style;
      // Reuse our input values (CSS getters may normalize colors/shorthands).
      // If another QML helper or script changed inline styles, reconcile them.
      const unchanged = paintedCss === style.cssText;
      for (const [key, next] of Object.entries(s)) {
        const text = String(next);
        if (unchanged ? paintedStyles[key] !== text : style[key] !== text)
          style[key] = text;
        s[key] = text;
      }
      paintedStyles = s;
      paintedCss = style.cssText;

      shapes.paint(value, type);
      if (type === 'FloatingWindow' && value.title)
        document.title = String(value.title);
    };
    return value;
  };
  // Bind through a setter supplied by generated code. A separate flag avoids
  // treating a binding's own write as an imperative assignment.
  const bind = (target, key, read, readonly = false, type = null) => {
    if (key === 'parent' && owners.has(target)) {
      initial.push(() => {
        const previous = disposers;
        disposers = owners.get(target).scope;
        try {
          effect(() => {
            target.parent = read();
          });
        } finally {
          disposers = previous;
        }
      });
      return;
    }
    let writing = false;
    let stop;
    let cached = target[key];
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get() {
        if (!writing && stop?.dirty) stop.run();
        return cached;
      },
      set(value) {
        const binding = Qt.bindingValue(value);
        if (!writing && binding) {
          if (readonly) throw new TypeError(`Readonly QML property: ${key}`);
          stop?.();
          bind(target, key, binding, false, type);
          untrack(start);
          return;
        }
        if (!writing && !animationWrite && readonly)
          throw new TypeError(`Readonly QML property: ${key}`);
        if (!writing && !animationWrite) stop?.();
        const behavior = behaviors.get(target)?.get(key);
        if (
          !animationWrite &&
          behavior?.value.enabled &&
          started.has(behavior.value) &&
          Number.isFinite(cached) &&
          Number.isFinite(value) &&
          cached !== value
        ) {
          animate(behavior.animation, () => {}, {
            target,
            key,
            from: cached,
            to: value,
          });
          return;
        }
        cached = type === 'color' ? Qt.color(value) : value;
        propertyWrites.get(target)?.get(key)?.();
      },
    });
    const owner = owners.get(target),
      scope = owner ? owner.scope : disposers;
    initial.push(() => {
      const previous = disposers;
      disposers = scope;
      try {
        stop = effect(() => {
          const value = read();
          writing = true;
          try {
            target[key] = value;
          } finally {
            writing = false;
          }
        });
        stop.onInvalidate = () => reactive.invalidate(target, key);
      } catch (error) {
        const wrapped = Error(
          'QML binding ' +
            (owners.get(target)?.type || 'object') +
            '.' +
            key +
            ' (' +
            (descriptions.get(target)?.url || '') +
            '): ' +
            error.message,
          { cause: error },
        );
        wrapped.qmlFatal = error.qmlFatal;
        throw wrapped;
      } finally {
        disposers = previous;
      }
    });
  };
  const alias = (target, key, read, write, readonly) => {
    let keys = aliases.get(target);
    if (!keys) aliases.set(target, (keys = new Map()));
    const record = { stop: null, updating: false, version: 0 };
    keys.set(key, record);
    return Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get() {
        if (!record.updating && record.stop?.dirty) record.stop.run();
        return read();
      },
      set(value) {
        if (readonly) throw new TypeError('Readonly QML alias: ' + key);
        const binding = Qt.bindingValue(value);
        if (!record.updating && binding) {
          bindAlias(target, key, binding);
          untrack(start);
          return;
        }
        if (!record.updating) {
          record.version++;
          record.stop?.();
          record.stop = null;
        }
        write(value);
      },
    });
  };
  const bindAlias = (target, key, read) => {
    const record = aliases.get(target)?.get(key);
    if (!record) throw Error('Unknown QML alias: ' + key);
    record.stop?.();
    const version = ++record.version,
      scope = owners.get(target)?.scope;
    initial.push(() => {
      if (version !== record.version) return;
      const previous = disposers;
      disposers = scope;
      try {
        record.stop = effect(() => {
          const next = read();
          untrack(() => {
            record.updating = true;
            try {
              target[key] = next;
            } finally {
              record.updating = false;
            }
          });
        });
        record.stop.onInvalidate = () => reactive.invalidate(target, key);
      } finally {
        disposers = previous;
      }
    });
  };
  const create = (type, index, parent, before, persistent = false) => {
    const svgTag = { ShapePath: 'g', PathSvg: 'path', PathRectangle: 'rect' }[
      type
    ];
    const element = svgTag
      ? document.createElementNS('http://www.w3.org/2000/svg', svgTag)
      : document.createElement(
          ['TextField', 'TextInput'].includes(type)
            ? 'input'
            : type === 'TextEdit'
              ? 'textarea'
              : type === 'Image'
                ? 'div'
                : type === 'Button'
                  ? 'button'
                  : 'div',
        );
    element.setAttribute('data-qml-node', String(index));
    element.setAttribute('data-qml-type', type);
    if (type === 'TextField') element.setAttribute('type', 'text');
    if (type === 'Button') element.setAttribute('type', 'button');
    const marker = elements.get(before);
    if (marker) {
      parent = parents.get(before);
      marker.parentElement.insertBefore(element, marker);
    } else (elements.get(parent) ?? document.body).appendChild(element);
    if (nonvisual.has(type))
      element.style.display = type === 'ShellRoot' ? 'contents' : 'none';
    const previous = disposers;
    if (persistent) disposers = null;
    try {
      return make(element, type, parent);
    } finally {
      disposers = previous;
    }
  };
  const textures = createQmlTextures({ elements, state, effect, untrack, signal, host,
    cleanup: fn => disposers?.push(fn) });
  const shapes = createQmlShapes({
    texture: textures.image,
    elements,
    parents,
    owners,
    cssColor,
    cleanup: (fn) => disposers?.push(fn),
    children: (value) => {
      const box = childSet(value);
      if (!box) return [];
      box.version.value;
      return [...box.items];
    },
  });
  const images = createQmlImages({
    document,
    effect,
    listen,
    host,
    cleanup: (fn) => disposers?.push(fn),
  });
  const models = createQmlModels({
    state,
    effect,
    untrack,
    instantiate,
    factories,
    owners,
    parents,
    elements,
    emit,
    listen,
    nodes,
    host,
    descriptions,
    scope: () => disposers,
    watchWrite,
    start,
  });
  return {
    // QML String.arg without changing frozen or shared JavaScript intrinsics.
    // https://doc.qt.io/qt-6/qml-string.html
    argFor(source) {
      if (typeof source !== 'string') return (...args) => source.arg(...args);
      return (value) => {
        const markers = [...source.matchAll(/%([1-9][0-9]?)/g)];
        if (!markers.length) return source;
        const lowest = Math.min(...markers.map((match) => Number(match[1])));
        return source.replace(/%([1-9][0-9]?)/g, (match, index) =>
          Number(index) === lowest ? String(value) : match,
        );
      };
    },
    create,
    console: Object.fromEntries(
      ['debug', 'log', 'info', 'warn', 'error'].map((name) => [
        name,
        (...args) => {
          if (owners.get(args[0])?.type === 'LoggingCategory') {
            const category = args.shift(),
              rank = { 0: 0, 4: 1, 1: 2, 2: 3, 3: 4 };
            if (
              { debug: 0, log: 0, info: 1, warn: 2, error: 3 }[name] <
              (rank[category.defaultLogLevel] ?? 0)
            )
              return;
            args.unshift(category.name + ':');
          }
          globalThis.console[name](...args);
        },
      ]),
    ),
    attachDelegate: (cell, index, view) =>
      models.attachDelegate(cell, index, view),
    ipc: {
      targets: () => [...ipcHandlers.keys()],
      call: (target, method, ...args) => {
        const handler = ipcHandlers.get(target);
        if (
          !handler ||
          typeof handler[method] !== 'function' ||
          ['constructor', '__proto__', 'prototype'].includes(method)
        )
          throw Error('Unknown QML IPC method');
        return handler[method](...args);
      },
    },
    behavior: (target, key, value, animation) => {
      let map = behaviors.get(target);
      if (!map) behaviors.set(target, (map = new Map()));
      map.set(key, { value, animation });
      value.targetProperty = { object: target, name: key };
      value.animation = animation;
    },
    dimension,
    position,
    qt,
    share: (url, value) => {
      if (!sharedValues.has(url)) sharedValues.set(url, value);
    },
    shared: (url) => sharedValues.get(url),
    apply: (value, properties) => {
      for (const [key, next] of Object.entries(properties)) {
        if (descriptions.get(value)?.readonly.includes(key))
          throw Error('Cannot override readonly QML property: ' + key);
        if (
          !(key in value) &&
          !descriptions.get(value)?.properties.includes(key)
        )
          throw Error('Unknown initial property: ' + key);
        (aliases.get(value)?.has(key) ? bindAlias : bind)(
          value,
          key,
          Qt.bindingValue(next) ?? (() => next),
        );
      }
    },
    describe: (value, tags, properties, url, readonly = []) => {
      descriptions.set(value, { tags, properties, url, readonly });
      for (const key of new Set([...Object.keys(value), ...properties])) {
        if (
          key.includes('.') ||
          key.endsWith('Changed') ||
          key + 'Changed' in value
        )
          continue;
        let changed;
        Object.defineProperty(value, key + 'Changed', {
          configurable: true,
          get: () => {
            if (changed) return changed;
            changed = signal();
            let previous = untrack(() => value[key]);
            const previousScope = disposers;
            disposers = owners.get(value)?.scope ?? null;
            try {
              effect(() => {
                const next = value[key];
                if (!Object.is(next, previous)) {
                  previous = next;
                  changed();
                }
              });
            } finally {
              disposers = previousScope;
            }
            return changed;
          },
        });
      }
    },
    cast: (value, type) =>
      descriptions.get(value)?.tags.includes(type.split('.').at(-1))
        ? value
        : null,
    element: (value) => elements.get(value),
    listen: (value, name, fn) =>
      listen(elements.get(value), name, (event) => {
        if (enabled(value)) fn(event);
      }),
    delegate: (value, factory) => factories.set(value, factory),
    component: (value, factory) => factories.set(value, factory),
    make,
    bind,
    bindAlias,
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
