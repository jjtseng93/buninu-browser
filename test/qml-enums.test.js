import { test, expect } from 'bun:test';
import { ENUMS, enumsSource } from '../lib/qml/enums.js';

// The enumerations are data; this is what each generated component embeds. Run it the way a
// component does (with a runtime to take Qt and friends from) and look at what it defines.
const defined = () =>
  new Function('r', `${enumsSource()}return {${[...Object.keys(ENUMS), 'Qt', 'Quickshell', 'Hyprland', 'FileViewError']}};`)(
    { Qt: 'qt', Quickshell: 'qs', Hyprland: 'hypr' });

test('every table becomes a local of the component, and the runtime supplies its own names', () => {
  const d = defined();
  expect(Object.keys(d)).toEqual([...Object.keys(ENUMS), 'Qt', 'Quickshell', 'Hyprland', 'FileViewError']);
  expect([d.Qt, d.Quickshell, d.Hyprland]).toEqual(['qt', 'qs', 'hypr']);
  expect(d.FileViewError).toEqual({ FileNotFound: 'ENOENT' });
  expect(d.Text.AlignHCenter).toBe(4);
  expect(d.Application.styleHints.mouseDoubleClickInterval).toBe(400);
  expect(d.MediaPlayer.Infinite).toBe(-1);
});

test('inherited and aliased tables point where they say', () => {
  const d = defined();
  expect(d.GridView).toEqual({ ...d.ListView, FlowLeftToRight: 0, FlowTopToBottom: 1 });
  expect(d.AnimatedImage).toBe(d.Image);
  expect(d.TextEdit).toBe(d.TextInput);
  expect(d.Loader).toBe(d.Component);
});

test('PointerDevice flags are distinct and AllDevices holds every one of them', () => {
  const { AllDevices, Unknown, UnknownDevice, ...kinds } = defined().PointerDevice;
  expect(Unknown).toBe(UnknownDevice);
  const flags = Object.values(kinds);
  expect(new Set([UnknownDevice, ...flags]).size).toBe(flags.length + 1);
  for (const flag of [UnknownDevice, ...flags]) {
    expect(Number.isInteger(Math.log2(flag))).toBe(true);
    expect(AllDevices & flag).toBe(flag);
  }
  expect(AllDevices).toBe([UnknownDevice, ...flags].reduce((all, flag) => all | flag, 0));
});
