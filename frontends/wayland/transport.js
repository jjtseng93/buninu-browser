// Platform selection must precede loading any native library.
const backend = await import(process.platform === 'win32' ? './transport-win32.js' : './transport-posix.js');
export const {libc,errno,Connection,connectUnix} = backend;
