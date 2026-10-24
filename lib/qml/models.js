// Serialized with the QML runtime. Models keep data/ranges; views instantiate only
// the visible delegate factories. No HTML strings or retained QML syntax trees.
export function createQmlModels(api) {
  const {
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
    scope,
    host,
    descriptions,
    watchWrite,
  } = api;
  const xmlModels = new WeakMap(),
    lists = new WeakMap(),
    groups = new WeakMap(),
    views = new WeakMap(),
    delegates = new WeakMap();
  let creating = null;
  const attachDelegate = (cell, index, view) => {
    if (!['ListView', 'GridView'].includes(owners.get(view)?.type)) return;
    const model = view.model,
      info = delegates.get(model);
    const attached = state({
      inPersistedItems:
        !!creating && creating.model === model && creating.index === index,
    });
    cell.DelegateModel = attached;
    if (info) {
      const forget = () => {
        for (const [at, item] of info.held)
          if (item === cell) info.held.delete(at);
        info.persisted.count = info.held.size;
      };
      watchWrite(attached, 'inPersistedItems', () => {
        if (attached.inPersistedItems) info.held.set(cell.index, cell);
        else {
          forget();
          // A caller may adopt the item into its view in this same JS turn.
          queueMicrotask(() => {
            if (
              !attached.inPersistedItems &&
              ![...(views.get(view)?.instances.values() ?? [])].includes(cell)
            )
              cell.destroy?.();
          });
        }
        info.persisted.count = info.held.size;
      });
      if (attached.inPersistedItems) {
        info.held.set(index, cell);
        info.persisted.count = info.held.size;
      }
      scope()?.push(forget);
    }
  };
  const count = (model) =>
    typeof model === 'number'
      ? Math.max(0, Math.floor(model))
      : Array.isArray(model)
        ? model.length
        : (model?.count ?? 0);
  const get = (model, index) =>
    typeof model === 'number'
      ? index
      : Array.isArray(model)
        ? model[index]
        : (model?.get?.(index) ?? index);
  const groupCount = (ranges) => ranges.reduce((sum, [a, b]) => sum + b - a, 0);
  const member = (ranges, index) => {
    for (const [a, b] of ranges) {
      if (index < b - a) return a + index;
      index -= b - a;
    }
    return -1;
  };
  const add = (ranges, start, end) => {
    const result = [];
    for (const [a, b] of [...ranges, [start, end]].sort(
      (a, b) => a[0] - b[0],
    )) {
      if (b <= a) continue;
      const last = result.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else result.push([a, b]);
    }
    return result;
  };
  const remove = (ranges, start, end) =>
    ranges.flatMap(([a, b]) =>
      b <= start || a >= end
        ? [[a, b]]
        : [
            [a, Math.min(b, start)],
            [Math.max(a, end), b],
          ].filter(([a, b]) => b > a),
    );
  function make(v, type) {
    if (type === 'XmlListModel') {
      Object.assign(v, {
        source: '',
        xml: '',
        query: '',
        status: 0,
        progress: 0,
        count: 0,
      });
      const data = state({ rows: [], error: '' });
      xmlModels.set(v, data);
      v.get = (i) => data.rows[i];
      v.index = (row, column = 0) => ({ row, column });
      v.data = (index, role) =>
        data.rows[index.row]?.[
          nodes.filter(
            (n) => parents.get(n.value) === v && n.type === 'XmlListModelRole',
          )[role - 256]?.value.name
        ];
      v.errorString = () => data.error;
    }
    if (type === 'XmlListModelRole')
      Object.assign(v, { name: '', elementName: '', attributeName: '' });
    if (type === 'ListModel') {
      const data = state({ rows: [], version: 0 });
      lists.set(v, data);
      v.dynamicRoles = false;
      Object.defineProperty(v, 'count', { get: () => data.rows.length });
      v.get = (index) => {
        data.version;
        return data.rows[index];
      };
      v.append = (rows) => {
        data.rows = [...data.rows, ...(Array.isArray(rows) ? rows : [rows])];
      };
      v.insert = (index, rows) => {
        const copy = [...data.rows];
        copy.splice(index, 0, ...(Array.isArray(rows) ? rows : [rows]));
        data.rows = copy;
      };
      v.remove = (index, n = 1) => {
        const copy = [...data.rows];
        copy.splice(index, n);
        data.rows = copy;
      };
      v.clear = () => {
        data.rows = [];
      };
      v.set = (index, row) => {
        const copy = [...data.rows];
        copy[index] = { ...copy[index], ...row };
        data.rows = copy;
      };
      v.setProperty = (index, key, value) => v.set(index, { [key]: value });
      v.move = (from, to, n) => {
        const copy = [...data.rows],
          part = copy.splice(from, n);
        copy.splice(to, 0, ...part);
        data.rows = copy;
      };
    }
    if (type === 'DelegateModelGroup') {
      Object.assign(v, { name: '', includeByDefault: false });
      const data = state({ ranges: [] });
      groups.set(v, data);
      Object.defineProperty(v, 'count', { get: () => groupCount(data.ranges) });
      v.get = (index) => ({ itemsIndex: member(data.ranges, index) });
      v.removeGroups = (from, n, names) => {
        const namesList = Array.isArray(names) ? names : [names];
        if (!namesList.includes(v.name)) return;
        let left = n,
          position = from,
          next = data.ranges;
        const cuts = [];
        for (const [a, b] of data.ranges) {
          if (position >= b - a) {
            position -= b - a;
            continue;
          }
          const take = Math.min(left, b - a - position);
          cuts.push([a + position, a + position + take]);
          left -= take;
          position = 0;
          if (left <= 0) break;
        }
        for (const [a, b] of cuts) next = remove(next, a, b);
        data.ranges = next;
      };
    }
    if (type === 'DelegateModel') {
      Object.assign(v, {
        model: 0,
        delegate: null,
        groups: null,
        filterOnGroup: 'items',
      });
      const persisted = state({ name: 'persistedItems', count: 0 }),
        held = new Map();
      delegates.set(v, { held, persisted });
      const group = (name) =>
        name === 'persistedItems'
          ? persisted
          : (Array.isArray(v.groups) ? v.groups : [v.groups]).find(
              (g) => g?.name === name,
            );
      persisted.get = (index) => ({
        itemsIndex: [...held.keys()].sort((a, b) => a - b)[index],
      });
      persisted.removeGroups = (from, n) => {
        for (const index of [...held.keys()]
          .sort((a, b) => a - b)
          .slice(from, from + n)) {
          const cell = held.get(index);
          if (cell) cell.DelegateModel.inPersistedItems = false;
          if (views.get(v._view)?.instances.get(index) !== cell)
            cell?.destroy?.();
          held.delete(index);
        }
        persisted.count = held.size;
      };
      v.persistedItems = persisted;
      v.items = {
        get: (index) => ({ itemsIndex: index, model: get(v.model, index) }),
        addGroups: (from, n, names) => {
          for (const name of Array.isArray(names) ? names : [names]) {
            const target = group(name),
              data = groups.get(target);
            if (data)
              data.ranges = add(
                data.ranges,
                Math.max(0, from),
                Math.min(count(v.model), from + n),
              );
          }
        },
        create: (index) => {
          if (!Number.isInteger(index) || index < 0 || index >= count(v.model))
            return null;
          const view = v._view,
            factory = view && factories.get(view);
          if (!factory) return null;
          let cell = held.get(index) || views.get(view)?.instances.get(index);
          if (cell) {
            cell.DelegateModel.inPersistedItems = true;
            return cell;
          }
          const previous = creating;
          creating = { model: v, index };
          try {
            cell = instantiate(() => factory(index, get(v.model, index)), view);
          } finally {
            creating = previous;
          }
          return cell;
        },
      };
      Object.defineProperty(v, 'count', {
        get: () =>
          v.filterOnGroup === 'items'
            ? count(v.model)
            : (group(v.filterOnGroup)?.count ?? 0),
      });
      v.get = (index) =>
        get(
          v.model,
          v.filterOnGroup === 'items'
            ? index
            : member(groups.get(group(v.filterOnGroup))?.ranges ?? [], index),
        );
    }
    if (type === 'ListView' || type === 'GridView')
      Object.assign(v, {
        header: null,
        footer: null,
        headerItem: null,
        footerItem: null,
        model: [],
        count: 0,
        currentIndex: -1,
        currentItem: null,
        cacheBuffer: 0,
        displayMarginBeginning: 0,
        displayMarginEnd: 0,
        reuseItems: false,
        keyNavigationEnabled: true,
        keyNavigationWraps: false,
        highlightMoveDuration: 0,
        orientation: 2,
        cellWidth: 100,
        cellHeight: 100,
        flow: 0,
      });
  }
  function start(v, type) {
    if (type === 'XmlListModel') {
      const model = xmlModels.get(v);
      let generation = 0,
        disposed = false;
      const roles = () =>
        nodes
          .filter(
            (n) => parents.get(n.value) === v && n.type === 'XmlListModelRole',
          )
          .map((n) => n.value);
      const path = (base, query) => {
        if (!/^(?:\/?[A-Za-z_][\w:.-]*)+$/.test(query))
          throw Error(
            'XmlListModel supports simple element paths only: ' + query,
          );
        let result = [base];
        for (const name of query.split('/').filter(Boolean))
          result = result.flatMap((n) =>
            [...n.children].filter((child) => child.tagName === name),
          );
        return result;
      };
      v.reload = async () => {
        const current = ++generation,
          source = v.source,
          xml = v.xml,
          query = v.query;
        model.rows = [];
        v.count = 0;
        v.progress = 0;
        model.error = '';
        if (!source && !xml) {
          v.status = 0;
          return;
        }
        v.status = 2;
        try {
          let text = xml;
          if (!text) {
            const url = new URL(source, descriptions.get(v).url).href;
            if (url.startsWith('file:')) {
              if (!host) throw Error('Local XML needs QML host');
              const result = host.read(url);
              if (result.error) throw Error(result.error);
              text = result.text;
            } else {
              const response = await fetch(url);
              if (!response.ok) throw Error('XML HTTP ' + response.status);
              text = await response.text();
            }
          }
          if (text.length > 4 * 1024 * 1024)
            throw Error('XML model source limit exceeded');
          const document = new DOMParser().parseFromString(
            text,
            'application/xml',
          );
          if (document.querySelector('parsererror')) throw Error('Invalid XML');
          const selected = path(document, query),
            fields = roles();
          if (selected.length > 100000)
            throw Error('XML model row limit exceeded');
          const next = selected.map((node) =>
            Object.fromEntries(
              fields.map((role) => {
                const element = role.elementName
                  ? path(node, role.elementName)[0]
                  : node;
                return [
                  role.name,
                  role.attributeName
                    ? (element?.getAttribute(role.attributeName) ?? '')
                    : (element?.textContent ?? ''),
                ];
              }),
            ),
          );
          if (disposed || current !== generation) return;
          model.rows = next;
          v.count = next.length;
          v.progress = 1;
          v.status = 1;
        } catch (e) {
          if (disposed || current !== generation) return;
          model.error = String(e.message);
          v.status = 3;
        }
      };
      effect(() => {
        v.source;
        v.xml;
        v.query;
        untrack(() => {
          void v.reload();
        });
      });
      scope()?.push(() => {
        disposed = true;
        generation++;
      });
    }

    if (type === 'DelegateModelGroup') {
      const parent = parents.get(v),
        data = groups.get(v);
      if (v.includeByDefault && parent?.model)
        data.ranges = [[0, count(parent.model)]];
    }
    if (type !== 'ListView' && type !== 'GridView') return;
    const instances = new Map(),
      pool = [];
    const measuredSizes = new Map(), revision = state({ value: 0 });
    let measuredIndices = [], corrections = [], cacheWidth, cacheHeight, cacheHorizontal,
      queued = false, disposed = false;
    const schedule = () => {
      if (queued || disposed) return;
      queued = true;
      queueMicrotask(() => { queued = false; if (!disposed) revision.value++; });
    };
    let busy = false,
      rowSize = 24,
      lastModel;
    const horizontal = () => type === 'ListView' && v.orientation === 1;
    const step = () =>
      type === 'GridView' ? Math.max(1, v.cellHeight) : rowSize + v.spacing;
    const cols = () =>
      type === 'GridView'
        ? Math.max(1, Math.floor(v.width / Math.max(1, v.cellWidth)))
        : 1;
    const clear = () => {
      for (const cell of [...instances.values(), ...pool])
        if (!cell.DelegateModel?.inPersistedItems) cell.destroy?.();
      instances.clear();
      pool.length = 0;
    };
    scope()?.push(() => { disposed = true; clear(); });
    // Qt drains the pool at the write, even when it is re-enabled in the same
    // JS turn (Flea StableModel.drainHidden). A batched effect misses that edge.
    watchWrite(v, 'reuseItems', () => {
      if (!v.reuseItems)
        untrack(() => {
          while (pool.length) pool.pop().destroy?.();
        });
    });
    const rebuildSizes = () => {
      measuredIndices = [...measuredSizes.keys()].sort((a, b) => a - b);
      let sum = 0;
      corrections = measuredIndices.map(i => {
        sum += Math.max(1, measuredSizes.get(i) + v.spacing) - Math.max(1, step());
        return sum;
      });
    };
    const position = (index) => {
      if (type === 'GridView') return Math.floor(index / cols()) * step();
      let lo = 0, hi = measuredIndices.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (measuredIndices[mid] < index) lo = mid + 1; else hi = mid; }
      return index * Math.max(1, step()) + (lo ? corrections[lo - 1] : 0);
    };
    const indexAtOffset = (offset, total = v.count) => {
      let lo = 0, hi = total;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (position(mid + 1) <= offset) lo = mid + 1; else hi = mid; }
      return lo;
    };
    const layout = () => {
      revision.value;
      const model = v.model,
        total = count(model),
        width = v.width,
        height = v.height,
        buffer = v.cacheBuffer,
        marginStart = v.displayMarginBeginning,
        marginEnd = v.displayMarginEnd,
        reuse = v.reuseItems,
        current = v.currentIndex;
      let offset = horizontal() ? v.contentX : v.contentY;
      // Read every instantiated delegate dimension reactively. Offscreen sizes
      // stay as sparse measurements; unseen rows retain an estimate, without
      // allocating or iterating over the whole model.
      const measurements = type === 'ListView' ? [...instances].map(([i, cell]) =>
        [i, horizontal() ? cell.width : cell.height]) : [];
      // A synchronous bound-property read can re-enter layout. Keep tracking
      // its inputs before returning, or that effect loses future updates.
      if (busy) return;
      // Model replacement starts at the origin; mutations of the same model
      // retain the current position. Numeric models are replacements too.
      if (lastModel !== undefined && lastModel !== model) {
        untrack(() => { v.contentX = v.originX; v.contentY = v.originY; });
        offset = horizontal() ? v.originX : v.originY;
      }
      if (type === 'ListView') {
        if (lastModel !== model || cacheWidth !== width || cacheHorizontal !== horizontal() || (horizontal() && cacheHeight !== height)) measuredSizes.clear();
        cacheWidth = width; cacheHeight = height; cacheHorizontal = horizontal();
        if (lastModel === model) for (const [i, size] of measurements)
          if (i < total && Number.isFinite(size) && size >= 0) measuredSizes.set(i, size);
        for (const i of measuredSizes.keys()) if (i >= total) measuredSizes.delete(i);
        if (measuredSizes.get(0) > 0) rowSize = measuredSizes.get(0);
        rebuildSizes();
      }
      const size = Math.max(1, step()),
        columns = cols();
      const beginning = Math.max(0, offset - buffer - marginStart),
        ending = offset + (horizontal() ? width : height) + buffer + marginEnd;
      const first = type === 'ListView' ? indexAtOffset(beginning, total) : Math.floor(beginning / size) * columns,
        last = Math.min(total, type === 'ListView' ? indexAtOffset(ending, total) + 2 : Math.ceil(ending / size) * columns + columns);
      if (last - first > 500)
        throw Error('QML view visible delegate limit (500)');
      busy = true;
      try {
        untrack(() => {
          if (lastModel !== model) {
            clear();
            lastModel = model;
          }
          if (model && typeof model === 'object' && !Array.isArray(model))
            model._view = v;
          v.count = total;
          if (!reuse) while (pool.length) pool.pop().destroy?.();
          for (const [index, cell] of instances)
            if (index < first || index >= last) {
              instances.delete(index);
              schedule();
              if (cell.DelegateModel?.inPersistedItems) continue;
              if (reuse) {
                cell.visible = false;
                emit(cell, type + '.onPooled');
                pool.push(cell);
              } else if (!cell.DelegateModel?.inPersistedItems)
                cell.destroy?.();
            }
          for (let index = first; index < last; index++) {
            let cell = instances.get(index);
            const data = get(model, index);
            if (!cell) {
              const held = delegates.get(model)?.held.get(index);
              cell = held || pool.pop();
              if (cell) {
                cell.index = index;
                cell.modelData = data;
                cell.visible = true;
                if (!held) emit(cell, type + '.onReused');
              } else cell = instantiate(() => factories.get(v)(index, data), v);
              instances.set(index, cell);
              schedule();
            } else if (cell.modelData !== data) cell.modelData = data;
            if (type === 'GridView') {
              cell.x = (index % columns) * v.cellWidth;
              cell.y = position(index);
            } else if (horizontal()) cell.x = position(index);
            else cell.y = position(index);
          }
          if (horizontal()) {
            v.contentWidth = position(total);
            if (!v.contentHeight) v.contentHeight = height;
          } else {
            v.contentHeight = type === 'ListView' ? position(total) : Math.ceil(total / columns) * step();
            if (!v.contentWidth) v.contentWidth = width;
          }
          v.headerItem = v.header;
          v.footerItem = v.footer;
          if (v.footer) {
            v.footer.y = v.contentHeight;
            v.contentHeight += v.footer.height || 0;
          }
          v.currentItem = instances.get(current) ?? null;
        });
      } finally {
        busy = false;
      }
    };
    views.set(v, { instances, layout });
    v.itemAtIndex = (index) => instances.get(index) ?? null;
    v.itemAt = (x, y) => v.itemAtIndex(v.indexAt(x, y));
    v.indexAt = (x, y) => {
      if (type === 'ListView') {
        const at = horizontal() ? x : y, index = indexAtOffset(at);
        const extent = measuredSizes.get(index) ?? rowSize;
        return at >= 0 && index < v.count && at < position(index) + extent ? index : -1;
      }
      const index =
        Math.floor((horizontal() ? x : y) / step()) * cols() +
        (type === 'GridView' ? Math.floor(x / v.cellWidth) : 0);
      return index >= 0 && index < v.count ? index : -1;
    };
    v.forceLayout = layout;
    v.positionViewAtIndex = (index, mode = 0) => {
      const at = position(index),
        extent = type === 'ListView' ? measuredSizes.get(index) ?? rowSize : step(),
        size = horizontal() ? v.width : v.height,
        old = horizontal() ? v.contentX : v.contentY;
      let next = at;
      if (mode === 1) next = at - size / 2 + extent / 2;
      else if (mode === 2) next = at - size + extent;
      else if (mode === 3 || mode === 4)
        next =
          at < old ? at : at + extent > old + size ? at + extent - size : old;
      if (horizontal()) v.contentX = next;
      else v.contentY = next;
      v.returnToBounds();
      layout();
    };
    v.positionViewAtBeginning = () => v.positionViewAtIndex(0, 0);
    v.positionViewAtEnd = () =>
      v.positionViewAtIndex(Math.max(0, v.count - 1), 2);
    listen(elements.get(v), 'keydown', (event) => {
      if (
        !v.keyNavigationEnabled ||
        !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(
          event.key,
        ) ||
        !v.count
      )
        return;
      const delta = ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1;
      let next = v.currentIndex + delta;
      if (v.keyNavigationWraps) next = (next + v.count) % v.count;
      v.currentIndex = Math.max(0, Math.min(v.count - 1, next));
      v.positionViewAtIndex(v.currentIndex, 4);
      event.preventDefault();
    });
    effect(layout);
  }
  return { make, start, attachDelegate, rows:model=>{const data=lists.get(model)||xmlModels.get(model);if(!data)return null;data.version;return data.rows;} };
}
