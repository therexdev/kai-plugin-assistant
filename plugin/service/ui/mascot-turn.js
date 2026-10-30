(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiTurn = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // One user-facing choice controls the acoustic pause, semantic confidence
  // and maximum mid-thought hold. Raw values remain bounded and testable.
  const POLICIES = Object.freeze({
    quick: Object.freeze({ silenceMs: 500, threshold: .35, holdMs: 2500 }),
    natural: Object.freeze({ silenceMs: 900, threshold: .5, holdMs: 4000 }),
    patient: Object.freeze({ silenceMs: 1400, threshold: .65, holdMs: 6000 }),
  });
  const MAX_AUDIO_SECONDS = 8;
  const TRAILING = new Set(["to", "the", "a", "an", "and", "but", "so", "or", "of", "for", "with", "my", "your", "is", "are", "it", "that", "this", "on", "at", "in", "because", "if", "when", "then", "like", "about", "into", "um", "uh"]);
  const clock = () => typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

  function policy(name) { return POLICIES[name] || POLICIES.natural; }

  /** Retain only the newest eight seconds from this turn, as Smart-Turn was trained to consume. */
  function appendAudio(previous, current, sampleRate) {
    const rate = Number(sampleRate) || 16000;
    const source = current instanceof Float32Array ? current : Float32Array.from(current || []);
    const prior = previous?.sampleRate === rate && previous.samples instanceof Float32Array ? previous.samples : new Float32Array();
    const maximum = Math.max(1, Math.round(rate * MAX_AUDIO_SECONDS));
    const count = Math.min(maximum, prior.length + source.length);
    const output = new Float32Array(count);
    const currentCount = Math.min(source.length, count);
    const priorCount = count - currentCount;
    if (priorCount) output.set(prior.subarray(prior.length - priorCount), 0);
    if (currentCount) output.set(source.subarray(source.length - currentCount), priorCount);
    return { samples: output, sampleRate: rate };
  }

  function endsMidThought(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    if (/(?:\.\.\.|…|[,;:\-])\s*$/.test(value)) return true;
    if (/[.!?]\s*$/.test(value)) return false;
    const parts = value.toLowerCase().replace(/[^a-z0-9'\s]/g, "").trim().split(/\s+/);
    return TRAILING.has(parts[parts.length - 1]);
  }

  class Detector {
    constructor({ warm, analyze, encode, onStatus = () => {}, onResult = () => {} } = {}) {
      this.warmRequest = warm;
      this.analyzeRequest = analyze;
      this.encode = encode;
      this.onStatus = onStatus;
      this.onResult = onResult;
      this.status = null;
      this.warming = null;
    }
    setStatus(next) {
      const changed = !this.status || this.status.id !== next.id || this.status.reason !== next.reason;
      this.status = next;
      if (changed) this.onStatus(next);
      return next;
    }
    warm(signal) {
      if (!this.warmRequest) return Promise.resolve(false);
      if (this.warming) return this.warming;
      this.setStatus({ id: "loading", fallback: false, reason: null });
      this.warming = Promise.resolve().then(() => this.warmRequest(signal)).then(result => {
        if (!result?.available) throw new Error("Smart-Turn model is unavailable.");
        this.setStatus({ id: "smart-turn-v3", fallback: false, reason: null });
        return true;
      }).catch(error => {
        if (signal?.aborted) return false;
        this.setStatus({ id: "silence", fallback: true, reason: String(error.message || error) });
        return false;
      }).finally(() => { this.warming = null; });
      return this.warming;
    }
    append(previous, current, sampleRate) { return appendAudio(previous, current, sampleRate); }
    async analyze(audio, sampleRate, signal) {
      if (!this.analyzeRequest || !this.encode) return { available: false, probability: null, ms: 0 };
      if (this.warming) await this.warming;
      const startedAt = clock();
      try {
        const wav = this.encode(audio, sampleRate);
        const result = await this.analyzeRequest(wav, signal);
        const probability = Number(result?.probability);
        if (!result?.available || !Number.isFinite(probability) || probability < 0 || probability > 1) {
          throw new Error("Smart-Turn returned an invalid result.");
        }
        const value = { available: true, probability, ms: Number.isFinite(Number(result.ms)) ? Number(result.ms) : clock() - startedAt };
        this.setStatus({ id: "smart-turn-v3", fallback: false, reason: null });
        this.onResult(value);
        return value;
      } catch (error) {
        if (signal?.aborted) throw error;
        const value = { available: false, probability: null, ms: clock() - startedAt };
        this.setStatus({ id: "silence", fallback: true, reason: String(error.message || error) });
        this.onResult(value);
        return value;
      }
    }
    decide(result, text, preference = "natural") {
      const selected = policy(preference);
      if (!result?.available || !Number.isFinite(result.probability)) {
        return { complete: true, semantic: false, threshold: selected.threshold, holdMs: selected.holdMs };
      }
      return {
        complete: result.probability > selected.threshold && !endsMidThought(text),
        semantic: true,
        threshold: selected.threshold,
        holdMs: selected.holdMs,
      };
    }
  }

  return { Detector, POLICIES, MAX_AUDIO_SECONDS, appendAudio, endsMidThought, policy };
});
