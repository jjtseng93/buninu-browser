// Native fs descriptors on POSIX; named-mapping resource IDs on Windows.
import * as fs from 'node:fs';
const mapping = process.platform === 'win32' ? await import('./win32-resources.js') : null;
export const readSync = mapping?.readResource ?? fs.readSync;
export const writeSync = mapping?.writeResource ?? fs.writeSync;
export const closeSync = mapping?.closeResource ?? fs.closeSync;
