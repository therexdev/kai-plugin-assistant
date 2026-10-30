"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { fork } = require("child_process");
const { downloadFile } = require("../core/lib/download");
const catalog = require("../core/runtimes/pocket.json");
const stopped = () => Object.assign(new Error("Pocket voice stopped."), { name: "AbortError" });
function validate(request) {
  if (!request || !catalog.voices.some(v => v.id === request.voice)) throw new Error("Choose a Pocket voice from the list.");
  const text = request.text;
  if (text !== undefined && (typeof text !== "string" || !text.trim() || text.length > 1200)) throw new Error("Speak one sentence at a time.");
  // This tested bundle is English-only. Preserve chat, never switch engines silently.
  if (text && /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Devanagari}]/u.test(text)) {
    throw new Error("Pocket voices in this trial speak English. Choose an installed voice for this language in Voice & listening.");
  }
  return { text, voice: request.voice };
}
class PocketVoice {
  constructor({ dir, download = downloadFile, workerFactory, idleMs = 120000, timeoutMs = 120000 } = {}) {
    this.dir = path.join(dir, catalog.revision); this.download = download; this.workerFactory = workerFactory;
    this.idleMs = idleMs; this.timeoutMs = timeoutMs; this.sequence = 0; this.setup = { state: "idle" };
  }
  status() {
    const supported = ["win32", "linux"].includes(process.platform) && process.arch === "x64";
    const available = catalog.files.every(f => { try { return fs.statSync(path.join(this.dir, f.path)).size === f.sizeBytes; } catch { return false; } });
    return { supported, available, defaultVoice: catalog.defaultVoice, voices: catalog.voices, downloadBytes: catalog.files.reduce((n, f) => n + f.sizeBytes, 0), setup: this.setup };
  }
  async ensure() {
    if (this.installing) return this.installing;
    if (!this.status().supported) throw new Error("Pocket voice is not available on this computer.");
    const controller = this.downloadAbort = new AbortController();
    this.installing = (async () => {
      this.setup = { state: "downloading", pct: 0 }; let completed = 0;
      const total = catalog.files.reduce((n, f) => n + f.sizeBytes, 0);
      for (const file of catalog.files) {
        controller.signal.throwIfAborted();
        const dest = path.join(this.dir, file.path); fs.mkdirSync(path.dirname(dest), { recursive: true });
        let valid = false;
        try { valid = fs.statSync(dest).size === file.sizeBytes && crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex") === file.sha256; } catch {}
        if (!valid) await this.download(file.url, dest, { ...file, signal: controller.signal,
          onProgress: ({ done }) => { this.setup = { state: "downloading", pct: Math.min(99, Math.round((completed + done) / total * 100)) }; } });
        completed += file.sizeBytes;
      }
      controller.signal.throwIfAborted(); this.setup = { state: "done", pct: 100 };
    })().catch(error => { this.setup = { state: "error", error: error.name === "AbortError" ? "Download paused. Click Download Pocket voices to resume." : error.message }; throw error; })
      .finally(() => { this.installing = null; this.downloadAbort = null; });
    return this.installing;
  }
  createWorker() {
    if (this.workerFactory) return this.workerFactory(this.dir);
    const filename = path.join(__dirname, "pocket-voice-worker.js");
    if (process.versions.electron && process.type === "browser") {
      return require("electron").utilityProcess.fork(filename, [], { serviceName: "KAI Pocket voice", env: { ...process.env, KAI_POCKET_DIR: this.dir } });
    }
    const child = fork(filename, [], { env: { ...process.env, KAI_POCKET_DIR: this.dir }, serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"] });
    child.postMessage = value => child.send(value); return child;
  }
  lease() { clearTimeout(this.idle); this.idle = setTimeout(() => { if (!this.pending) this.cancel(); else this.lease(); }, this.idleMs); this.idle.unref?.(); }
  async warm(voice = catalog.defaultVoice) {
    validate({ voice }); this.lease();
    if (this.pending) return;
    return this.request({ voice });
  }
  async generate(request, onChunk) {
    const clean = validate(request);
    if (!clean.text) throw new Error("Pocket voice needs text.");
    if (this.pending?.warming) await this.pending.promise;
    if (this.pending) throw new Error("Pocket voice is already preparing a sentence.");
    return this.request(clean, onChunk);
  }
  request(request, onChunk) {
    if (!this.status().available) return Promise.reject(new Error("Download Pocket voices in Voice & listening first."));
    this.lease();
    if (!this.worker) {
      const worker = this.worker = this.createWorker();
      worker.on("message", message => {
        if (worker !== this.worker || message.id !== this.pending?.id) return;
        const pending = this.pending;
        if (message.error) return this.fail(new Error(message.error));
        if (message.done) { clearTimeout(pending.timer); this.pending = null; pending.resolve(message.stats); this.lease(); return; }
        if (!pending.onChunk) return;
        const samples = message.samples;
        if (!(samples instanceof Float32Array) || message.rate !== 24000 || message.seq !== pending.seq++ ||
          samples.length > 24000 * 10 || (pending.samples += samples.length) > 24000 * 120 || !samples.every(Number.isFinite)) {
          return this.fail(new Error("Pocket voice returned invalid audio."));
        }
        try { pending.onChunk(message); } catch (error) { this.fail(error); }
      });
      worker.on("error", () => { if (worker === this.worker) this.fail(new Error("Pocket's local engine could not load. Retry setup or choose another voice.")); });
      worker.on("exit", () => { if (worker === this.worker) this.fail(new Error("Pocket's local engine stopped. Please try again.")); });
    }
    const id = ++this.sequence;
    const promise = new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject, onChunk, warming: !request.text, seq: 0, samples: 0,
        timer: setTimeout(() => this.fail(new Error("Pocket voice took too long. Try another voice.")), this.timeoutMs) };
    });
    this.pending.promise = promise;
    this.worker.postMessage({ id, ...request });
    return promise;
  }
  fail(error) { const pending = this.pending; this.pending = null; clearTimeout(pending?.timer); this.cancel(); pending?.reject(error); }
  cancel() {
    clearTimeout(this.idle); const worker = this.worker; this.worker = null;
    const pending = this.pending; this.pending = null; clearTimeout(pending?.timer); pending?.reject(stopped());
    if (worker?.kill) worker.kill(); else worker?.terminate();
  }
  close() { this.downloadAbort?.abort(); this.cancel(); }
}
module.exports = { PocketVoice, validate };
