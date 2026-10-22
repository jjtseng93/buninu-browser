// Runs solely in page-realm.js. Flat DOM references and reactive values, not a
// retained QML AST/component tree. The page owns timers/listeners and disposal.
export function createQmlRuntime(reactive) {
  const {state, effect} = reactive;
  const viewport = state({width: innerWidth, height: innerHeight});
  addEventListener('resize', () => { viewport.width = innerWidth; viewport.height = innerHeight; });
  const make = (element, type) => {
    const value = state({width: null, height: null, implicitWidth: null, implicitHeight: null,
      x: 0, y: 0, color: type === 'Text' ? 'black' : 'transparent', radius: 0,
      opacity: 1, visible: true, enabled: true, clip: false, text: '', title: '',
      font: state({pixelSize: 16, family: 'sans-serif', bold: false}),
      border: state({width: 0, color: 'black'}),
      anchors: state({fill: null, centerIn: null, margins: 0}),
      horizontalAlignment: 0});
    effect(() => {
      const s = element.style, fill = value.anchors.fill, center = value.anchors.centerIn;
      const margin = value.anchors.margins;
      const width = fill ? fill.width - margin * 2 : value.width ?? value.implicitWidth;
      const height = fill ? fill.height - margin * 2 : value.height ?? value.implicitHeight;
      s.position = 'absolute'; s.boxSizing = 'border-box';
      s.width = width == null ? 'auto' : `${width}px`;
      s.height = height == null ? 'auto' : `${height}px`;
      s.left = `${fill ? margin : center ? center.width / 2 : value.x}px`;
      s.top = `${fill ? margin : center ? center.height / 2 : value.y}px`;
      s.transform = center ? 'translate(-50%, -50%)' : 'none';
      s.display = value.visible ? 'block' : 'none'; s.opacity = String(value.opacity);
      s.pointerEvents = value.enabled ? 'auto' : 'none'; s.overflow = value.clip ? 'hidden' : 'visible';
      if (type === 'Text') {
        element.textContent = String(value.text); s.color = value.color;
        s.fontSize = `${value.font.pixelSize}px`; s.fontFamily = value.font.family;
        s.fontWeight = value.font.bold ? 'bold' : 'normal'; s.whiteSpace = 'pre';
        s.textAlign = value.horizontalAlignment === 4 ? 'center' : 'left';
      } else {
        s.backgroundColor = value.color; s.borderRadius = `${value.radius}px`;
        s.border = `${value.border.width}px solid ${value.border.color}`;
      }
      if (value.title) document.title = String(value.title);
    });
    return value;
  };
  // Bind through a setter supplied by generated code. A separate flag avoids
  // treating a binding's own write as an imperative assignment.
  const bind = (target, key, read) => {
    let writing = false;
    let stop;
    let cached = target[key];
    Object.defineProperty(target, key, {configurable: true, enumerable: true,
      get() { return cached; }, set(value) { if (!writing) stop?.(); cached = value; }});
    stop = effect(() => { const value = read(); writing = true; try { target[key] = value; } finally { writing = false; } });
  };
  return {make, bind, viewport};
}
