// A shader, a linked program, and a deferred draw can each keep a stage alive.
// Recompiling the shader must not destroy the executable already held by the
// other two. Keep the source lookup weak and dispose all effects on teardown.
export class ShaderStageCache {
  #stages = {vertex: new Map(), fragment: new Map()};
  #collected = new FinalizationRegistry(entry => this.#release(entry));

  #release(entry) {
    const stages = this.#stages[entry.stage];
    if (stages.get(entry.source) !== entry) return;
    stages.delete(entry.source);
    this.#collected.unregister(entry);
    entry.effect.delete();
  }

  get(stage, source, compile) {
    const stages = this.#stages[stage];
    const old = stages.get(source);
    const live = old?.ref.deref();
    if (live) return live;
    if (old) this.#release(old);

    const compiled = compile(source, stage);
    const entry = {stage, source, effect: compiled.effect, ref: new WeakRef(compiled)};
    stages.set(source, entry);
    this.#collected.register(compiled, entry, entry);
    return compiled;
  }

  dispose() {
    for (const stages of Object.values(this.#stages))
      for (const entry of stages.values()) this.#release(entry);
  }
}
