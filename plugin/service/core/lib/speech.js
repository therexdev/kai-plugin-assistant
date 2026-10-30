"use strict";
const fs = require("fs"), path = require("path");
const { Worker } = require("worker_threads");
const { EventEmitter } = require("events");
const { downloadFile } = require("./download");
const catalog = require("../runtimes/kokoro.json");
const VOICES = Object.freeze([
  { id: "af_heart", name: "Heart · warm & friendly" },
  { id: "af_bella", name: "Bella · bright & playful" },
  { id: "am_puck", name: "Puck · easygoing" },
  { id: "bf_emma", name: "Emma · soft British" },
]);
// In Electron, keep native speech inference in its own process. A native
// engine crash must not take down Core or the earning app. Utility processes
// also understand packaged ASAR paths, unlike ordinary Node worker loaders.
class DesktopSpeechWorker extends EventEmitter {
  constructor(file, { workerData }) {
    super();
    this.child = require("electron").utilityProcess.fork(file, [], {
      serviceName: "KAI local voice",
      env: { ...process.env, KAI_SPEECH_MODEL_DIR: workerData.modelDir, KAI_SPEECH_RUNTIME: workerData.runtime },
    });
    this.child.on("message", value => this.emit("message", value));
    this.child.on("exit", code => this.emit("exit", code));
    this.child.on("error", () => this.emit("error", new Error("KAI's voice process stopped unexpectedly.")));
  }
  postMessage(value) { this.child.postMessage(value); }
  terminate() { this.child.kill(); return Promise.resolve(); }
}
const DefaultWorker = process.versions.electron && process.type === "browser" ? DesktopSpeechWorker : Worker;
class SpeechManager {
  constructor({ speechDir, download = downloadFile, WorkerClass = DefaultWorker }) {
    this.dir = path.join(speechDir, catalog.revision);
    this.download = download; this.Worker = WorkerClass;
    this.worker = null; this.pending = null; this.serial = 0; this.idle = null;
    this.runtime = "native"; this.engineError = null;
    this.setup = { state: "idle" }; this.installing = null; this.closed = false;
  }
  available() {
    return catalog.files.every(f => {
      try { return fs.statSync(path.join(this.dir, f.path)).size === f.sizeBytes; } catch { return false; }
    });
  }
  status() {
    return { available: this.available() && this.setup.state !== "error" && !this.engineError, modelPresent: this.available(), runtime: this.runtime, installable: ["win32", "darwin", "linux"].includes(process.platform) && ["x64", "arm64"].includes(process.arch),
      downloadBytes: catalog.files.reduce((n, f) => n + f.sizeBytes, 0), voices: VOICES, setup: this.setup };
  }
  ensure() {
    if (this.closed) return Promise.reject(new Error("KAI is shutting down."));
    if (this.installing) return this.installing;
    this.installing = this._ensure().finally(() => { this.installing = null; });
    return this.installing;
  }
  async _ensure() {
    this.setup = { state: "downloading", pct: 0 };
    this.downloadAbort = new AbortController();
    try {
      let done = 0;
      const total = this.status().downloadBytes;
      for (const file of catalog.files) {
        const dest = path.join(this.dir, file.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        let exists = false;
        try {
          if (fs.statSync(dest).size === file.sizeBytes) {
            const hash = require("crypto").createHash("sha256");
            for await (const chunk of fs.createReadStream(dest)) hash.update(chunk);
            exists = hash.digest("hex") === file.sha256;
          }
        } catch { /* new install */ }
        if (!exists) await this.download(file.url, dest, { sha256: file.sha256, sizeBytes: file.sizeBytes,
          signal: this.downloadAbort.signal,
          onProgress: p => { this.setup = { state: "downloading", pct: Math.min(100, Math.floor((done + p.done) / total * 100)) }; },
        });
        done += file.sizeBytes;
      }
      this.setup = { state: "loading" };
      await this._request({});
      this.setup = { state: "done" };
    } catch (error) { this.setup = { state: "error", error: String(error.message || error) }; throw error; }
    finally { this.downloadAbort = null; }
  }
  async generate({ text, voice = "af_heart", signal } = {}) {
    if (typeof text !== "string" || !text.trim() || text.length > 240) throw new Error("Speak one short phrase at a time (up to 240 characters).");
    if (!VOICES.some(v => v.id === voice)) throw new Error("Unknown KAI voice.");
    if (!this.available()) throw new Error("Natural voice is not set up.");
    if (this.warming) {
      if (signal?.aborted) throw new Error("Speech cancelled.");
      let abort;
      try {
        await Promise.race([this.warming, new Promise((resolve, reject) => {
          abort = () => reject(new Error("Speech cancelled."));
          signal?.addEventListener("abort", abort, { once: true });
        })]);
      } finally { signal?.removeEventListener("abort", abort); }
    }
    return this._request({ text, voice }, signal);
  }
  warm() {
    if (this.closed) return Promise.reject(new Error("KAI is shutting down."));
    if (!this.available()) return Promise.reject(new Error("Natural voice is not set up."));
    if (this.engineError) return Promise.reject(new Error(this.engineError));
    if (this.warming) return this.warming;
    // A visible companion renews this two-minute lease while voice replies
    // are enabled. Refresh it without running inference or downloading files.
    // Hide/off/quit stops renewal, so the idle process still releases memory.
    if (this.worker || this.pending) {
      if (!this.pending) this._idle();
      return Promise.resolve();
    }
    this.warming = this._request({}).finally(() => { this.warming = null; });
    return this.warming;
  }
  _request(value, signal) {
    if (this.closed) return Promise.reject(new Error("KAI is shutting down."));
    if (signal?.aborted) return Promise.reject(new Error("Speech cancelled."));
    if (this.pending) return Promise.reject(new Error("KAI's voice is busy. Try again in a moment."));
    clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      let timer;
      const request = { id: ++this.serial };
      const active = () => this.pending === request;
      const finish = callback => result => {
        if (!active()) return;
        clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending = null;
        this._idle(); callback(result);
      };
      request.resolve = finish(resolve); request.reject = finish(reject);
      const abort = () => { request.reject(new Error("Speech cancelled.")); this.reset(); };
      const fail = error => {
        if (!active()) return;
        clearTimeout(timer); this.reset();
        // Retain the same pending request and cancellation listener across
        // recovery, so Stop/close cannot resurrect a phrase in a new worker.
        if (this.runtime === "native" && !this.closed && !signal?.aborted) {
          console.warn("[speech] Native voice failed; retrying locally with WebAssembly:", error.message);
          this.runtime = "wasm";
          start();
        } else {
          console.warn("[speech] Compatible voice failed:", error.message);
          this.engineError = "KAI's natural voice couldn't start. Try setting it up again. Your downloaded voices will be reused.";
          request.reject(new Error(this.engineError));
        }
      };
      const start = () => {
        if (!active()) return;
        timer = setTimeout(() => fail(new Error("Voice engine timed out.")), this.runtime === "wasm" ? 180000 : 90000);
        try {
          if (!this.worker) {
            const worker = this.worker = new this.Worker(path.join(__dirname, "speech-worker.js"), {
              workerData: { modelDir: this.dir, runtime: this.runtime },
            });
            worker.on("message", result => {
              if (this.worker !== worker || result.id !== this.pending?.id) return;
              if (result.error) this.pending.fail(new Error(result.error));
              else { this.engineError = null; this.pending.resolve(result.wav ? Buffer.from(result.wav) : null); }
            });
            worker.on("error", error => { if (this.worker === worker) this.pending?.fail(error); });
            worker.on("exit", () => { if (this.worker === worker) {
              if (this.pending) this.pending.fail(new Error("KAI's voice engine stopped."));
              else this.reset();
            } });
          }
          this.worker.postMessage({ id: request.id, ...value });
        } catch (error) { fail(error); }
      };
      request.fail = fail; this.pending = request;
      signal?.addEventListener("abort", abort, { once: true });
      start();
    });
  }

  _idle() { clearTimeout(this.idle); this.idle = setTimeout(() => this.reset(), 120000); this.idle.unref?.(); }
  reset() { clearTimeout(this.idle); const worker = this.worker; this.worker = null; worker?.terminate().catch(() => {}); }
  close() { this.closed = true; this.downloadAbort?.abort(); this.pending?.reject(new Error("KAI is shutting down.")); this.reset(); }
}
module.exports = { SpeechManager, VOICES };
