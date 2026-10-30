(function (root, factory) {
  const api = factory(); if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KaiPocket = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  // Incremental WSOLA: retain the overlap and global resampling phase between
  // native chunks. No per-chunk fades, speed jumps, or duplicated syllables.
  class Tone {
    constructor(rate = 24000, tone = "cute", pitch = 9) {
      this.rate = rate; this.tone = tone; this.ratio = tone === "cute" ? 2 ** (Math.max(5, Math.min(12, Number.isFinite(pitch) ? pitch : 9)) / 12) : tone === "kai" ? .9 : 1;
      this.tempo = tone === "cute" ? 1.08 : this.ratio; this.stretch = this.ratio / this.tempo;
      this.hop = Math.round(rate * .02); this.frame = this.hop * 2; this.search = Math.round(rate * .008);
      this.input = new Float32Array(rate); this.output = new Float32Array(rate * 2);
      this.count = 0; this.outAt = 0; this.read = 0; this.done = false;
    }
    grow(key, needed) { if (needed > this[key].length) { const a = new Float32Array(Math.max(needed, this[key].length * 2)); a.set(this[key]); this[key] = a; } }
    push(samples, final = false) {
      if (this.done) throw new Error("Voice stream has ended.");
      if (this.count + samples.length > this.rate * 120) throw new Error("Pocket audio is too long.");
      this.grow("input", this.count + samples.length + this.frame); this.input.set(samples, this.count); this.count += samples.length;
      let stable = this.count;
      if (this.tone === "cute") {
        const end = Math.ceil(this.count * this.stretch);
        this.grow("output", end + this.frame);
        if (!this.outAt && (this.count >= this.frame || final)) { this.output.set(this.input.subarray(0, this.frame)); this.outAt = this.hop; }
        while (this.outAt && this.outAt < end) {
          const expected = Math.round(this.outAt / this.stretch);
          if (!final && expected + this.search + this.frame > this.count) break;
          let best = Math.min(this.count - 1, expected), score = -Infinity;
          for (let c = Math.max(0, expected - this.search); c <= Math.min(this.count - this.frame, expected + this.search); c += 4) {
            let dot = 0, energy = 0;
            for (let j = 0; j < this.hop; j += 4) { const v = this.input[c + j]; dot += this.output[this.outAt + j] * v; energy += v * v; }
            const similarity = dot / Math.sqrt(energy + 1e-9);
            if (similarity > score) { best = c; score = similarity; }
          }
          for (let j = 0; j < this.frame; j++) {
            const blend = j < this.hop ? .5 - .5 * Math.cos(Math.PI * j / this.hop) : 1;
            this.output[this.outAt + j] = this.output[this.outAt + j] * (1 - blend) + (this.input[best + j] || 0) * blend;
          }
          this.outAt += this.hop;
        }
        stable = final ? end : Math.max(0, this.outAt - 1);
      }
      const source = this.tone === "cute" ? this.output : this.input;
      const length = final ? Math.ceil(this.count / this.tempo) : Math.max(this.read, Math.floor((stable - 1) / this.ratio));
      const result = new Float32Array(Math.max(0, length - this.read));
      for (let i = this.read; i < length; i++) {
        const pos = Math.min(stable - 1, i * this.ratio), low = Math.max(0, Math.floor(pos)), high = Math.max(0, Math.min(stable - 1, low + 1));
        let v = source[low] + (source[high] - source[low]) * (pos - low);
        if (this.tone === "kai") v *= .9 + .1 * Math.cos(2 * Math.PI * 55 * i / this.rate);
        result[i - this.read] = Math.max(-1, Math.min(1, v));
      }
      this.read = length; this.done = final; return result;
    }
  }
  // Pocket inference is bursty under CPU load. Once the scheduled audio runs
  // dry, playing every newly-arrived native chunk immediately turns one pause
  // into rapid stop/start speech. Keep a small jitter reservoir, and only
  // resume after an underrun when that reservoir is healthy again. If the
  // opening production rate cannot outrun playback, retain the complete
  // sentence instead of beginning a stream that is guaranteed to break up.
  class PlaybackBuffer {
    constructor(rate = 24000, { startMs = 750, resumeMs = 650, blockMs = 80, speedMargin = 1.15 } = {}) {
      this.rate = rate; this.startSamples = Math.round(rate * startMs / 1000);
      this.resumeSamples = Math.round(rate * resumeMs / 1000); this.blockSamples = Math.round(rate * blockMs / 1000);
      this.speedMargin = speedMargin; this.parts = []; this.samples = 0; this.started = false;
      this.waiting = false; this.slow = false; this.pauses = 0; this.firstAt = null;
    }
    append(samples) {
      if (!samples.length) return;
      this.parts.push(samples); this.samples += samples.length;
    }
    drain() {
      if (!this.samples) return null;
      const joined = new Float32Array(this.samples); let at = 0;
      for (const part of this.parts) { joined.set(part, at); at += part.length; }
      this.parts = []; this.samples = 0; return joined;
    }
    push(samples, { ended = false, nowMs = performance.now(), audioNow = 0, next = 0 } = {}) {
      if (samples?.length) { if (this.firstAt === null) this.firstAt = nowMs; this.append(samples); }
      if (!this.started) {
        if (!ended && this.samples < this.startSamples) return null;
        const elapsed = Math.max(1, nowMs - (this.firstAt ?? nowMs));
        const producedMs = this.samples / this.rate * 1000;
        if (!ended && producedMs < elapsed * this.speedMargin) { this.slow = true; return null; }
        if (this.slow && !ended) return null;
        this.started = true; return this.drain();
      }
      if (next && next < audioNow) {
        if (!this.waiting) { this.waiting = true; this.pauses++; }
        if (!ended && this.samples < this.resumeSamples) return null;
      }
      if (!ended && !this.waiting && this.samples < this.blockSamples) return null;
      this.waiting = false; return this.drain();
    }
  }
  async function prepare(bridge, request, signal) {
    signal.throwIfAborted();
    const id = crypto.randomUUID(), chunks = [];
    let notify = null, complete = false, failure = null, firstResolve, firstReject, size = 0;
    const first = new Promise((resolve, reject) => { firstResolve = resolve; firstReject = reject; });
    const value = { text: request.text, pocket: true, tone: request.tone, pitch: request.pitch, start: performance.now(),
      subscribe(fn) { notify = fn; while (chunks.length) fn(chunks.shift()); if (complete) fn({ done: true, error: failure }); return () => { notify = null; }; } };
    const remove = bridge.onEvent(({ type, value: chunk }) => {
      if (type !== "pocket-audio" || chunk.id !== id || signal.aborted || complete) return;
      if ((size += chunk.samples.length) > 24000 * 120) { bridge.cancelPocketSpeech(); return; }
      if (notify) notify(chunk); else chunks.push(chunk);
      firstResolve(value);
    });
    const abort = () => { bridge.cancelPocketSpeech(); finish(new DOMException("Stopped", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    function finish(error) {
      if (complete) return; complete = true; failure = error; remove(); signal.removeEventListener("abort", abort);
      if (error) firstReject(error); else if (!size) { failure = new Error("Pocket returned no audio."); firstReject(failure); }
      notify?.({ done: true, error: failure });
    }
    value.finished = bridge.pocketSpeech({ id, voice: request.voice, text: request.text }).then(stats => { value.stats = stats; finish(); if (failure) throw failure; }, error => { finish(error); throw error; });
    // First audio can precede completion or fail before Queue sees this value.
    value.finished.catch(() => {});
    return first;
  }
  function play(value, { clock, scope, onStart = () => {}, onMetric, contextFactory = () => new AudioContext({ sampleRate: 24000 }) }) {
    const owned = !clock;
    if (!clock) {
      const Playback = root.KaiPlayback || (typeof require === "function" ? require("./mascot-playback") : null);
      clock = new Playback.Clock({ contextFactory });
    }
    const tone = new Tone(24000, value.tone, value.pitch);
    const jitter = new PlaybackBuffer(24000);
    let closed = false, ended = false, unsubscribe, started = false;
    const scheduled = []; let resolve, reject;
    const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
    function close(error) {
      if (closed) return; closed = true; unsubscribe?.();
      if (owned) clock.cancel(scope);
      error ? reject(error) : resolve();
    }
    const check = () => {
      if (!closed && ended && !jitter.samples) Promise.all(scheduled.map(item => item.finished)).then(() => {
        onMetric?.({ ...value.stats, firstPlaybackMs: value.firstPlaybackMs, pauses: jitter.pauses, ...clock.metrics() }); close();
      }, close);
    };
    function schedule(samples, final = false) {
      const context = clock.context, audioNow = context?.currentTime || 0, next = clock.cursor || 0;
      samples = jitter.push(samples, { ended: final, nowMs: performance.now(), audioNow, next });
      if (!samples) return;
      if (!samples.length) return;
      const item = clock.schedule(samples, 24000, { scope, text: value.text }); scheduled.push(item);
      if (value.firstPlaybackMs == null) value.firstPlaybackMs = performance.now() - value.start + Math.max(0, item.start - (clock.context?.currentTime || 0)) * 1000;
      if (!started) { started = true; item.started.then(result => { if (!result?.cancelled) onStart(); }); }
    }
    unsubscribe = value.subscribe(chunk => {
      if (closed) return;
      try {
        if (chunk.error) return close(chunk.error);
        if (chunk.done) { ended = true; schedule(tone.push(new Float32Array(0), true), true); check(); }
        else schedule(tone.push(chunk.samples));
      } catch (error) { close(error); }
    });
    return { finished, cancel: () => close(), hold: value => clock.hold(value) };
  }
  return { Tone, PlaybackBuffer, prepare, play };
});
