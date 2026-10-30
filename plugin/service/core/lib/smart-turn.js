"use strict";

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { Worker } = require("worker_threads");
const catalog = require("../runtimes/smart-turn.json");

const SAMPLE_RATE = 16000;
const WINDOW_SAMPLES = SAMPLE_RATE * 8;

function decodeWav16kMono(value) {
  const wav = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Smart-Turn needs a WAV recording.");
  }
  let format = null, data = null, offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + size;
    if (end > wav.length) throw new Error("The WAV recording is truncated.");
    if (id === "fmt " && size >= 16) {
      format = {
        code: wav.readUInt16LE(start), channels: wav.readUInt16LE(start + 2),
        sampleRate: wav.readUInt32LE(start + 4), blockAlign: wav.readUInt16LE(start + 12), bits: wav.readUInt16LE(start + 14),
      };
    } else if (id === "data") data = { start, size };
    offset = end + (size & 1);
  }
  if (!format || !data) throw new Error("The WAV recording is missing audio data.");
  if (format.code !== 1 || format.channels !== 1 || format.sampleRate !== SAMPLE_RATE || format.bits !== 16 || format.blockAlign !== 2) {
    throw new Error("Smart-Turn expects 16 kHz mono 16-bit PCM WAV audio.");
  }
  const total = Math.floor(data.size / 2);
  if (!total) throw new Error("The WAV recording is empty.");
  const count = Math.min(total, WINDOW_SAMPLES);
  const first = total - count;
  const audio = new Float32Array(count);
  for (let i = 0; i < count; i++) audio[i] = wav.readInt16LE(data.start + (first + i) * 2) / 32768;
  return audio;
}

class DesktopSmartTurnWorker extends EventEmitter {
  constructor(file, { workerData }) {
    super();
    this.child = require("electron").utilityProcess.fork(file, [], {
      serviceName: "KAI semantic turn detector",
      env: { ...process.env, KAI_SMART_TURN_MODEL: workerData.modelPath },
    });
    this.child.on("message", value => this.emit("message", value));
    this.child.on("exit", code => this.emit("exit", code));
    this.child.on("error", () => this.emit("error", new Error("KAI's semantic turn detector stopped unexpectedly.")));
  }
  postMessage(value) { this.child.postMessage(value); }
  terminate() { this.child.kill(); return Promise.resolve(); }
}

const DefaultWorker = process.versions.electron && process.type === "browser" ? DesktopSmartTurnWorker : Worker;

function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error("Turn detection cancelled."));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error("Turn detection cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

class SmartTurnManager {
  constructor({ modelPath, WorkerClass = DefaultWorker, idleMs = 120000, timeoutMs = 12000 } = {}) {
    this.modelPath = modelPath;
    this.Worker = WorkerClass;
    this.idleMs = idleMs;
    this.timeoutMs = timeoutMs;
    this.worker = null;
    this.pending = null;
    this.warming = null;
    this.idle = null;
    this.serial = 0;
    this.ready = false;
    this.closed = false;
    this.engineError = null;
  }
  available() {
    try { return fs.statSync(this.modelPath).size === catalog.file.sizeBytes; } catch { return false; }
  }
  status() {
    return {
      available: this.available(), modelPresent: this.available(), ready: this.ready && !!this.worker,
      engine: catalog.engine, local: true, error: this.engineError,
    };
  }
  warm({ signal } = {}) {
    if (this.closed) return Promise.reject(new Error("KAI is shutting down."));
    if (!this.available()) return Promise.reject(new Error("Smart-Turn model is unavailable."));
    if (this.ready && this.worker) { this._idle(); return Promise.resolve(this.status()); }
    if (!this.warming) {
      this.warming = this._request({ type: "warm" }, signal)
        .then(() => { this.ready = true; this.engineError = null; return this.status(); })
        .finally(() => { this.warming = null; });
    }
    return this.warming;
  }
  async analyze(wav, { signal } = {}) {
    if (this.closed) throw new Error("KAI is shutting down.");
    if (!this.available()) throw new Error("Smart-Turn model is unavailable.");
    if (this.warming) await waitFor(this.warming, signal);
    const audio = decodeWav16kMono(wav);
    const result = await this._request({ type: "analyze", audio }, signal, [audio.buffer]);
    this.ready = true;
    this.engineError = null;
    return { engine: catalog.engine, available: true, probability: result.probability, ms: result.ms };
  }
  _request(message, signal, transfer) {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error("Turn detection cancelled."));
    if (this.pending) return Promise.reject(new Error("Smart-Turn is busy."));
    clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      let timer;
      const request = { id: ++this.serial };
      const active = () => this.pending === request;
      const finish = callback => value => {
        if (!active()) return;
        clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending = null;
        this._idle(); callback(value);
      };
      request.resolve = finish(resolve);
      request.reject = finish(reject);
      const abort = () => { request.reject(signal.reason || new Error("Turn detection cancelled.")); this.reset(); };
      const fail = error => {
        if (!active()) return;
        this.engineError = String(error.message || error);
        this.ready = false;
        this.reset();
        request.reject(error instanceof Error ? error : new Error(String(error)));
      };
      request.fail = fail;
      this.pending = request;
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => fail(new Error("Smart-Turn inference timed out.")), this.timeoutMs);
      timer.unref?.();
      try {
        if (!this.worker) {
          const worker = this.worker = new this.Worker(path.join(__dirname, "smart-turn-worker.js"), {
            workerData: { modelPath: this.modelPath },
          });
          worker.on("message", result => {
            if (this.worker !== worker || result.id !== this.pending?.id) return;
            if (result.error) this.pending.fail(new Error(result.error));
            else this.pending.resolve(result);
          });
          worker.on("error", error => { if (this.worker === worker) this.pending?.fail(error); });
          worker.on("exit", () => {
            if (this.worker !== worker) return;
            if (this.pending) this.pending.fail(new Error("Smart-Turn worker stopped."));
            else this.reset();
          });
        }
        this.worker.postMessage({ id: request.id, ...message }, transfer);
      } catch (error) { fail(error); }
    });
  }
  _idle() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.reset(), this.idleMs);
    this.idle.unref?.();
  }
  reset() {
    clearTimeout(this.idle);
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    worker?.terminate().catch(() => {});
  }
  close() {
    this.closed = true;
    this.pending?.reject(new Error("KAI is shutting down."));
    this.reset();
  }
}

module.exports = { SmartTurnManager, decodeWav16kMono, SAMPLE_RATE, WINDOW_SAMPLES };
