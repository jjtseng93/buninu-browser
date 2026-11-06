// Iterable resource indexes must not keep detached DOM elements alive.
// Resource disposal is owned separately by the renderer, not by this index.
export class WeakElementSet {
  #refs = new Set();
  #index = new WeakMap();
  #collected = new FinalizationRegistry(ref => this.#refs.delete(ref));
  constructor(values = []) { for (const value of values) this.add(value); }
  add(value) {
    if (!this.#index.has(value)) {
      const ref = new WeakRef(value);
      this.#index.set(value, ref);
      this.#refs.add(ref);
      this.#collected.register(value, ref, ref);
    }
    return this;
  }
  has(value) { return this.#index.has(value); }
  delete(value) {
    const ref = this.#index.get(value);
    if (!ref) return false;
    this.#index.delete(value);
    this.#collected.unregister(ref);
    return this.#refs.delete(ref);
  }
  clear() {
    for (const ref of this.#refs) this.#collected.unregister(ref);
    this.#refs.clear();
    this.#index = new WeakMap();
  }
  *[Symbol.iterator]() {
    for (const ref of this.#refs) {
      const value = ref.deref();
      if (value) yield value;
      else this.#refs.delete(ref);
    }
  }
}
