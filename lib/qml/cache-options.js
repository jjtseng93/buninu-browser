/** Cache is opt-in and local-QML only. Keep frontend argument forwarding intact. */
export function configureQmlCache(args, env = process.env) {
  for (const arg of args) {
    if (arg !== '--cache' && !arg.startsWith('--cache=')) continue;
    const mode = arg === '--cache' ? 'js' : arg.slice(8);
    if (!['js', 'bytecode'].includes(mode)) throw Error('--cache accepts js or bytecode');
    env.BUNINU_QML_CACHE = mode;
    env.BUN_JSC_verboseDiskCache = '1';
  }
}
