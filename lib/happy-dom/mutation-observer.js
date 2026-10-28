import * as PropertySymbol from '../../vendor/happy-dom/packages/happy-dom/src/PropertySymbol.ts';

// One notification microtask for this renderer agent, with one ordered record
// queue per observer. Target registrations must not schedule their own delivery.
const enqueueMicrotask = globalThis.queueMicrotask;
const pending = new Set();
let queued = false;
let creationIndex = 0;

function activate(observer) {
  pending.add(observer);
  if (queued) return;
  queued = true;
  enqueueMicrotask(() => {
    queued = false;
    const observers = [...pending].sort((left, right) => left.order - right.order);
    pending.clear();
    for (const observer of observers) observer.deliver();
  });
}

function optionsOf(window, input = {}) {
  const attributes = input.attributes === undefined
    ? input.attributeOldValue !== undefined || input.attributeFilter !== undefined
    : Boolean(input.attributes);
  const characterData = input.characterData === undefined
    ? input.characterDataOldValue !== undefined : Boolean(input.characterData);
  const options = {
    childList: Boolean(input.childList), attributes, characterData,
    subtree: Boolean(input.subtree),
    attributeOldValue: Boolean(input.attributeOldValue),
    characterDataOldValue: Boolean(input.characterDataOldValue),
    attributeFilter: input.attributeFilter === undefined ? null : Array.from(input.attributeFilter, String),
  };
  if ((!options.childList && !attributes && !characterData) ||
      (!attributes && (options.attributeOldValue || options.attributeFilter !== null)) ||
      (!characterData && options.characterDataOldValue)) {
    throw new window.TypeError('Invalid MutationObserver options');
  }
  return options;
}

export function installMutationObservers(window) {
  window.MutationObserver = class MutationObserver {
    #callback;
    #registrations = new Map();
    #records = [];
    #seen = new WeakMap();
    #destroyed = false;
    #delivery;

    constructor(callback) {
      if (typeof callback !== 'function') throw new window.TypeError('MutationObserver callback must be a function');
      this.#callback = callback;
      this.#delivery = { order: creationIndex++, deliver: () => this.#deliver() };
    }

    observe(target, input) {
      if (this.#destroyed || window.closed) return;
      if (!target || typeof target[PropertySymbol.observeMutations] !== 'function') {
        throw new window.TypeError('MutationObserver.observe requires a Node');
      }
      const options = optionsOf(window, input);
      const previous = this.#registrations.get(target);
      if (previous) this.#remove(previous);
      const registration = { target, options, transientRoots: new Set(), callback: null, listener: null };
      registration.callback = (record) => this.#report(registration, record);
      registration.listener = {
        // Removals establish temporary registrations even if childList records
        // were not requested. These survive until this observer is notified.
        options: { ...options, childList: options.childList || options.subtree },
        callback: new WeakRef(registration.callback),
      };
      this.#registrations.set(target, registration);
      target[PropertySymbol.observeMutations](registration.listener);
      if (!window[PropertySymbol.mutationObservers].includes(this)) {
        window[PropertySymbol.mutationObservers].push(this);
      }
    }

    #clearTransient(registration) {
      for (const root of registration.transientRoots) {
        root[PropertySymbol.unobserveMutations](registration.listener);
      }
      registration.transientRoots.clear();
    }

    #remove(registration) {
      this.#clearTransient(registration);
      registration.target[PropertySymbol.unobserveMutations](registration.listener);
    }

    #report(registration, record) {
      const { options } = registration;
      if (options.subtree && record.type === 'childList') {
        for (const root of record.removedNodes) {
          if (!registration.transientRoots.has(root)) {
            registration.transientRoots.add(root);
            root[PropertySymbol.observeMutations](registration.listener);
          }
        }
        if (record.removedNodes.length) activate(this.#delivery);
      }
      if (record.type === 'childList' && !options.childList) return;
      const wantsOld = record.type === 'attributes' ? options.attributeOldValue
        : record.type === 'characterData' && options.characterDataOldValue;
      const existing = this.#seen.get(record);
      if (existing) {
        if (wantsOld) existing.oldValue = record.oldValue;
        return;
      }
      const copy = Object.assign(Object.create(Object.getPrototypeOf(record)), record, {
        oldValue: wantsOld ? record.oldValue : null,
      });
      this.#seen.set(record, copy);
      this.#records.push(copy);
      activate(this.#delivery);
    }

    #deliver() {
      const records = this.takeRecords();
      for (const registration of this.#registrations.values()) this.#clearTransient(registration);
      if (!records.length || this.#destroyed || window.closed) return;
      try {
        this.#callback.call(this, records, this);
      } catch (error) {
        window[PropertySymbol.dispatchError](error);
      }
    }

    takeRecords() {
      const records = this.#records;
      this.#records = [];
      this.#seen = new WeakMap();
      return records;
    }

    disconnect() {
      for (const registration of this.#registrations.values()) this.#remove(registration);
      this.#registrations.clear();
      this.takeRecords();
      // Window destruction iterates this array. Do not splice it during that
      // iteration, otherwise the next observer would survive teardown.
      if (!window.closed) {
        const observers = window[PropertySymbol.mutationObservers];
        const index = observers.indexOf(this);
        if (index >= 0) observers.splice(index, 1);
      }
    }

    [PropertySymbol.destroy]() {
      this.#destroyed = true;
      this.disconnect();
      pending.delete(this.#delivery);
    }
  };
}
