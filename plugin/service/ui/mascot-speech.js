(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiSpeech = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  function splitSentence(text) {
    let rest = text.trim(); const chunks = [];
    while (rest.length) {
      let end = Math.min(240, rest.length);
      if (end < rest.length) {
        const clause = [...rest.slice(0, end).matchAll(/[,;:]\s/g)].at(-1);
        const space = rest.lastIndexOf(" ", end);
        if (clause && clause.index >= 100) end = clause.index + 1;
        else if (space > 0) end = space;
      }
      chunks.push(rest.slice(0, end)); rest = rest.slice(end).trimStart();
    }
    return chunks;
  }
  function pcm(buffer) {
    const view = new DataView(buffer);
    const tag = (at, value) => [...value].every((c, i) => view.getUint8(at + i) === c.charCodeAt(0));
    if (buffer.byteLength <= 44 || !tag(0, "RIFF") || !tag(8, "WAVE") || !tag(12, "fmt ") || !tag(36, "data") ||
      view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
      view.getUint16(34, true) !== 16 || view.getUint32(40, true) !== buffer.byteLength - 44 || buffer.byteLength % 2) {
      throw new Error("KAI received unreadable voice audio. Please try again.");
    }
    const rate = view.getUint32(24, true);
    if (rate < 8000 || rate > 48000) throw new Error("KAI received an unsupported voice sample rate.");
    return { view, rate, count: (buffer.byteLength - 44) / 2 };
  }
  function joinWavs(buffers) {
    if (!buffers.length) throw new Error("KAI's voice returned no audio.");
    let parts = buffers.map(pcm);
    const rate = Math.max(...parts.map(p => p.rate));
    // An English introduction and a Korean answer can use different installed
    // voices/rates. Upsample to the highest rate before joining; retain duration
    // and pitch, rather than treating a language change as corrupt audio.
    buffers = buffers.map((buffer, index) => {
      const part = parts[index]; if (part.rate === rate) return buffer;
      const count = Math.ceil(part.count * rate / part.rate), result = new ArrayBuffer(44 + count * 2), view = new DataView(result);
      new Uint8Array(result, 0, 44).set(new Uint8Array(buffer, 0, 44));
      view.setUint32(4, result.byteLength - 8, true); view.setUint32(40, count * 2, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
      for (let i = 0; i < count; i++) {
        const position = Math.min(part.count - 1, i * part.rate / rate), low = Math.floor(position), high = Math.min(part.count - 1, low + 1);
        const a = part.view.getInt16(44 + low * 2, true), b = part.view.getInt16(44 + high * 2, true);
        view.setInt16(44 + i * 2, Math.round(a + (b - a) * (position - low)), true);
      }
      return result;
    });
    parts = buffers.map(pcm);
    // Keep natural opening/closing silence. Remove excess internal chunk
    // padding so the inference limit cannot create a long mid-sentence pause.
    const ranges = parts.map((part, index) => {
      let start = 0, end = part.count;
      if (index) {
        while (start < end && Math.abs(part.view.getInt16(44 + start * 2, true)) < 32) start++;
        start = Math.max(0, start - Math.round(rate * .02));
      }
      if (index < parts.length - 1) {
        while (end > start && Math.abs(part.view.getInt16(44 + (end - 1) * 2, true)) < 32) end--;
        end = Math.min(part.count, end + Math.round(rate * .06));
      }
      return { start, end };
    });
    const count = ranges.reduce((n, r) => n + r.end - r.start, 0);
    const result = new ArrayBuffer(44 + count * 2), bytes = new Uint8Array(result), view = new DataView(result);
    bytes.set(new Uint8Array(buffers[0], 0, 44)); let at = 44;
    ranges.forEach((range, i) => {
      const data = new Uint8Array(buffers[i], 44 + range.start * 2, (range.end - range.start) * 2);
      bytes.set(data, at); at += data.length;
    });
    view.setUint32(4, result.byteLength - 8, true); view.setUint32(40, result.byteLength - 44, true);
    return result;
  }
  function robotTone(buffer) {
    const { view, rate, count } = pcm(buffer), ratio = .9;
    // About 1.8 semitones deeper, with a light 55 Hz electronic texture.
    // Resampling slows speech by 11%; no extra model or inference is needed.
    const length = Math.ceil(count / ratio), result = new ArrayBuffer(44 + length * 2), out = new DataView(result);
    new Uint8Array(result, 0, 44).set(new Uint8Array(buffer, 0, 44));
    out.setUint32(4, result.byteLength - 8, true); out.setUint32(40, result.byteLength - 44, true);
    for (let i = 0; i < length; i++) {
      const pos = Math.min(count - 1, i * ratio), lo = Math.floor(pos), hi = Math.min(count - 1, lo + 1);
      const a = view.getInt16(44 + lo * 2, true), b = view.getInt16(44 + hi * 2, true);
      const texture = .9 + .1 * Math.cos(2 * Math.PI * 55 * i / rate);
      const fade = Math.min(1, i / (rate * .005), (length - 1 - i) / (rate * .005));
      out.setInt16(44 + i * 2, Math.round((a + (b - a) * (pos - lo)) * texture * fade), true);
    }
    return result;
  }
  function cuteTone(buffer, semitones = 9) {
    const { view, rate, count } = pcm(buffer);
    if (!Number.isFinite(semitones)) semitones = 9;
    const ratio = 2 ** (Math.max(5, Math.min(12, semitones)) / 12), tempo = 1.08;
    const input = Float32Array.from({ length: count }, (_, i) => view.getInt16(44 + i * 2, true));
    // Waveform-similarity overlap/add lengthens the audio before resampling.
    // Raising pitch alone would rush every word by 68%. This keeps the
    // character bright and small while speech is only 8% more lively.
    // No second model, network call, or native audio dependency is involved.
    const stretch = ratio / tempo, hop = Math.round(rate * .02), frame = hop * 2;
    const stretchedCount = Math.ceil(count * stretch), samples = new Float32Array(stretchedCount + frame);
    samples.set(input.subarray(0, Math.min(frame, count)));
    const search = Math.round(rate * .008), stride = 4;
    for (let outAt = hop; outAt < stretchedCount; outAt += hop) {
      const expected = Math.round(outAt / stretch);
      const from = Math.max(0, expected - search), to = Math.min(count - frame, expected + search);
      let best = Math.min(count - 1, expected), score = -Infinity;
      for (let candidate = from; candidate <= to; candidate += stride) {
        let dot = 0, energy = 0;
        for (let j = 0; j < hop; j += stride) {
          const value = input[candidate + j]; dot += samples[outAt + j] * value; energy += value * value;
        }
        const similarity = dot / Math.sqrt(energy + 1);
        if (similarity > score) { score = similarity; best = candidate; }
      }
      for (let j = 0; j < frame; j++) {
        const value = input[best + j] || 0;
        const blend = j < hop ? .5 - .5 * Math.cos(Math.PI * j / hop) : 1;
        samples[outAt + j] = samples[outAt + j] * (1 - blend) + value * blend;
      }
    }
    const length = Math.ceil(count / tempo), result = new ArrayBuffer(44 + length * 2), out = new DataView(result);
    new Uint8Array(result, 0, 44).set(new Uint8Array(buffer, 0, 44));
    out.setUint32(4, result.byteLength - 8, true); out.setUint32(40, result.byteLength - 44, true);
    for (let i = 0; i < length; i++) {
      const pos = Math.min(stretchedCount - 1, i * ratio), lo = Math.floor(pos), hi = Math.min(stretchedCount - 1, lo + 1);
      const sample = samples[lo] + (samples[hi] - samples[lo]) * (pos - lo);
      const fade = Math.min(1, i / (rate * .005), (length - 1 - i) / (rate * .005));
      out.setInt16(44 + i * 2, Math.round(Math.max(-32768, Math.min(32767, sample * fade))), true);
    }
    return result;
  }
  function characterTone(buffer, tone, pitch) {
    return tone === "cute" ? cuteTone(buffer, pitch) : tone === "kai" ? robotTone(buffer) : buffer;
  }
  async function prepareSentence(text, { synthesize, signal, tone = "kai", pitch = 9 }) {
    if (!text.trim() || text.length > 1200) throw new Error("Speak one sentence at a time.");
    const buffers = [];
    for (const chunk of splitSentence(text)) {
      signal?.throwIfAborted();
      buffers.push(await synthesize(chunk, signal));
      signal?.throwIfAborted();
    }
    const joined = joinWavs(buffers);
    return characterTone(joined, tone, pitch);
  }
  // Keep one inference active and at most two native playback items scheduled
  // on the shared clock. Epochs make Stop discard every late result.
  class Queue {
    constructor({ prepare, play, cancel, holdPlayback = () => {}, onState, onError, buffer = 1, bufferWaitMs = 1800,
      merge = values => values[0], playAhead = false }) {
      Object.assign(this, { prepare, play, cancel, holdPlayback, onState, onError, buffer, bufferWaitMs, merge, playAhead });
      this.epoch = 0; this.scope = null; this.tasks = []; this.ready = []; this.preparing = false; this.playing = false; this.plays = new Set();
    }
    // A scope is KAI's authoritative turn id. The queue still uses a private
    // epoch to cancel in-flight synthesis, but it will never accept text, audio
    // or completion from a different turn. Preview speech may use any unique
    // non-turn scope; legacy callers can leave it null.
    begin(scope) {
      if (scope == null) throw new Error("Speech needs a turn scope.");
      if (this.scope !== null || this.tasks.length || this.ready.length || this.preparing || this.playing) this.stop();
      this.scope = scope; this.state(); return scope;
    }
    enqueue(phrases, scope = this.scope) {
      if (scope !== this.scope) return false;
      this.tasks.push(...phrases.filter(Boolean).map(value => ({ value, scope })));
      this.pump(); return true;
    }
    end(scope = this.scope) { if (scope !== this.scope) return false; this.ended = true; this.pump(); return true; }
    state(scope = this.scope) {
      const state = this.playing ? "speaking" : this.preparing || this.tasks.length || this.ready.length ? "preparing" : "idle";
      this.onState(state, scope, { ended: !!this.ended, held: !!this.held });
    }
    hold(value) {
      this.held = value; this.holdPlayback(value); this.pump();
    }
    pump() {
      this.state();
      const epoch = this.epoch, scope = this.scope;
      const target = typeof this.buffer === "function" ? this.buffer() : this.buffer;
      const complete = target === "complete";
      // Whole-reply mode stays bounded for unusually long answers. Audio up
      // to 24 MiB / 128 sentences is prepared as a continuous section.
      const full = this.ready.length >= (complete ? 128 : 2) || (complete && this.ready.reduce((n, item) => n + (item.value?.wav?.byteLength || 0), 0) >= 24 * 1024 * 1024);
      if (!this.preparing && this.tasks.length && !full) {
        this.preparing = true;
        const abort = this.abort = new AbortController(), task = this.tasks.shift();
        Promise.resolve().then(() => epoch === this.epoch && task.scope === this.scope ? this.prepare(task.value, abort.signal, task.scope) : null).then(async value => {
          if (epoch === this.epoch && task.scope === this.scope) { this.ready.push({ value, scope: task.scope }); this.pump(); }
          // A streaming voice becomes playable before inference finishes. Keep
          // the single preparation slot until its remaining chunks arrive.
          await value?.finished;
        }).catch(error => { if (epoch === this.epoch) { const failedScope = this.scope; this.stop(failedScope); this.onError(error, failedScope); } })
          .finally(() => { if (epoch === this.epoch) { this.preparing = false; this.abort = null; this.pump(); } });
      }
      const drained = !this.preparing && !this.tasks.length;
      if (!this.started && this.ready.length && drained && !this.ended && !this.bufferTimer && !this.bufferExpired && !complete && target > 1) {
        this.bufferTimer = setTimeout(() => {
          if (epoch !== this.epoch) return;
          this.bufferTimer = null; this.bufferExpired = true; this.pump();
        }, this.bufferWaitMs);
      }
      const buffered = complete ? (full || (drained && this.ended)) : this.started || this.ready.length >= target || (drained && (this.ended || this.bufferExpired));
      const nextValue = this.ready[0]?.value;
      const ahead = typeof this.playAhead === "function" ? this.playAhead(nextValue) : this.playAhead;
      if (!this.held && (!this.playing || (ahead && this.plays.size < 2)) && this.ready.length && buffered) {
        clearTimeout(this.bufferTimer); this.bufferTimer = null;
        this.started = true;
        const items = complete ? this.ready.splice(0) : [this.ready.shift()];
        const values = items.map(item => item.value);
        const token = {}; this.plays.add(token); this.playing = true;
        Promise.resolve().then(() => epoch === this.epoch && scope === this.scope ? this.play(complete ? this.merge(values) : values[0], scope) : null).catch(error => {
          if (epoch === this.epoch) { const failedScope = this.scope; this.stop(failedScope); this.onError(error, failedScope); }
        }).finally(() => { if (epoch === this.epoch) { this.plays.delete(token); this.playing = this.plays.size > 0; this.pump(); } });
        this.pump(); // Fill the bounded look-ahead buffer.
      }
      this.state();
    }
    stop(scope) {
      if (scope !== undefined && scope !== this.scope) return false;
      const stoppedScope = this.scope;
      this.epoch++; this.tasks = []; this.ready = []; this.preparing = false; this.playing = false; this.plays.clear();
      clearTimeout(this.bufferTimer); this.bufferTimer = null; this.bufferExpired = false; this.started = false; this.ended = false;
      this.abort?.abort(); this.abort = null; this.held = false; this.cancel(stoppedScope); this.state(stoppedScope); this.scope = null;
      return true;
    }
  }
  return { Queue, splitSentence, joinWavs, robotTone, cuteTone, characterTone, prepareSentence };
});
