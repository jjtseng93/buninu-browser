// Runs solely in page-realm.js. Flat DOM references and reactive values, not a
// retained QML AST/component tree. The page owns timers/listeners and disposal.
export function createQmlRuntime(reactive) {
  const {state, effect} = reactive;
  const viewport = state({width: innerWidth, height: innerHeight});
  addEventListener('resize', () => { viewport.width = innerWidth; viewport.height = innerHeight; });
  const make = (element, type) => {
    const value = state({width: null, height: null, implicitWidth: null, implicitHeight: null,
      x: 0, y: 0, color: ['Text','Label','TextField','Button'].includes(type) ? 'black' : 'transparent', radius: 0,
      opacity: 1, visible: true, enabled: true, clip: false, text: '', title: '',
      font: state({pixelSize: 16, family: 'sans-serif', bold: false}),
      border: state({width: 0, color: 'black'}),
      anchors: state({fill: null, centerIn: null, margins: 0}),
      horizontalAlignment: 0, textFormat: 0, spacing: 0, placeholderText: '', readOnly: false, selectByMouse: false,
      Accessible: state({name: ''})});
    if (['QtObject','Singleton'].includes(type)) return value;
    if (type === 'TextField') {
      element.addEventListener('input', () => { value.text = element.value; });
      element.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
          element.selectionStart = 0; element.selectionEnd = element.value.length;
          event.preventDefault();
        }
      });
    }
    if (type === 'Button') element.addEventListener('keydown', event => {
      if (!event.ctrlKey && !event.altKey && !event.metaKey && ['Enter', ' '].includes(event.key)) {
        event.preventDefault(); if (value.enabled) element.click();
      }
    });
    effect(() => {
      const s = element.style, fill = value.anchors.fill, center = value.anchors.centerIn;
      const margin = value.anchors.margins;
      const width = fill ? fill.width - margin * 2 : value.width ?? value.implicitWidth;
      const height = fill ? fill.height - margin * 2 : value.height ?? value.implicitHeight;
      const inColumn = element.parentElement?.getAttribute('data-qml-type') === 'Column';
      s.position = inColumn ? 'relative' : 'absolute'; s.flexShrink = '0'; s.boxSizing = 'border-box';
      s.width = width == null ? 'auto' : `${width}px`;
      s.height = height == null ? 'auto' : `${height}px`;
      s.left = `${fill ? margin : center ? center.width / 2 : value.x}px`;
      s.top = `${fill ? margin : center ? center.height / 2 : value.y}px`;
      s.transform = center ? 'translate(-50%, -50%)' : 'none';
      s.display = value.visible ? (type === 'Column' ? 'flex' : 'block') : 'none';
      if (type === 'Column') { s.flexDirection = 'column'; s.gap = `${value.spacing}px`; s.alignItems = 'flex-start'; } s.opacity = String(value.opacity);
      s.pointerEvents = value.enabled ? 'auto' : 'none'; s.overflow = value.clip ? 'hidden' : 'visible';
      if (['Text','Label','TextField','Button'].includes(type)) {
        if (type === 'TextField') {
          // Do not reset the caret/selection on unrelated reactive updates.
          if (element.value !== String(value.text)) element.value = String(value.text);
          element.readOnly = value.readOnly; element.placeholder = value.placeholderText;
          s.userSelect = value.selectByMouse ? 'text' : 'none';
        } else element.textContent = String(value.text);
        if (type === 'TextField' || type === 'Button') {
          element.disabled = !value.enabled; s.padding = '8px 10px';
          s.backgroundColor = type === 'Button' ? '#bcebf0' : '#ffffff';
          s.border = '1px solid #6a8791'; s.borderRadius = '5px';
          element.setAttribute('aria-label', value.Accessible.name || String(value.text));
        } s.color = value.color;
        s.fontSize = `${value.font.pixelSize}px`; s.fontFamily = value.font.family;
        s.fontWeight = value.font.bold ? 'bold' : 'normal'; s.whiteSpace = 'pre';
        s.textAlign = value.horizontalAlignment === 4 || type === 'Button' ? 'center' : 'left';
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
  const bind = (target, key, read, readonly = false) => {
    let writing = false;
    let stop;
    let cached = target[key];
    Object.defineProperty(target, key, {configurable: true, enumerable: true,
      get() { return cached; }, set(value) { if (!writing && readonly) throw new TypeError(`Readonly QML property: ${key}`); if (!writing) stop?.(); cached = value; }});
    stop = effect(() => { const value = read(); writing = true; try { target[key] = value; } finally { writing = false; } });
  };
  const alias = (target,key,read,write,readonly) => Object.defineProperty(target,key,{
    configurable:true,enumerable:true,get:read,set(value){if(readonly)throw new TypeError(`Readonly QML alias: ${key}`);write(value);}
  });
  return {make, bind, alias, viewport};
}
