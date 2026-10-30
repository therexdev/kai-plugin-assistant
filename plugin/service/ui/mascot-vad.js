(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiVAD = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  const ASSET_BASE = "/live-senses/vad/";
  const turn = root.KaiTurn || (typeof require === "function" ? require("./mascot-turn") : null);
  const PAUSES = Object.freeze(Object.fromEntries(Object.entries(turn?.POLICIES || {
    quick: { silenceMs: 500 }, natural: { silenceMs: 900 }, patient: { silenceMs: 1400 },
  }).map(([name, value]) => [name, value.silenceMs])));
  const PROFILES = Object.freeze({
    quiet: { threshold: .35, minSpeechMs: 180 },
    balanced: { threshold: .5, minSpeechMs: 240 },
    tv: { threshold: .65, minSpeechMs: 300 },
  });
  let runtimePromise = null;

  function detectorOptions({ sensitivity = "tv", turnPause = "natural", guarded = false } = {}) {
    const profile = PROFILES[sensitivity] || PROFILES.tv;
    return {
      positiveSpeechThreshold: profile.threshold,
      negativeSpeechThreshold: Math.max(.1, Math.round((profile.threshold - .15) * 100) / 100),
      minSpeechMs: guarded ? 120 : profile.minSpeechMs,
      redemptionMs: guarded ? 500 : (PAUSES[turnPause] || PAUSES.natural),
      preSpeechPadMs: 300,
      submitUserSpeechOnPause: false,
    };
  }

  function loadScript(url, ready) {
    if (ready()) return Promise.resolve();
    const document = root.document;
    if (!document?.head) return Promise.reject(new Error("Silero VAD needs a browser document."));
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url; script.async = true; script.dataset.kaiVadAsset = url;
      script.onload = () => ready() ? resolve() : reject(new Error("The local VAD runtime did not initialize."));
      script.onerror = () => { script.remove(); reject(new Error("The local VAD runtime could not load.")); };
      document.head.append(script);
    });
  }

  async function loadRuntime() {
    if (root.ort?.InferenceSession && root.vad?.MicVAD) return root.vad;
    if (!runtimePromise) {
      runtimePromise = (async () => {
        await loadScript(ASSET_BASE + "ort.min.js", () => !!root.ort?.InferenceSession);
        await loadScript(ASSET_BASE + "bundle.min.js", () => !!root.vad?.MicVAD);
        return root.vad;
      })().catch(error => { runtimePromise = null; throw error; });
    }
    return runtimePromise;
  }

  class SileroCapture {
    constructor(instance, gate, config) {
      this.instance = instance; this.gate = gate; this.config = config;
      this.mode = "silero-v5"; this.sampleRate = 16000;
      this.desiredPaused = false; this.destroyed = false; this.pending = Promise.resolve();
      this.configure(config);
    }
    static async create({ stream, audioContext, sensitivity = "tv", turnPause = "natural", guarded = false,
      signal, runtime, onFrame = () => {}, onSpeechStart = () => {}, onSpeechRealStart = () => {},
      onSpeechEnd = () => {}, onMisfire = () => {} } = {}) {
      if (!stream || !audioContext) throw new Error("Silero VAD needs KAI's microphone stream and audio context.");
      signal?.throwIfAborted?.();
      const library = runtime || await loadRuntime();
      signal?.throwIfAborted?.();
      const gate = { active: true, paused: false };
      const emit = (callback, ...args) => { if (gate.active && !gate.paused) callback(...args); };
      const config = { sensitivity, turnPause, guarded };
      let instance;
      try {
        instance = await library.MicVAD.new({
          model: "v5",
          baseAssetPath: ASSET_BASE,
          onnxWASMBasePath: ASSET_BASE,
          audioContext,
          processorType: "AudioWorklet",
          startOnLoad: false,
          getStream: async () => stream,
          pauseStream: async () => {},
          resumeStream: async () => stream,
          workletOptions: {},
          ...detectorOptions(config),
          ortConfig: ort => {
            ort.env.logLevel = "error";
            // One inference lane is enough for 32 ms frames and avoids
            // competing with Whisper, the local model and speech synthesis.
            ort.env.wasm.numThreads = 1;
            ort.env.wasm.proxy = false;
          },
          onFrameProcessed: (probabilities, frame) => emit(onFrame, probabilities, frame),
          onSpeechStart: () => emit(onSpeechStart),
          onSpeechRealStart: () => emit(onSpeechRealStart),
          onSpeechEnd: audio => emit(onSpeechEnd, audio),
          onVADMisfire: () => emit(onMisfire),
        });
        signal?.throwIfAborted?.();
        await instance.start();
        signal?.throwIfAborted?.();
        return new SileroCapture(instance, gate, config);
      } catch (error) {
        gate.active = false;
        try { if (instance?.listening) await instance.pause(); } catch { /* partially initialized */ }
        try { instance?.destroy(); } catch { /* partially initialized */ }
        throw error;
      }
    }
    get threshold() { return detectorOptions(this.config).positiveSpeechThreshold; }
    configure(update = {}) {
      this.config = { ...this.config, ...update };
      this.instance.setOptions(detectorOptions(this.config));
    }
    schedule(task) {
      this.pending = this.pending.then(task, task);
      return this.pending;
    }
    setPaused(value) {
      value = !!value; this.desiredPaused = value;
      if (value) this.gate.paused = true;
      return this.schedule(async () => {
        if (this.destroyed) return;
        if (value) {
          if (this.instance.listening) await this.instance.pause();
          return;
        }
        // A newer pause wins over this queued resume.
        if (this.desiredPaused) return;
        if (!this.instance.listening) await this.instance.start();
        this.gate.paused = false;
      });
    }
    reset() {
      this.gate.paused = true;
      return this.schedule(async () => {
        if (this.destroyed) return;
        if (this.instance.listening) await this.instance.pause();
        if (!this.desiredPaused) {
          await this.instance.start();
          this.gate.paused = false;
        }
      });
    }
    flush() {
      if (this.destroyed || this.desiredPaused) return Promise.resolve(false);
      return this.schedule(async () => {
        if (this.destroyed || this.desiredPaused) return false;
        // Pausing is the library's supported way to close an in-progress
        // segment. Enable submission for this operation only; ordinary pauses
        // (approval screens, hide, settings changes) always discard audio.
        this.instance.setOptions({ submitUserSpeechOnPause: true });
        try { if (this.instance.listening) await this.instance.pause(); }
        finally { this.instance.setOptions({ submitUserSpeechOnPause: false }); }
        if (!this.destroyed && !this.desiredPaused) await this.instance.start();
        return true;
      });
    }
    async destroy() {
      if (this.destroyed) return;
      this.destroyed = true; this.desiredPaused = true; this.gate.active = false; this.gate.paused = true;
      await this.pending.catch(() => {});
      try { if (this.instance.listening) await this.instance.pause(); } catch { /* context may already be closing */ }
      try { this.instance.destroy(); } catch { /* best-effort worklet teardown */ }
    }
  }

  return { ASSET_BASE, PROFILES, detectorOptions, loadRuntime, SileroCapture };
});
