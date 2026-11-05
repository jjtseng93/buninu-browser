// Mutation observers and signaled slots share one notification microtask per
// renderer agent. Snapshot slots before callbacks, then dispatch them after all
// observers; callback-generated changes belong to the next notification.
const enqueueMicrotask = globalThis.queueMicrotask;
const pending = new Set();
const slots = new Map();
let queued = false;

function schedule() {
  if (queued) return;
  queued = true;
  enqueueMicrotask(() => {
    queued = false;
    const observers = [...pending].sort((left, right) => left.order - right.order);
    const signaled = [...slots.values()];
    pending.clear();
    slots.clear();
    for (const observer of observers) observer.deliver();
    for (const notify of signaled) notify();
  });
}

export function activateMutationObserver(observer) {
  pending.add(observer);
  schedule();
}

export function discardMutationObserver(observer) {
  pending.delete(observer);
}

export function signalMutationSlotChange(slot, notify) {
  if (!slots.has(slot)) slots.set(slot, notify);
  schedule();
}
