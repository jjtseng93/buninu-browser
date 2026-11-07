import { homedir } from 'node:os';

// HOME/USERPROFILE and the account database are optional on minimal systems.
// A missing home must not turn an optional user feature into a startup error.
export function homeDirectory() {
  try { return homedir() || null; }
  catch { return null; }
}
