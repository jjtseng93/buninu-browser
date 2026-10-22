export const nonvisualTypes = new Set([
  'Repeater',
  'TapHandler',
  'HoverHandler',
  'QtObject',
  'Singleton',
  'Timer',
  'Connections',
  'FileView',
  'Process',
  'StdioCollector',
  'TextMetrics',
  'FontMetrics',
]);
export const typeProperties = {
  Repeater: ['model', 'delegate', 'count', 'itemAt'],
  TapHandler: ['enabled', 'acceptedButtons', 'gesturePolicy', 'tapped'],
  HoverHandler: ['enabled', 'cursorShape', 'hovered'],
  Timer: [
    'interval',
    'running',
    'repeat',
    'triggeredOnStart',
    'start',
    'stop',
    'restart',
    'triggered',
  ],
  Connections: ['target', 'enabled', 'ignoreUnknownSignals'],
  FileView: [
    'path',
    'blockLoading',
    'watchChanges',
    'printErrors',
    'loaded',
    'text',
    'data',
    'reload',
    'waitForJob',
    'loadedChanged',
    'fileChanged',
    'loadFailed',
  ],
  Process: [
    'running',
    'command',
    'stdout',
    'stderr',
    'exited',
    'startDetached',
  ],
  StdioCollector: ['text', 'waitForEnd', 'streamFinished'],
  TextMetrics: [
    'text',
    'font',
    'advanceWidth',
    'width',
    'height',
    'boundingRect',
  ],
  FontMetrics: [
    'font',
    'height',
    'ascent',
    'descent',
    'averageCharacterWidth',
    'advanceWidth',
  ],
};
// Serialized into the page together with the reactive runtime.
export function createQt() {
  const clamp = (x) => Math.max(0, Math.min(1, Number(x)));
  function rgba(r, g, b, a = 1) {
    r = clamp(r);
    g = clamp(g);
    b = clamp(b);
    a = clamp(a);
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      d = max - min;
    const hue =
      d === 0
        ? -1
        : (max === r
            ? (g - b) / d + (g < b ? 6 : 0)
            : max === g
              ? (b - r) / d + 2
              : (r - g) / d + 4) / 6;
    const hex = (v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0');
    return Object.freeze({
      r,
      g,
      b,
      a,
      hsvSaturation: max === 0 ? 0 : d / max,
      hsvValue: max,
      hsvHue: hue,
      toString() {
        return '#' + (a < 1 ? hex(a) : '') + hex(r) + hex(g) + hex(b);
      },
    });
  }
  function color(value) {
    if (value && typeof value === 'object' && 'r' in value) return value;
    let s = String(value).toLowerCase();
    s =
      {
        black: '#000000',
        white: '#ffffff',
        transparent: '#00000000',
        red: '#ff0000',
        blue: '#0000ff',
        green: '#008000',
      }[s] || s;
    if (/^#[0-9a-f]{3}$/.test(s))
      s = '#' + [...s.slice(1)].map((c) => c + c).join('');
    if (/^#[0-9a-f]{6}$/.test(s))
      return rgba(
        parseInt(s.slice(1, 3), 16) / 255,
        parseInt(s.slice(3, 5), 16) / 255,
        parseInt(s.slice(5, 7), 16) / 255,
      );
    if (/^#[0-9a-f]{8}$/.test(s))
      return rgba(
        parseInt(s.slice(3, 5), 16) / 255,
        parseInt(s.slice(5, 7), 16) / 255,
        parseInt(s.slice(7, 9), 16) / 255,
        parseInt(s.slice(1, 3), 16) / 255,
      );
    throw Error('Unsupported QML color: ' + s);
  }
  return {
    rgba,
    color,
    darker: (v, f = 2) => {
      const c = color(v);
      return rgba(c.r / f, c.g / f, c.b / f, c.a);
    },
    application: { active: true },
    atob,
    LeftButton: 1,
    PointingHandCursor: 13,
    ControlModifier: 0x04000000,
    AltModifier: 0x08000000,
    MetaModifier: 0x10000000,
    binding: () => {
      throw Error('Qt.binding is not implemented');
    },
    createComponent: () => {
      throw Error('Qt.createComponent is not implemented');
    },
  };
}
