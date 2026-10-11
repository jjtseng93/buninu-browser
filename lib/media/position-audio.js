/** Advance a PCM decoder to an exact sample cursor, never playing discarded PCM.
 * Reopened snapshots start at sample zero, including their pending first chunk.
 * The caller holds output requests until this transaction has completed.
 */
export async function advanceAudio(getSound, seconds, { reopen, needsMore, active = () => true }) {
  while (active()) {
    const sound = getSound();
    const { sampleRate, channels } = sound.decoder;
    const target = Math.max(0, Math.round(seconds * sampleRate));
    if (sound.position === target) return true;
    if (sound.position > target) {
      if (!await reopen()) return false;
      continue;
    }
    // This is also the first chunk of EVERY replacement decoder. Skipping it
    // used to leave the opening sound queued at exact chunk boundaries.
    let samples = sound.pending;
    sound.pending = null;
    if (!samples) {
      try { samples = sound.decoder.nextSamples(); }
      catch (error) {
        if (!needsMore(sound)) throw error;
      }
    }
    if (samples?.length) {
      const take = Math.min(target - sound.position, samples.length / channels);
      sound.position += take;
      if (take * channels < samples.length) sound.pending = samples.subarray(take * channels);
      continue;
    }
    if (!needsMore(sound)) return false;
    const pipe = sound.pipe;
    if (pipe.error) throw pipe.error;
    // Data may already have arrived while this snapshot was being decoded.
    if (pipe.generation === sound.openedGeneration) await pipe.waitFor(pipe.size + 1);
    if (!active()) return false;
    if (pipe.error) throw pipe.error;
    if (pipe.generation === sound.openedGeneration) return false;
    if (!await reopen()) return false;
  }
  return false;
}
