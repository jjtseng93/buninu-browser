/**
 * Promise rejections the renderer's JavaScript engine reports (HTML §8.1.5.7
 * "unhandled promise rejections"): the page realm turns them into
 * unhandledrejection and rejectionhandled events on its window. Bun reports
 * them after the microtask queue drains, where HTML notifies about rejected
 * promises.
 */
const listeners = new Set();

/**
 * @param {{ unhandled(reason: unknown, promise: Promise<unknown>): boolean, handled(promise: Promise<unknown>): void }} listener
 *   `unhandled` returns true when the page handled the rejection (its event was canceled).
 * @returns {() => void} removes the listener
 */
export function onPromiseRejection(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True when a page canceled the unhandledrejection event, so nothing is logged. */
export function notifyUnhandledRejection(reason, promise) {
  let handled = false;
  for (const listener of listeners) {
    if (listener.unhandled(reason, promise)) handled = true;
  }
  return handled;
}

export function notifyRejectionHandled(promise) {
  for (const listener of listeners) listener.handled(promise);
}
