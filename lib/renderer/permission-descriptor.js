// PermissionDescriptor's required enum member, including the names supported
// by Chromium's permissions/permission_descriptor.idl. Validity of a name is
// separate from the permission's current state or hardware availability.
const names = new Set([
  'geolocation', 'notifications', 'push', 'midi', 'camera', 'microphone',
  'background-fetch', 'background-sync', 'persistent-storage',
  'ambient-light-sensor', 'accelerometer', 'gyroscope', 'magnetometer',
  'screen-wake-lock', 'nfc', 'display-capture', 'clipboard-read',
  'clipboard-write', 'payment-handler', 'idle-detection',
  'periodic-background-sync', 'system-wake-lock', 'storage-access',
  'window-management', 'local-fonts', 'top-level-storage-access',
  'captured-surface-control', 'speaker-selection', 'keyboard-lock',
  'pointer-lock', 'fullscreen', 'web-app-installation',
  'local-network-access', 'local-network', 'loopback-network',
  'geolocation-approximate',
]);

export function permissionName(descriptor) {
  if (descriptor === null || !['object', 'function'].includes(typeof descriptor)) {
    throw new TypeError('PermissionDescriptor must be a dictionary.');
  }
  // Dictionary getters and enum conversion are observable: read only once
  // and use a string hint. Web IDL DOMString conversion rejects symbols.
  const value = descriptor.name;
  if (value === undefined) throw new TypeError('PermissionDescriptor.name is required.');
  if (typeof value === 'symbol') throw new TypeError('PermissionDescriptor.name cannot be a symbol.');
  const name = String(value);
  if (!names.has(name)) throw new TypeError(`Invalid PermissionName: ${name}`);
  return name;
}
