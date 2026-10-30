(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiLive = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const PHASES = Object.freeze(["idle", "listening", "thinking", "speaking", "paused", "off"]);
  const TERMINAL = new Set(["completed", "cancelled", "failed"]);
  const defaultClock = () => typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  const safeNumber = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

  function percentile(values, p) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);
  }

  function metric(values) {
    const clean = values.filter(value => Number.isFinite(value));
    return clean.length ? { samples: clean.length, p50: percentile(clean, .5), p95: percentile(clean, .95) } : null;
  }

  function timeoutError(label, ms, message) {
    const error = new Error(message || `KAI's ${label} stage stopped responding after ${Math.round(ms / 1000)} seconds.`);
    error.name = "TimeoutError";
    error.code = "KAI_TURN_TIMEOUT";
    error.stage = label;
    return error;
  }

  class Turn {
    constructor(owner, id, options) {
      this.owner = owner;
      this.id = id;
      this.source = options.source === "voice" ? "voice" : "typed";
      this.expectSpeech = !!options.expectSpeech;
      this.modelDone = false;
      this.speechDone = !this.expectSpeech;
      this.status = "active";
      this.phase = "thinking";
      this.startedAt = owner.clock();
      this.endedAt = null;
      this.first = Object.create(null);
      this.timeline = [];
      this.preflight = {
        captureMs: safeNumber(options.preflight?.captureMs),
        sttMs: safeNumber(options.preflight?.sttMs),
        semanticMs: safeNumber(options.preflight?.semanticMs),
        endpointMs: safeNumber(options.preflight?.endpointMs),
      };
      this.meta = options.meta && typeof options.meta === "object" ? options.meta : {};
      this.controller = new AbortController();
      this.cancellers = new Set();
      this.watchdog = null;
      this.error = null;
      this.cancelReason = null;
      this.mark("turn_started", { source: this.source });
    }
    get signal() { return this.controller.signal; }
    active() { return this.status === "active" && this.owner.isCurrent(this); }
    mark(stage, detail) { return this.owner.mark(this, stage, detail); }
    setPhase(phase) { return this.owner.setPhase(this, phase); }
    onCancel(fn) {
      if (typeof fn !== "function" || this.status !== "active") return () => {};
      this.cancellers.add(fn);
      return () => this.cancellers.delete(fn);
    }
    watch(label, ms, message) { return this.owner.watch(this, label, ms, message); }
    touch(stage, detail) {
      if (stage) this.mark(stage, detail);
      return this.owner.touch(this);
    }
    clearWatch() { return this.owner.clearWatch(this); }
    finishModel() { return this.owner.finishModel(this); }
    finishSpeech() { return this.owner.finishSpeech(this); }
    cancel(reason = "stopped") { return this.owner.cancel(this, reason); }
    fail(error) { return this.owner.fail(this, error); }
  }

  class Session {
    constructor({ onPhase = () => {}, onTurn = () => {}, onMetric = () => {}, clock = defaultClock,
      setTimer = setTimeout, clearTimer = clearTimeout, historyLimit = 50 } = {}) {
      this.onPhase = onPhase;
      this.onTurn = onTurn;
      this.onMetric = onMetric;
      this.clock = clock;
      // Chromium's Window timers are Web-IDL methods. Storing a bare native
      // timer and later calling `this.setTimer()` gives it the Session receiver
      // and throws "Illegal invocation". Always restore the global receiver.
      this.setTimer = (fn, ms) => Reflect.apply(setTimer, globalThis, [fn, ms]);
      this.clearTimer = timer => Reflect.apply(clearTimer, globalThis, [timer]);
      this.historyLimit = Math.max(5, Math.min(500, historyLimit));
      this.sequence = 0;
      this.phase = "idle";
      this.current = null;
      this.history = [];
    }
    begin(options = {}) {
      if (this.current?.status === "active") this.cancel(this.current, "superseded");
      const turn = new Turn(this, ++this.sequence, options);
      this.current = turn;
      this._phase(turn, "thinking");
      this.onTurn("started", this.snapshot(turn));
      return turn;
    }
    isCurrent(turn) {
      const id = typeof turn === "object" ? turn?.id : turn;
      return !!this.current && this.current.id === id && this.current.status === "active";
    }
    mark(turn, stage, detail) {
      if (!this.isCurrent(turn) || typeof stage !== "string" || !stage) return false;
      const at = this.clock();
      if (turn.first[stage] == null) turn.first[stage] = at;
      turn.timeline.push({ stage, at, ...(detail && typeof detail === "object" ? { detail } : {}) });
      return true;
    }
    setPhase(turn, phase) {
      if (!this.isCurrent(turn) || !PHASES.includes(phase) || phase === "off") return false;
      return this._phase(turn, phase);
    }
    _phase(turn, phase) {
      if (turn.phase === phase && this.phase === phase) return true;
      turn.phase = phase;
      this.phase = phase;
      turn.timeline.push({ stage: "phase:" + phase, at: this.clock() });
      this.onPhase(phase, this.snapshot(turn));
      return true;
    }
    watch(turn, label, ms, message) {
      if (!this.isCurrent(turn) || !Number.isFinite(ms) || ms <= 0) return false;
      this.clearWatch(turn);
      turn.watchdog = { label: String(label || "response"), ms, message, timer: null };
      return this.touch(turn);
    }
    touch(turn) {
      if (!this.isCurrent(turn) || !turn.watchdog) return false;
      const watch = turn.watchdog;
      if (watch.timer) this.clearTimer(watch.timer);
      watch.timer = this.setTimer(() => {
        if (!this.isCurrent(turn) || turn.watchdog !== watch) return;
        this.fail(turn, timeoutError(watch.label, watch.ms, watch.message));
      }, watch.ms);
      watch.timer?.unref?.();
      return true;
    }
    clearWatch(turn) {
      if (!turn?.watchdog) return false;
      if (turn.watchdog.timer) this.clearTimer(turn.watchdog.timer);
      turn.watchdog = null;
      return true;
    }
    finishModel(turn) {
      if (!this.isCurrent(turn) || turn.modelDone) return false;
      turn.modelDone = true;
      this.clearWatch(turn);
      this.mark(turn, "model_complete");
      return this._completeIfReady(turn);
    }
    finishSpeech(turn) {
      if (!this.isCurrent(turn) || turn.speechDone) return false;
      turn.speechDone = true;
      this.mark(turn, "speech_complete");
      return this._completeIfReady(turn);
    }
    _completeIfReady(turn) {
      if (!turn.modelDone || !turn.speechDone) return false;
      return this._settle(turn, "completed");
    }
    cancel(turn = this.current, reason = "stopped") {
      if (!this.isCurrent(turn)) return false;
      turn.cancelReason = String(reason || "stopped");
      return this._settle(turn, "cancelled", turn.cancelReason);
    }
    fail(turn = this.current, error = new Error("KAI's turn failed.")) {
      if (!this.isCurrent(turn)) return false;
      turn.error = error instanceof Error ? error : new Error(String(error));
      return this._settle(turn, "failed", turn.error);
    }
    _settle(turn, status, reason) {
      if (!this.isCurrent(turn) || !TERMINAL.has(status)) return false;
      this.clearWatch(turn);
      turn.status = status;
      turn.endedAt = this.clock();
      turn.timeline.push({ stage: status, at: turn.endedAt });
      if (status !== "completed" && !turn.signal.aborted) {
        const why = reason instanceof Error ? reason : new DOMException(String(reason || status), "AbortError");
        turn.controller.abort(why);
      }
      if (status !== "completed") {
        for (const cancel of [...turn.cancellers]) {
          try { cancel(reason); } catch { /* cancellation is best-effort */ }
        }
      }
      turn.cancellers.clear();
      const snapshot = this.snapshot(turn);
      this.history.push(snapshot);
      if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
      this.current = null;
      this.phase = "idle";
      this.onPhase("idle", snapshot);
      this.onTurn(status, snapshot);
      this.onMetric(snapshot.metrics, snapshot);
      return true;
    }
    snapshot(turn = this.current) {
      if (!turn) return null;
      const at = turn.endedAt ?? this.clock();
      const firstToken = turn.first.first_token;
      const firstAudio = turn.first.playback_started;
      const modelMs = firstToken == null ? null : Math.max(0, firstToken - turn.startedAt);
      const ttsMs = firstAudio == null ? null : Math.max(0, firstAudio - (firstToken ?? turn.startedAt));
      const sttEndpointMs = turn.source === "voice" ? turn.preflight.sttMs + turn.preflight.endpointMs : null;
      const voiceToVoiceMs = sttEndpointMs != null && modelMs != null && ttsMs != null ? sttEndpointMs + modelMs + ttsMs : null;
      return Object.freeze({
        id: turn.id,
        source: turn.source,
        expectSpeech: turn.expectSpeech,
        status: turn.status,
        phase: turn.phase,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        cancelReason: turn.cancelReason,
        // Error messages may contain provider or tool response text. Keep only
        // the stable classification needed to diagnose a failed stage.
        error: turn.error ? { name: turn.error.name, code: turn.error.code, stage: turn.error.stage } : null,
        metrics: Object.freeze({
          captureMs: turn.source === "voice" ? turn.preflight.captureMs : null,
          sttEndpointMs,
          semanticMs: turn.source === "voice" ? turn.preflight.semanticMs : null,
          modelFirstTokenMs: modelMs,
          ttsFirstAudioMs: ttsMs,
          voiceToVoiceMs,
          totalMs: Math.max(0, at - turn.startedAt) + (sttEndpointMs || 0),
        }),
        timeline: Object.freeze(turn.timeline.map(item => Object.freeze({ ...item }))),
      });
    }
    recent(limit = 20) { return this.history.slice(-Math.max(1, Math.min(100, limit))).map(item => item); }
    summary() {
      const turns = this.history;
      const values = key => turns.map(turn => turn.metrics[key]).filter(Number.isFinite);
      return {
        turns: turns.length,
        completed: turns.filter(turn => turn.status === "completed").length,
        cancelled: turns.filter(turn => turn.status === "cancelled").length,
        failed: turns.filter(turn => turn.status === "failed").length,
        capture: metric(values("captureMs")),
        sttEndpoint: metric(values("sttEndpointMs")),
        semantic: metric(values("semanticMs")),
        modelFirstToken: metric(values("modelFirstTokenMs")),
        ttsFirstAudio: metric(values("ttsFirstAudioMs")),
        voiceToVoice: metric(values("voiceToVoiceMs")),
        total: metric(values("totalMs")),
      };
    }
    resetMetrics() { this.history = []; }
    diagnostics() {
      return Object.freeze({
        summary: () => this.summary(),
        recent: limit => this.recent(limit),
        reset: () => this.resetMetrics(),
        active: () => this.snapshot(),
      });
    }
  }

  return { Session, Turn, PHASES, timeoutError };
});
