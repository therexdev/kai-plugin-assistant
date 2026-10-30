(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiWake = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";
  const FOLLOW_UP_MS = 60000;
  const clock = () => typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  const turnApi = root.KaiTurn || (typeof require === "function" ? require("./mascot-turn") : null);
  const TURN_PAUSES = Object.freeze(Object.fromEntries(Object.entries(turnApi?.POLICIES || {
    quick: { silenceMs: 500 }, natural: { silenceMs: 900 }, patient: { silenceMs: 1400 },
  }).map(([name, value]) => [name, value.silenceMs])));
  const SENSITIVITY = Object.freeze({
    quiet: { level: .004, ratio: 1.8, voiceMs: 180 },
    balanced: { level: .012, ratio: 2.2, voiceMs: 240 },
    tv: { level: .018, ratio: 2.5, voiceMs: 300 },
  });
  const words = text => (text.toLowerCase().match(/[a-z0-9']+/g) || []).join(" ");
  // AEC is the first line of defence. Reject recognizable residual speaker
  // echo too, without treating a short user acknowledgement as an echo.
  function isEcho(text, output) {
    const heard = words(text), spoken = words(output);
    if (heard.split(" ").length < 2 || !spoken) return false;
    if (spoken.includes(heard)) return true;
    const a = heard.split(" "), b = new Set(spoken.split(" "));
    return a.length >= 5 && a.filter(w => b.has(w)).length / a.length > .88;
  }
  class Activity {
    constructor(rate, { calibrationMs = 600, sensitivity = "quiet" } = {}) {
      this.rate = rate; this.noise = .001; this.calibrationLeft = calibrationMs;
      this.profile = Object.hasOwn(SENSITIVITY, sensitivity) ? SENSITIVITY[sensitivity] : SENSITIVITY.tv;
      this.levels = []; this.levelMs = 0; this.reset();
    }
    get calibrating() { return this.calibrationLeft > 0; }
    get threshold() { return Math.max(this.profile.level, this.noise * this.profile.ratio); }
    measure(rms, ms) {
      this.levels.push({ rms, ms }); this.levelMs += ms;
      while (this.levels.length > 1 && this.levelMs - this.levels[0].ms >= 1500) this.levelMs -= this.levels.shift().ms;
    }
    reset() { this.pre = []; this.frames = []; this.length = 0; this.voiced = 0; this.silence = 0; this.voiceMs = this.profile.voiceMs; }
    finish() {
      let audio = null;
      if (this.voiced >= this.voiceMs) {
        audio = new Float32Array(this.length);
        let i = 0; for (const f of this.frames) { audio.set(f, i); i += f.length; }
      }
      this.reset(); return audio;
    }
    push(frame, { adapt = true, voiceMs = this.profile.voiceMs, silenceMs = 500 } = {}) {
      if (!frame.length) return null;
      const rms = Math.sqrt(frame.reduce((s, v) => s + v * v, 0) / frame.length);
      this.rms = rms;
      const ms = frame.length / this.rate * 1000;
      this.measure(rms, ms);
      if (this.calibrating) {
        this.calibrationLeft -= ms;
        if (!this.calibrating) {
          const sorted = this.levels.map(l => l.rms).sort((a, b) => a - b);
          this.noise = Math.max(.0003, sorted[Math.floor(sorted.length * .3)] || .0003);
          this.levels = []; this.levelMs = 0;
        }
        return null;
      }
      // A fan or microphone hiss can be louder than the old fixed threshold.
      // Learn sustained, nearly constant sound even while it is above the
      // threshold, instead of calling it a new 20-second utterance forever.
      if (this.levelMs >= 1500) {
        const values = this.levels.map(l => l.rms), low = Math.min(...values), high = Math.max(...values);
        if (low > .004 && high < low * 1.25) {
          if (adapt) this.noise = low; this.reset(); return null;
        }
      }
      const speech = rms > (this.frames.length ? Math.max(this.profile.level * .75, this.noise * 1.35) : this.threshold);
      if (!speech && !this.frames.length && adapt) this.noise = this.noise * .96 + rms * .04;
      if (!this.frames.length && !speech) {
        this.pre.push(frame);
        while (this.pre.length * frame.length > this.rate * .3) this.pre.shift();
        return null;
      }
      if (!this.frames.length) {
        this.voiceMs = voiceMs;
        this.frames = this.pre; this.pre = [];
        this.length = this.frames.reduce((n, f) => n + f.length, 0);
      }
      this.frames.push(frame); this.length += frame.length;
      if (speech) { this.voiced += ms; this.silence = 0; } else this.silence += ms;
      if (this.silence < silenceMs && this.length < this.rate * 20) return null;
      return this.finish();
    }
  }
  class Listener {
    constructor({ transcribe, wakeRequest, onCommand, onState, onError, onInterrupt = () => {}, onResume = () => {}, onEnd = () => {}, onLevel = () => {}, onEngine = () => {}, createVAD = null, turnDetector = null, sensitivity = "tv", turnPause = "natural", interruptWithWake = false, followUpMs = FOLLOW_UP_MS, interruptMs = 8000, transcribeMs = 30000 }) {
      Object.assign(this, { transcribe, wakeRequest, onCommand, onState, onError, onInterrupt, onResume, onEnd, onLevel, onEngine, createVAD, turnDetector, sensitivity, interruptWithWake, followUpMs, interruptMs, transcribeMs });
      this.turnPause = Object.hasOwn(TURN_PAUSES, turnPause) ? turnPause : "natural";
      this.epoch = 0; this.active = false; this.paused = false; this.engaged = false;
      this.queue = []; this.output = []; this.responding = false; this.serial = 0; this.wakeSerial = null; this.playback = false; this.failures = 0; this.rejectedInterruptions = 0;
    }
    async start({ engaged = false } = {}) {
      const stopping = this.stop(), epoch = this.epoch;
      await stopping;
      if (epoch !== this.epoch) return;
      const startAbort = this.startAbort = new AbortController();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false });
        if (epoch !== this.epoch) { stream.getTracks().forEach(t => t.stop()); return; }
        this.stream = stream;
        // Chromium versions supporting all-system AEC can cancel local TTS as
        // well as call audio. Boolean AEC remains enabled on older versions.
        const track = stream.getAudioTracks()[0];
        if (track?.getCapabilities?.().echoCancellation?.includes("all")) {
          await track.applyConstraints({ echoCancellation: { exact: "all" } }).catch(() => {});
        }
        if (epoch !== this.epoch) return;
        const context = this.context = new AudioContext();
        stream.getTracks().forEach(t => t.addEventListener("ended", () => {
          if (epoch === this.epoch && this.active) { this.stop(); this.onError(new Error("The microphone disconnected. Tap the mic to reconnect.")); }
        }));
        let sileroError = null;
        try {
          const create = this.createVAD || root.KaiVAD?.SileroCapture?.create?.bind(root.KaiVAD.SileroCapture);
          if (!create) throw new Error("Silero VAD is unavailable in this renderer.");
          const engine = await create({ stream, audioContext: context, signal: startAbort.signal,
            sensitivity: this.sensitivity, turnPause: this.turnPause, guarded: this.responding && this.interruptWithWake,
            onFrame: (probabilities, frame) => this.vadFrame(probabilities, frame, epoch),
            onSpeechStart: () => this.vadSpeechStart(epoch),
            onSpeechRealStart: () => this.vadSpeechRealStart(epoch),
            onSpeechEnd: audio => this.vadSpeechEnd(audio, epoch),
            onMisfire: () => this.vadMisfire(epoch) });
          if (epoch !== this.epoch) { await engine.destroy(); return; }
          this.captureEngine = engine; this.captureMode = "silero-v5"; this.activity = null;
        } catch (error) {
          if (epoch !== this.epoch || startAbort.signal.aborted) return;
          sileroError = error;
          // The known calibrated detector remains a complete, local fallback.
          // Only one worklet is active: Silero must fail before this starts.
          await context.audioWorklet.addModule("mascot-audio-worklet.js");
          if (epoch !== this.epoch) return;
          this.activity = new Activity(context.sampleRate, { sensitivity: this.sensitivity });
          this.source = context.createMediaStreamSource(stream);
          this.capture = new AudioWorkletNode(context, "kai-capture");
          this.source.connect(this.capture); this.capture.connect(context.destination);
          this.capture.port.onmessage = ({ data }) => this.frame(data, epoch);
          this.captureMode = "adaptive-rms";
        }
        await context.resume();
        if (epoch !== this.epoch) return;
        this.failures = 0; this.rejectedInterruptions = 0;
        this.active = true; this.startAbort = null;
        this.onEngine({ id: this.captureMode, fallback: this.captureMode !== "silero-v5",
          reason: sileroError ? String(sileroError.message || sileroError) : null });
        // Prime the tiny semantic model while the person begins speaking. It
        // never blocks microphone startup; failure leaves the existing
        // bounded silence endpoint fully operational.
        this.turnWarmAbort?.abort();
        this.turnWarmAbort = new AbortController();
        this.turnDetector?.warm?.(this.turnWarmAbort.signal).catch?.(() => {});
        if (engaged) this.engage(); this.state();
      } catch (error) { if (epoch === this.epoch) { await this.stop(); throw error; } }
    }
    capturing() { return !!(this.segment || this.activity?.frames.length); }
    state() {
      const value = !this.active ? "off" : this.paused ? "paused" : this.activity?.calibrating ? "calibrating" : this.segment?.started ? "capturing" :
        this.processing ? "transcribing" : this.pendingTurn?.waiting ? "holding" : this.engaged ? "listening" : "waiting";
      if (value !== this.phase) { this.phase = value; this.onState(value); }
    }
    engage() {
      if (!this.active) return;
      this.engaged = true; this.armTimer(); this.state();
    }
    armTimer() {
      clearTimeout(this.timer);
      if (!this.engaged || !this.active) return;
      this.timer = setTimeout(() => {
        if (this.responding || this.processing || this.pendingTurn || this.capturing()) return this.armTimer();
        this.endConversation();
      }, this.followUpMs);
      this.timer.unref?.();
    }
    endConversation() { this.clearTurn(); this.engaged = false; this.wakeSerial = null; clearTimeout(this.timer); this.state(); }
    setResponding(value) {
      if (this.responding === value) return;
      this.responding = value;
      if (value) { this.replySerial = (this.replySerial || 0) + 1; this.interruptedReply = null; }
      if (!value) {
        this.echoUntil = Date.now() + 1200; this.armTimer();
        this.interruptBlocked = false; this.rejectedInterruptions = 0; this.releaseInterruption();
      }
      this.syncCaptureOptions();
    }
    setPlayback(value) {
      const state = typeof value === "object" && value ? value : { active: !!value, audible: !!value };
      const wasAudible = this.playback;
      this.playback = !!state.audible; this.speakerActive = !!state.active;
      this.playbackClock = { scope: state.scope ?? null, queuedMs: Math.max(0, Number(state.queuedMs) || 0),
        gaps: Math.max(0, Number(state.gaps) || 0), maxGapMs: Math.max(0, Number(state.maxGapMs) || 0) };
      if (Number.isFinite(state.echoUntil)) this.echoUntil = Math.max(this.echoUntil || 0, state.echoUntil);
      if (wasAudible && !this.playback) this.echoUntil = Math.max(this.echoUntil || 0, Date.now() + 1200);
    }
    speakerEchoing() { return this.playback || Date.now() < (this.echoUntil || 0); }
    configure({ sensitivity, interruptWithWake, turnPause = this.turnPause }) {
      this.sensitivity = Object.hasOwn(SENSITIVITY, sensitivity) ? sensitivity : "tv";
      this.interruptWithWake = !!interruptWithWake;
      this.turnPause = Object.hasOwn(TURN_PAUSES, turnPause) ? turnPause : "natural";
      // Discard candidates captured under the old setting, without reopening
      // the device or losing the active conversation.
      const wasPaused = this.paused;
      this.pause(true);
      if (this.activity) this.activity.profile = SENSITIVITY[this.sensitivity];
      this.syncCaptureOptions();
      this.pause(wasPaused);
    }
    syncCaptureOptions() {
      this.captureEngine?.configure({ sensitivity: this.sensitivity, turnPause: this.turnPause,
        guarded: this.segment?.guarded ?? (this.responding && this.interruptWithWake) });
    }
    echoText() { return this.output.filter(o => Date.now() - o.at < 30000).map(o => o.text).join(" "); }
    interrupt(segment) {
      // The AEC tail stays echo-marked, but only currently audible output may
      // be paused. Residual speaker audio must never hold a later follow-up.
      if (segment.guarded || this.holdSerial != null || this.interruptBlocked || !this.playback) return;
      this.holdSerial = segment.serial; this.onInterrupt();
      this.holdTimer = setTimeout(() => {
        // No unconfirmed sound may lock the speaker indefinitely. Recognition
        // still runs, and confirmed words can interrupt after this release.
        this.interruptBlocked = true; this.releaseInterruption();
      }, this.interruptMs);
      this.holdTimer.unref?.();
    }
    releaseInterruption(serial, rejected = false) {
      if (serial != null && serial !== this.holdSerial) return;
      clearTimeout(this.holdTimer);
      const held = this.holdSerial != null; this.holdSerial = null;
      if (held && rejected && ++this.rejectedInterruptions >= 2) this.interruptBlocked = true;
      if (held) this.onResume();
    }
    hearOutput(text) {
      this.output = this.output.filter(item => Date.now() - item.at < 30000).slice(-3);
      this.output.push({ text, at: Date.now() });
    }
    pause(value) {
      if (this.paused === value) return;
      this.paused = value;
      this.clearTurn(); this.activity?.reset(); this.segment = null; this.queue = [];
      this.captureEngine?.setPaused(value).catch(error => {
        if (this.active && this.paused === value) this.onError(error, { recoverable: true });
      });
      this.abort?.abort(); this.releaseInterruption(); this.state();
    }
    clearSemanticHold() {
      clearTimeout(this.semanticTimer); this.semanticTimer = null;
      if (this.pendingTurn) { this.pendingTurn.waiting = false; this.pendingTurn.holdUntil = 0; }
    }
    clearTurn() { clearTimeout(this.turnTimer); this.clearSemanticHold(); this.pendingTurn = null; }
    cancelTurn() { const wasPaused = this.paused; this.pause(true); this.pause(wasPaused); }
    collect(command, item, epoch) {
      if (!this.pendingTurn) {
        this.pendingTurn = { text: "", serial: item.serial, epoch, segments: 0,
          audio: null, waiting: false, holdUntil: 0,
          timing: { captureMs: 0, sttMs: 0, semanticMs: 0, lastSpeechEndedAt: 0, lastRecognizedAt: 0 } };
        this.turnTimer = setTimeout(() => {
          if (!this.pendingTurn || epoch !== this.epoch) return;
          this.cancelTurn();
          this.onError(new Error("That question was getting long. Please ask one part at a time."), { recoverable: true });
        }, 45000);
        this.turnTimer.unref?.();
      }
      const text = [this.pendingTurn.text, command].filter(Boolean).join(" ");
      if (text.length > 12000) {
        this.cancelTurn(); this.onError(new Error("Please ask a shorter question."), { recoverable: true }); return;
      }
      this.pendingTurn.text = text;
      if (item.turnAudio) this.pendingTurn.audio = item.turnAudio;
      this.pendingTurn.segments++;
      this.pendingTurn.timing.captureMs += item.audio.length / item.sampleRate * 1000;
      this.pendingTurn.timing.sttMs += item.transcribeMs || 0;
      this.pendingTurn.timing.semanticMs += item.semanticMs || 0;
      this.pendingTurn.timing.lastSpeechEndedAt = Math.max(this.pendingTurn.timing.lastSpeechEndedAt, item.speechEndedAt || 0);
      this.pendingTurn.timing.lastRecognizedAt = Math.max(this.pendingTurn.timing.lastRecognizedAt, item.recognizedAt || 0);
      const decision = item.force ? { complete: true } : this.turnDetector?.decide?.(item.turnResult, text, this.turnPause) || { complete: true };
      // Smart-Turn's context window is eight seconds; twenty seconds is the
      // hard conversational bound. Never let a classifier keep a live turn
      // open indefinitely, and always honor explicit tap-to-send.
      if (decision.complete || this.pendingTurn.timing.captureMs >= 20000) this.clearSemanticHold();
      else this.scheduleSemanticHold(epoch, decision.holdMs);
    }
    scheduleSemanticHold(epoch, holdMs) {
      clearTimeout(this.semanticTimer);
      const turn = this.pendingTurn;
      if (!turn || turn.epoch !== epoch) return;
      const delay = Math.max(250, Math.min(8000, Number(holdMs) || 4000));
      turn.waiting = true; turn.holdUntil = Date.now() + delay;
      const finish = () => {
        if (!this.pendingTurn || this.pendingTurn !== turn || epoch !== this.epoch) return;
        // Speech may have begun just as the bound expired. Poll briefly until
        // capture/recognition settles, then let that newer evidence decide.
        if (this.capturing() || this.processing || this.queue.length) {
          this.semanticTimer = setTimeout(finish, 250); this.semanticTimer.unref?.(); return;
        }
        turn.waiting = false; turn.holdUntil = 0; this.semanticTimer = null;
        this.deliverTurn(epoch, true);
      };
      this.semanticTimer = setTimeout(finish, delay);
      this.semanticTimer.unref?.();
      this.state();
    }
    holding() { return !!this.pendingTurn?.waiting; }
    commitPending() {
      if (!this.pendingTurn) return;
      this.clearSemanticHold();
      return this.deliverTurn(this.epoch, true);
    }
    async deliverTurn(epoch = this.epoch, force = false) {
      if (this.processing || this.delivering || !this.pendingTurn || this.queue.length || this.capturing() ||
          !this.active || this.paused || epoch !== this.epoch || (this.pendingTurn.waiting && !force)) return;
      const turn = this.pendingTurn;
      this.clearTurn();
      if (turn.epoch !== epoch) return;
      this.delivering = true;
      const timing = { captureMs: turn.timing.captureMs, sttMs: turn.timing.sttMs,
        semanticMs: turn.timing.semanticMs,
        endpointMs: Math.max(0, clock() - (turn.timing.lastRecognizedAt || clock())) };
      try { await this.onCommand(turn.text, { source: "voice", serial: turn.serial, segments: turn.segments, timing }); this.releaseInterruption(turn.serial); }
      catch (error) { if (epoch === this.epoch && !this.paused) this.onError(error, { recoverable: true }); }
      finally { if (epoch === this.epoch) { this.delivering = false; this.state(); } }
    }
    segmentStart() {
      return { serial: ++this.serial, armed: this.engaged,
        guarded: this.responding && this.interruptWithWake, replySerial: this.replySerial,
        echo: this.speakerEchoing() ? this.echoText() : "", started: false, captureStartedAt: clock(),
        playback: this.playbackClock ? { ...this.playbackClock } : null };
    }
    vadFrame(probabilities, _frame, epoch = this.epoch) {
      if (!this.active || this.paused || epoch !== this.epoch) return;
      if (this.speakerEchoing() && this.segment) this.segment.echo = this.echoText();
      if (Date.now() - (this.levelAt || 0) >= 100) {
        this.levelAt = Date.now();
        const probability = Math.max(0, Math.min(1, Number(probabilities?.isSpeech) || 0));
        this.onLevel(probability, this.captureEngine?.threshold || .5);
      }
    }
    vadSpeechStart(epoch = this.epoch) {
      if (!this.active || this.paused || epoch !== this.epoch || this.segment) return;
      this.segment = this.segmentStart();
      if (this.speakerEchoing()) this.segment.echo = this.echoText();
    }
    vadSpeechRealStart(epoch = this.epoch) {
      if (!this.active || this.paused || epoch !== this.epoch) return;
      if (!this.segment) this.segment = this.segmentStart();
      this.segment.started = true;
      if (this.segment.armed) this.interrupt(this.segment);
      this.state();
    }
    vadSpeechEnd(audio, epoch = this.epoch) {
      if (!this.active || this.paused || epoch !== this.epoch) return;
      const segment = this.segment;
      this.segment = null;
      this.syncCaptureOptions();
      if (segment?.started && audio?.length) return this.submit(audio, epoch, 16000, segment);
      this.releaseInterruption(segment?.serial, true); this.state();
      return this.deliverTurn(epoch);
    }
    vadMisfire(epoch = this.epoch) {
      if (!this.active || epoch !== this.epoch) return;
      const segment = this.segment; this.segment = null;
      this.syncCaptureOptions();
      this.releaseInterruption(segment?.serial, true); this.state();
      return this.deliverTurn(epoch);
    }
    frame(data, epoch = this.epoch) {
      if (!this.active || this.paused || epoch !== this.epoch || !this.activity) return;
      if (!this.activity.frames.length) this.segment = { serial: ++this.serial, armed: this.engaged,
        guarded: this.responding && this.interruptWithWake, replySerial: this.replySerial,
        echo: this.speakerEchoing() ? this.echoText() : "", started: false, captureStartedAt: clock(),
        playback: this.playbackClock ? { ...this.playbackClock } : null };
      // Output can start after capture began; retain that overlap for echo
      // rejection instead of treating KAI's first audible sentence as a user.
      if (this.speakerEchoing()) this.segment.echo = this.echoText();
      // A single spoken "KAI" may be shorter than normal conversational speech.
      // It still has to pass the room's loudness threshold and name recognition.
      const audio = this.activity.push(data, { adapt: !this.speakerEchoing(), voiceMs: this.segment.guarded ? 120 : this.activity.profile.voiceMs,
        // Name recognition stays quick during a reply. Outside a reply, a
        // brief pause is part of the same question, not an instruction to send.
        silenceMs: this.segment.guarded ? 500 : TURN_PAUSES[this.turnPause] });
      if (Date.now() - (this.levelAt || 0) >= 100) {
        this.levelAt = Date.now(); this.onLevel(this.activity.rms, this.activity.threshold);
      }
      if (this.activity.voiced >= this.activity.voiceMs && !this.segment.started) {
        this.segment.started = true;
        if (this.segment.armed) this.interrupt(this.segment);
        this.state();
      }
      if (audio) return this.submit(audio, epoch);
      if (!this.activity.frames.length) {
        this.releaseInterruption(this.segment?.serial, true); this.segment = null; this.state();
        return this.deliverTurn(epoch);
      }
    }
    flush() {
      if (!this.active || this.paused) return;
      if (this.pendingTurn?.waiting && !this.capturing()) return this.commitPending();
      if (this.segment) this.segment.force = true;
      if (this.captureEngine) return this.captureEngine.flush().catch(error => this.onError(error, { recoverable: true }));
      const audio = this.activity.finish();
      if (audio) return this.submit(audio, this.epoch);
      this.segment = null; return this.deliverTurn();
    }
    submit(audio, epoch, sampleRate = this.context?.sampleRate || 16000, submittedSegment = this.segment) {
      const segment = submittedSegment || { armed: this.engaged, echo: "" };
      if (this.segment === segment) this.segment = null;
      // Keep capturing while Whisper works; a delayed transcription must not
      // create a deaf interval. At most two waiting utterances bound memory.
      if (this.queue.length >= 2) {
        this.cancelTurn();
        this.onError(new Error("I'm catching up. Please repeat the last question."), { recoverable: true });
        return;
      }
      this.queue.push({ audio, sampleRate, serial: segment.serial ?? ++this.serial, speechEndedAt: clock(), ...segment });
      this.state(); return this.drain(epoch);
    }
    async recognize(item, abort) {
      let timer, cancelled;
      const startedAt = clock();
      try {
        const previousAudio = this.pendingTurn?.audio || null;
        item.turnAudio = this.turnDetector?.append?.(previousAudio, item.audio, item.sampleRate) || null;
        const stt = Promise.race([
          this.transcribe(item.audio, item.sampleRate, abort.signal),
          new Promise((resolve, reject) => {
            cancelled = () => reject(abort.signal.reason || new Error("Listening cancelled."));
            abort.signal.addEventListener("abort", cancelled, { once: true });
            timer = setTimeout(() => {
              const error = new Error("Listening took too long. Please try your question again.");
              error.code = "VOICE_TIMEOUT"; abort.abort(error);
            }, this.transcribeMs);
          }),
        ]);
        const endpoint = item.force || !item.turnAudio || !this.turnDetector?.analyze ? Promise.resolve(null) :
          this.turnDetector.analyze(item.turnAudio.samples, item.turnAudio.sampleRate, abort.signal);
        const [result, turnResult] = await Promise.all([stt, endpoint]);
        item.turnResult = turnResult;
        item.semanticMs = turnResult?.ms || 0;
        item.recognizedAt = clock();
        return result;
      } finally {
        item.transcribeMs = clock() - startedAt;
        clearTimeout(timer); abort.signal.removeEventListener("abort", cancelled);
      }
    }
    async drain(epoch) {
      if (this.processing || !this.active || this.paused) return;
      this.processing = true; this.state();
      try {
        while (this.queue.length && epoch === this.epoch && !this.paused) {
          const item = this.queue.shift(), abort = this.abort = new AbortController();
          const result = await this.recognize(item, abort);
          if (epoch !== this.epoch || this.paused || abort.signal.aborted) return;
          this.failures = 0;
          const text = result.text?.trim() || "";
          if (!text || /^\s*[\[(].*[\])]\s*$/.test(text) || isEcho(text, item.echo)) {
            this.releaseInterruption(item.serial, true); continue;
          }
          const wake = this.wakeRequest(text, { interrupt: item.guarded });
          // In a noisy room, spoken dialogue is not proof the user is
          // interrupting. Require the name for audio captured during a reply,
          // even if recognition finishes after that reply has ended.
          const afterCue = item.guarded && item.replySerial === this.interruptedReply && item.serial > this.wakeSerial;
          if (item.guarded && !wake && !afterCue) { this.releaseInterruption(item.serial, true); continue; }
          const command = wake ? wake.text : item.armed || (this.engaged && this.wakeSerial !== null && item.serial > this.wakeSerial) ? text : "";
          if (wake) {
            this.wakeSerial = item.serial; this.engage();
            if (item.guarded) this.interruptedReply = item.replySerial;
            if (item.guarded) await this.onEnd(false);
            if (epoch !== this.epoch || this.paused || abort.signal.aborted) return;
          }
          if (!command) { this.releaseInterruption(item.serial, true); continue; }
          this.engage();
          if (/^(?:stop(?: talking)?|wait(?: a second)?|hold on)[.!?]*$/i.test(command)) {
            this.clearTurn();
            this.onEnd(false); this.releaseInterruption(item.serial); continue;
          }
          if (/^(?:stop listening|turn (?:the )?microphone off)[.!?]*$/i.test(command)) {
            await this.stop(); this.onEnd(true); return;
          }
          if (/^(?:that['’]?s all(?: kai)?|thanks kai|thank you kai|go to sleep)[.!?]*$/i.test(command)) {
            this.endConversation(); this.onEnd(false); this.releaseInterruption(item.serial); continue;
          }
          this.collect(command, item, epoch);
          this.releaseInterruption(item.serial);
          if (epoch !== this.epoch) return;
        }
      } catch (error) {
        if (epoch === this.epoch && (!this.abort?.signal.aborted || error.code === "VOICE_TIMEOUT")) {
          this.clearTurn(); this.queue = []; this.activity?.reset(); this.captureEngine?.reset().catch(() => {}); this.segment = null; this.releaseInterruption();
          if (++this.failures >= 3) { await this.stop(); this.onError(new Error("Voice input keeps failing. The microphone is off. Try the mic again or type your question.")); }
          else this.onError(error, { recoverable: true });
        }
      } finally {
        if (epoch === this.epoch) {
          this.processing = false; this.abort = null;
          this.state();
          if (this.queue.length && !this.paused) this.drain(epoch);
          else await this.deliverTurn(epoch);
        }
      }
    }
    async stop() {
      this.epoch++; this.clearTurn(); this.active = false; this.processing = false; this.delivering = false; this.paused = false;
      this.engaged = false; this.wakeSerial = null; this.responding = false; this.playback = false; this.speakerActive = false; this.playbackClock = null; this.interruptBlocked = false; this.segment = null; this.queue = []; this.output = [];
      clearTimeout(this.timer); this.abort?.abort(); this.abort = null; this.startAbort?.abort(); this.startAbort = null;
      this.turnWarmAbort?.abort(); this.turnWarmAbort = null;
      const captureEngine = this.captureEngine; this.captureEngine = null; this.captureMode = null;
      this.capture?.disconnect(); this.source?.disconnect();
      if (this.capture) this.capture.port.onmessage = null;
      this.capture = null; this.source = null; this.activity = null;
      await captureEngine?.destroy().catch(() => {});
      this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
      const context = this.context; this.context = null;
      this.releaseInterruption(); this.state();
      this.onLevel(0, 0);
      await context?.close().catch(() => {});
    }
  }
  return { Activity, Listener, isEcho, TURN_PAUSES };
});
