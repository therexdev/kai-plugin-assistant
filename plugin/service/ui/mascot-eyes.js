(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiEyes = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const SOURCES = Object.freeze(["screen", "camera"]);
  const LIMITS = Object.freeze({
    context: Object.freeze({ dimension: 640, quality: .58, maxChars: 1_700_000 }),
    look: Object.freeze({ dimension: 1600, quality: .82, maxChars: 5_500_000 }),
  });
  const defaultClock = () => Date.now();

  function fitSize(width, height, dimension, upscale = false) {
    const scale = Math.min(upscale ? Infinity : 1, dimension / Math.max(1, width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  function validFrame(frame, source, detail) {
    const maximum = LIMITS[detail]?.maxChars || 0;
    return !!frame && frame.source === source && frame.detail === detail &&
      Number.isFinite(frame.capturedAt) && frame.capturedAt > 0 &&
      Number.isFinite(frame.width) && frame.width > 0 && Number.isFinite(frame.height) && frame.height > 0 &&
      typeof frame.dataUrl === "string" && frame.dataUrl.length <= maximum &&
      /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(frame.dataUrl);
  }

  function abort(signal) {
    if (signal?.aborted) throw signal.reason || new DOMException("Stopped", "AbortError");
  }

  class BrowserCamera {
    constructor(stream, video, documentRef) {
      this.stream = stream;
      this.video = video;
      this.document = documentRef;
    }
    static async open({ mediaDevices = navigator.mediaDevices, documentRef = document } = {}) {
      if (!mediaDevices?.getUserMedia) throw new Error("Camera access is unavailable in this desktop build.");
      const stream = await mediaDevices.getUserMedia({ audio: false, video: {
        width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 }, frameRate: { ideal: 5, max: 15 },
      } });
      const video = documentRef.createElement("video");
      video.muted = true; video.playsInline = true; video.autoplay = true; video.srcObject = stream;
      try {
        await Promise.race([
          Promise.resolve(video.play()),
          new Promise((_, reject) => setTimeout(() => reject(new Error("The camera did not start in time.")), 8000)),
        ]);
        if (!video.videoWidth || !video.videoHeight) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("The camera did not provide a picture.")), 8000);
            const ready = () => { clearTimeout(timer); resolve(); };
            if (video.readyState >= 1) ready();
            else video.addEventListener("loadedmetadata", ready, { once: true });
          });
        }
        if (!video.videoWidth || !video.videoHeight) throw new Error("The camera did not provide a picture.");
        return new BrowserCamera(stream, video, documentRef);
      } catch (error) {
        stream.getTracks().forEach(track => track.stop());
        video.srcObject = null;
        throw error;
      }
    }
    capture(detail = "context", now = defaultClock) {
      const preset = LIMITS[detail];
      if (!preset) throw new Error("Unknown camera detail.");
      const sourceWidth = this.video.videoWidth, sourceHeight = this.video.videoHeight;
      if (!sourceWidth || !sourceHeight) throw new Error("The camera frame is unavailable.");
      const { width, height } = fitSize(sourceWidth, sourceHeight, preset.dimension);
      const canvas = this.document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("The camera frame could not be prepared.");
      context.drawImage(this.video, 0, 0, width, height);
      const frame = { source: "camera", detail, capturedAt: now(), width, height, dataUrl: canvas.toDataURL("image/jpeg", preset.quality) };
      if (!validFrame(frame, "camera", detail)) throw new Error("The camera returned an invalid or oversized frame.");
      return frame;
    }
    stop() {
      this.stream?.getTracks?.().forEach(track => track.stop());
      this.video?.pause?.();
      if (this.video) this.video.srcObject = null;
      this.stream = null;
    }
  }

  class Controller {
    constructor({ bridge, cameraFactory = () => BrowserCamera.open(), onChange = () => {}, onError = () => {},
      clock = defaultClock, setTimer = setTimeout, clearTimer = clearTimeout, sampleMs = 1000, freshMs = 2500, frameLimit = 6 } = {}) {
      this.bridge = bridge;
      this.cameraFactory = cameraFactory;
      this.onChange = onChange;
      this.onError = onError;
      this.clock = clock;
      this.setTimer = (fn, ms) => Reflect.apply(setTimer, globalThis, [fn, ms]);
      this.clearTimer = timer => Reflect.apply(clearTimer, globalThis, [timer]);
      this.sampleMs = Math.max(500, Math.min(5000, sampleMs));
      this.freshMs = Math.max(this.sampleMs, Math.min(10000, freshMs));
      this.frameLimit = Math.max(1, Math.min(12, frameLimit));
      this.states = Object.fromEntries(SOURCES.map(source => [source, {
        source, enabled: false, model: null, destination: null, label: null, frames: [], camera: null,
        timer: null, pending: null, generation: 0,
      }]));
    }

    available() {
      return !!(this.bridge?.eyesModel && this.bridge?.eyesEnable && this.bridge?.eyesValidate && this.bridge?.eyesStop && this.bridge?.eyesCapture);
    }

    snapshot() {
      const sources = SOURCES.filter(source => this.states[source].enabled).map(source => ({
        source, model: this.states[source].model, destination: this.states[source].destination, label: this.states[source].label,
      }));
      return Object.freeze({ available: this.available(), active: sources.length > 0, sources: Object.freeze(sources) });
    }

    emit() { const value = this.snapshot(); this.onChange(value); return value; }

    async capability(model) {
      if (!this.available()) return { available: false, vision: false, reason: "KAI Eyes needs the installed desktop app." };
      try { return { available: true, ...(await this.bridge.eyesModel(model)) }; }
      catch (error) { return { available: true, vision: false, reason: error.message }; }
    }

    async enable(source, model) {
      if (!SOURCES.includes(source)) throw new Error("Unknown KAI Eyes source.");
      if (!this.available()) throw new Error("KAI Eyes needs the installed desktop app.");
      const state = this.states[source];
      if (state.enabled && state.model === model) return this.snapshot();
      await this.disable(source);
      const generation = ++state.generation;
      let grant;
      try {
        grant = await this.bridge.eyesEnable(source, model);
        if (generation !== state.generation) { await this.bridge.eyesStop(source).catch(() => {}); return this.snapshot(); }
        if (!grant?.enabled) return this.emit();
        if (source === "camera") state.camera = await this.cameraFactory();
        if (generation !== state.generation) {
          state.camera?.stop?.(); state.camera = null;
          await this.bridge.eyesStop(source).catch(() => {}); return this.snapshot();
        }
        Object.assign(state, { enabled: true, model, destination: grant.destination, label: grant.label });
        await this.sample(source, generation);
        if (generation !== state.generation || !state.enabled) return this.snapshot();
        this.schedule(source, generation);
        return this.emit();
      } catch (error) {
        if (generation === state.generation) {
          await this.disable(source);
          if (grant?.enabled) await this.bridge.eyesStop(source).catch(() => {});
        }
        if (error.name !== "AbortError") this.onError(error, source);
        throw error;
      }
    }

    async disable(source, notify = true) {
      if (!SOURCES.includes(source)) return this.snapshot();
      const state = this.states[source], wasActive = state.enabled || state.camera || state.pending;
      state.generation++;
      if (state.timer) this.clearTimer(state.timer);
      state.timer = null; state.enabled = false; state.model = null; state.destination = null; state.label = null; state.frames = [];
      state.camera?.stop?.(); state.camera = null; state.pending = null;
      if (wasActive) await this.bridge?.eyesStop?.(source).catch(() => {});
      return notify ? this.emit() : this.snapshot();
    }

    async stopAll() {
      for (const source of SOURCES) await this.disable(source, false);
      await this.bridge?.eyesStop?.().catch(() => {});
      return this.emit();
    }

    schedule(source, generation) {
      const state = this.states[source];
      if (!state.enabled || state.generation !== generation) return;
      if (state.timer) this.clearTimer(state.timer);
      state.timer = this.setTimer(async () => {
        state.timer = null;
        if (!state.enabled || state.generation !== generation) return;
        try { await this.sample(source, generation); }
        catch (error) {
          if (state.generation === generation) {
            await this.disable(source);
            if (error.name !== "AbortError") this.onError(error, source);
          }
          return;
        }
        this.schedule(source, generation);
      }, this.sampleMs);
    }

    async sample(source, generation = this.states[source]?.generation) {
      const state = this.states[source];
      if (!state?.enabled || state.generation !== generation) throw new DOMException("Stopped", "AbortError");
      if (state.pending) return state.pending;
      state.pending = Promise.resolve().then(async () => {
        const frame = source === "screen"
          ? await this.bridge.eyesCapture(state.model, "context")
          : state.camera.capture("context", this.clock);
        if (!validFrame(frame, source, "context")) throw new Error(`KAI received an invalid ${source} frame.`);
        if (!state.enabled || state.generation !== generation) throw new DOMException("Stopped", "AbortError");
        state.frames.push(Object.freeze({ ...frame }));
        if (state.frames.length > this.frameLimit) state.frames.splice(0, state.frames.length - this.frameLimit);
        return frame;
      }).finally(() => { if (state.generation === generation) state.pending = null; });
      return state.pending;
    }

    async context(model, signal) {
      abort(signal);
      const active = SOURCES.map(source => this.states[source]).filter(state => state.enabled);
      if (!active.length) return [];
      if (active.some(state => state.model !== model)) {
        await this.stopAll();
        throw new Error("KAI Eyes turned off because the selected brain changed. Turn it on again for this brain.");
      }
      try { await Promise.all(active.map(state => this.bridge.eyesValidate(state.source, model))); }
      catch (error) { await this.stopAll(); throw error; }
      abort(signal);
      await Promise.all(active.map(async state => {
        const latest = state.frames.at(-1);
        if (!latest || this.clock() - latest.capturedAt > this.freshMs) await this.sample(state.source, state.generation);
      }));
      abort(signal);
      return active.map(state => state.frames.at(-1)).filter(Boolean).map(frame => Object.freeze({ ...frame }));
    }

    async look(source, model, signal) {
      if (!SOURCES.includes(source)) throw new Error("Choose screen or camera for a closer look.");
      const state = this.states[source];
      if (!state.enabled || state.model !== model) throw new Error(`Turn on ${source} vision before asking KAI to look closer.`);
      abort(signal);
      await this.bridge.eyesValidate(source, model);
      const frame = source === "screen"
        ? await this.bridge.eyesCapture(model, "look")
        : state.camera.capture("look", this.clock);
      abort(signal);
      if (!validFrame(frame, source, "look")) throw new Error(`KAI received an invalid high-detail ${source} frame.`);
      return Object.freeze({ ...frame });
    }
  }

  return { Controller, BrowserCamera, SOURCES, LIMITS, fitSize, validFrame };
});
