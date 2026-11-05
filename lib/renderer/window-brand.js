// Only engine-created globals and Window facades carry this Web IDL brand.
// Author proxies around them remain ordinary objects for interface conversion.
const windows = new WeakSet();

export function registerWindow(value) {
  windows.add(value);
  return value;
}

export function isWindow(value) {
  return windows.has(value);
}
