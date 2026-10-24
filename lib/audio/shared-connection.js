// Keep one connection while audio-owning renderer processes are alive. A
// completed stream does not release its owner: the page may play again.
export class SharedAudioConnection {
  #connect;
  #pending = null;
  #owners = new Set();

  constructor(connect) { this.#connect = connect; }

  acquire(owner) {
    this.#owners.add(owner);
    if (!this.#pending) {
      const pending = Promise.resolve().then(this.#connect).catch(error => {
        if (this.#pending === pending) this.#pending = null;
        throw error;
      });
      this.#pending = pending;
    }
    return this.#pending;
  }

  release(owner) {
    this.#owners.delete(owner);
    if (this.#owners.size || !this.#pending) return;
    const pending = this.#pending;
    this.#pending = null;
    // Also close connections whose authentication is still in flight. A new
    // owner gets a separate connection and cannot inherit this closing one.
    void pending.then(client => client.close()).catch(() => {});
  }
}
