// The enumerations a QML component can name without importing anything (Qt.AlignLeft aside, which
// lives in builtins.js), written as plain data. enumsSource() turns them into the `const` statements
// every generated component starts with, so a component sees them as locals.
//
// An entry is one of:
//   Name: { Key: value, ... }               a table
//   Name: inherits("Other", { Key: ... })   Other's keys plus its own, resolved when the component runs
//   Name: alias("Other")                    the same object under a second name

const INHERITS = Symbol('inherits');
const ALIAS = Symbol('alias');
const inherits = (name, own) => ({ [INHERITS]: name, ...own });
const alias = (name) => ({ [ALIAS]: name });

export const ENUMS = {
  Locale: {
    LongFormat: 0, ShortFormat: 1, NarrowFormat: 2,
    MetricSystem: 0, ImperialUSSystem: 1, ImperialUKSystem: 2,
  },
  StandardKey: { Copy: 9, Paste: 10, Cut: 8, SelectAll: 26, Undo: 11, Redo: 12 },
  ShaderEffect: {
    Uncompiled: 0, Compiled: 1, Error: 2,
    NoCulling: 0, BackFaceCulling: 1, FrontFaceCulling: 2,
  },
  MediaPlayer: {
    NoError: 0, ResourceError: 1, NetworkError: 2, FormatError: 3, AccessDeniedError: 4,
    StoppedState: 0, PlayingState: 1, PausedState: 2,
    NoMedia: 0, LoadingMedia: 1, LoadedMedia: 2, StalledMedia: 3, BufferingMedia: 4,
    BufferedMedia: 5, EndOfMedia: 6, InvalidMedia: 7,
    Infinite: -1,
  },
  VideoOutput: { Stretch: 0, PreserveAspectFit: 1, PreserveAspectCrop: 2 },
  WebEngineView: { LoadStartedStatus: 0, LoadStoppedStatus: 1, LoadSucceededStatus: 2, LoadFailedStatus: 3 },
  WebEngineNavigationRequest: {
    LinkClickedNavigation: 0, TypedNavigation: 1, FormSubmittedNavigation: 2,
    BackForwardNavigation: 3, ReloadNavigation: 4, OtherNavigation: 5, RedirectNavigation: 6,
  },
  XmlListModel: { Null: 0, Ready: 1, Loading: 2, Error: 3 },
  LoggingCategory: { Debug: 0, Info: 4, Warning: 1, Critical: 2, Fatal: 3 },
  Flow: { LeftToRight: 0, TopToBottom: 1 },
  ListView: {
    Beginning: 0, Center: 1, End: 2, Visible: 3, Contain: 4, SnapPosition: 5,
    Vertical: 2, Horizontal: 1, NoHighlightRange: 0,
  },
  GridView: inherits('ListView', { FlowLeftToRight: 0, FlowTopToBottom: 1 }),
  Binding: { RestoreNone: 0, RestoreBinding: 1, RestoreValue: 2, RestoreBindingOrValue: 3 },
  Gradient: { Vertical: 0, Horizontal: 1 },
  // Bit flags, one per kind of pointing device, AllDevices holding them all. Qt's documentation
  // names the kinds but gives no values; these are ours. runtime.js decides which ones this engine has.
  PointerDevice: {
    UnknownDevice: 1, Unknown: 1, Mouse: 2, TouchScreen: 4, TouchPad: 8, Puck: 16, Stylus: 32,
    Airbrush: 64, AllDevices: 127,
  },
  PointerHandler: { CanTakeOverFromAnything: 31, ApprovesTakeOverByAnything: 511, TakeOverForbidden: 0 },
  Drag: { None: 0, Automatic: 1, Internal: 2 },
  Application: { styleHints: { wheelScrollLines: 3, mouseDoubleClickInterval: 400 } },
  Flickable: {
    AutoFlickDirection: 0, HorizontalFlick: 1, VerticalFlick: 2, HorizontalAndVerticalFlick: 3,
    StopAtBounds: 0, DragOverBounds: 1, OvershootBounds: 2, DragAndOvershootBounds: 3,
  },
  Image: {
    Null: 0, Ready: 1, Loading: 2, Error: 3,
    Stretch: 0, PreserveAspectFit: 1, PreserveAspectCrop: 2, Tile: 3, Pad: 6,
  },
  AnimatedImage: alias('Image'),
  TextInput: {
    AlignLeft: 1, AlignRight: 2, AlignHCenter: 4, AlignTop: 32, AlignBottom: 64, AlignVCenter: 128,
    Normal: 0, Password: 2, NoEcho: 1, PasswordEchoOnEdit: 3, NativeRendering: 1,
  },
  TextEdit: alias('TextInput'),
  Text: {
    AlignLeft: 1, AlignRight: 2, AlignHCenter: 4, AlignTop: 32, AlignBottom: 64, AlignVCenter: 128,
    PlainText: 0, RichText: 1, AutoText: 2, StyledText: 3, MarkdownText: 4,
    NoWrap: 0, WordWrap: 1, WrapAnywhere: 2, Wrap: 3, WrapAtWordBoundaryOrAnywhere: 3,
    ElideNone: 0, ElideLeft: 1, ElideRight: 2, ElideMiddle: 3,
    ProportionalHeight: 0, FixedHeight: 1,
  },
  Font: { MixedCase: 0, AllUppercase: 1, AllLowercase: 2, SmallCaps: 3, Capitalize: 4 },
  Accessible: { Button: 43, CheckBox: 44 },
  Shape: { CurveRenderer: 1 },
  ShapePath: {
    SquareCap: 16, FlatCap: 0, RoundCap: 32,
    MiterJoin: 0, BevelJoin: 64, RoundJoin: 128,
    DashLine: 2, WindingFill: 1, OddEvenFill: 0,
  },
  Easing: {
    Linear: 0, InQuad: 1, OutQuad: 2, InOutQuad: 3, InCubic: 5, OutCubic: 6, InOutCubic: 7,
    OutQuart: 10, OutQuint: 14, OutSine: 18, OutExpo: 22, OutBack: 34,
  },
  Animation: { Infinite: -1 },
  Component: { Null: 0, Ready: 1, Loading: 2, Error: 3 },
  Loader: alias('Component'),
  TapHandler: { ReleaseWithinBounds: 1 },
};

// Names a component takes from its runtime (`r`, the variable the generated code keeps it in).
const FROM_RUNTIME = ['Qt', 'Quickshell', 'Hyprland'];
const FILE_VIEW_ERROR = { FileNotFound: 'ENOENT' };

const literal = (value) => {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  const parent = value[INHERITS];
  const entries = Object.entries(value).map(([key, item]) => `${key}:${literal(item)}`);
  return `{${(parent ? [`...${parent}`, ...entries] : entries).join(',')}}`;
};

/** The statements a generated component opens with, in the compact form it embeds. */
export function enumsSource() {
  const declared = Object.entries(ENUMS).map(([name, value]) =>
    `const ${name}=${value[ALIAS] ?? literal(value)}`);
  const runtime = [...FROM_RUNTIME.map((name) => `${name}=r.${name}`), `FileViewError=${literal(FILE_VIEW_ERROR)}`];
  return `${[...declared, `const ${runtime.join(',')}`].join(';')};`;
}
