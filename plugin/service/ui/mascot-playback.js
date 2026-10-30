(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiPlayback = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function wav16(buffer) {
    const view = new DataView(buffer);
    const tag = (at, value) => [...value].every((character, index) => view.getUint8(at + index) === character.charCodeAt(0));
    if (buffer.byteLength <= 44 || !tag(0, "RIFF") || !tag(8, "WAVE") || !tag(12, "fmt ") || !tag(36, "data") ||
      view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
      view.getUint16(34, true) !== 16 || view.getUint32(40, true) !== buffer.byteLength - 44 || buffer.byteLength % 2) {
      throw new Error("KAI received unreadable voice audio. Please try again.");
    }
    const sampleRate = view.getUint32(24, true), count = (buffer.byteLength - 44) / 2;
    if (sampleRate < 8000 || sampleRate > 48000) throw new Error("KAI received an unsupported voice sample rate.");
    const samples = new Float32Array(count);
    for (let index = 0; index < count; index++) samples[index] = view.getInt16(44 + index * 2, true) / 32768;
    return { samples, sampleRate };
  }

  // One AudioContext and one monotonically increasing cursor own all native
  // KAI speech in a turn. Sentences may finish synthesis independently, but
  // they enter the speaker timeline without creating a new media element or
  // audio device boundary between them.
  class Clock {
    constructor({ contextFactory = () => new AudioContext(), onState = () => {}, leadMs = 25, tailMs = 1200,
      timer = (fn, ms) => setInterval(fn, ms), clearTimer = id => clearInterval(id), now = () => Date.now() } = {}) {
      Object.assign(this, { contextFactory, onState, leadMs, tailMs, timer, clearTimer, now });
      this.scope = null; this.context = null; this.cursor = 0; this.records = new Set(); this.generation = 0;
      this.stats = { scheduled: 0, gaps: 0, gapMs: 0, maxGapMs: 0 };
      this.lastState = ""; this.echoUntil = 0;
    }
    prime() {
      if (!this.context) {
        this.context = this.contextFactory(); this.cursor = 0;
        this.stats = { scheduled: 0, gaps: 0, gapMs: 0, maxGapMs: 0 };
      }
      const ready = this.context.resume?.() || Promise.resolve();
      ready.catch?.(error => this.cancel(undefined, error)); return ready;
    }
    ensure(scope) {
      if (scope == null) throw new Error("Playback needs a turn scope.");
      if (this.scope !== null && this.scope !== scope) this.cancel();
      if (!this.context) this.prime();
      if (this.scope === null) {
        this.scope = scope;
        const startTimer = this.timer;
        this.interval = startTimer(() => this.emit(), 15); this.interval?.unref?.();
      }
      return this.context;
    }
    schedule(samples, sampleRate, { scope, text = "" } = {}) {
      if (!(samples instanceof Float32Array) || !samples.length || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
        throw new Error("KAI received invalid playback audio.");
      }
      const context = this.ensure(scope), generation = this.generation, now = context.currentTime;
      const earliest = now + this.leadMs / 1000, previous = this.cursor;
      const start = Math.max(previous || earliest, earliest), duration = samples.length / sampleRate, end = start + duration;
      if (previous && start - previous > .01) {
        const gap = (start - previous) * 1000;
        this.stats.gaps++; this.stats.gapMs += gap; this.stats.maxGapMs = Math.max(this.stats.maxGapMs, gap);
      }
      const buffer = context.createBuffer(1, samples.length, sampleRate); buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
      let resolve, startedResolve;
      const finished = new Promise(done => { resolve = done; });
      const started = new Promise(done => { startedResolve = done; });
      const record = { source, start, end, text, resolve, startedResolve, started: false };
      this.records.add(record); this.cursor = end; this.stats.scheduled++;
      source.onended = () => this.finish(record, generation);
      source.start(start); this.emit();
      return { start, end, finished, started };
    }
    scheduleWav(buffer, options) {
      const decoded = wav16(buffer); return this.schedule(decoded.samples, decoded.sampleRate, options);
    }
    finish(record, generation) {
      if (!this.records.has(record)) return;
      this.records.delete(record); record.source.onended = null; record.source.disconnect?.();
      if (!record.started) record.startedResolve({ cancelled: generation !== this.generation });
      record.resolve({ cancelled: generation !== this.generation });
      this.emit();
    }
    snapshot() {
      const context = this.context, audioNow = context?.currentTime || 0, wallNow = this.now();
      let current = null;
      if (context?.state === "running") for (const record of this.records) {
        if (audioNow >= record.start && audioNow < record.end) { current = record; break; }
      }
      if (current) this.echoUntil = wallNow + this.tailMs;
      return { active: this.records.size > 0, audible: !!current, text: current?.text || "", scope: this.scope,
        queuedMs: Math.max(0, (this.cursor - audioNow) * 1000), echoUntil: this.echoUntil, ...this.metrics() };
    }
    metrics() { return { scheduled: this.stats.scheduled, gaps: this.stats.gaps, gapMs: this.stats.gapMs, maxGapMs: this.stats.maxGapMs }; }
    emit() {
      const state = this.snapshot(), audioNow = this.context?.currentTime || 0;
      for (const record of this.records) if (!record.started && audioNow >= record.start) { record.started = true; record.startedResolve({ cancelled: false }); }
      const key = [state.active, state.audible, state.text, state.scope, Math.round(state.queuedMs / 50)].join("|");
      if (key !== this.lastState) { this.lastState = key; this.onState(state); }
    }
    hold(value) {
      if (!this.context) return;
      const action = value ? this.context.suspend?.() : this.context.resume?.();
      action?.then?.(() => this.emit()).catch?.(error => this.cancel(undefined, error));
    }
    cancel(scope, error) {
      if (scope !== undefined && this.scope !== null && scope !== this.scope) return false;
      this.generation++;
      const records = [...this.records]; this.records.clear();
      for (const record of records) {
        record.source.onended = null;
        try { record.source.stop(); } catch {}
        record.source.disconnect?.(); if (!record.started) record.startedResolve({ cancelled: true }); record.resolve({ cancelled: true });
      }
      if (this.interval) { const stopTimer = this.clearTimer; stopTimer(this.interval); }
      this.interval = null; const context = this.context;
      this.context = null; this.scope = null; this.cursor = 0; this.echoUntil = this.now() + this.tailMs; this.lastState = "";
      context?.close?.().catch?.(() => {});
      this.onState({ active: false, audible: false, text: "", scope: null, queuedMs: 0, echoUntil: this.echoUntil,
        error: error?.message || null, ...this.metrics() });
      return true;
    }
  }

  return { Clock, wav16 };
});
