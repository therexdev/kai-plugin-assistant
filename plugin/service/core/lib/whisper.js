"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { downloadFile } = require("./download");
// The whisper.cpp zips ship the same ggml loader as llama.cpp — with the
// same field-crash surface: CPU-variant DLLs mis-probing on very new hybrid
// CPUs (Arrow Lake, v0.22.x finding), the MSVC runtime beside-copy dance,
// and clang-libomp topology faults. Reuse the battle-tested guards.
const { engineEnv, ensureCrtBeside, stripCpuVariants } = require("./runtimes/llamacpp");

/*
 * Voice input (§5 one-click, §7 privacy: audio NEVER leaves the machine).
 * One-shot transcription: the UI records push-to-talk audio, downsamples to
 * 16 kHz mono WAV in the renderer, POSTs it to /core/transcribe; Core runs
 * whisper-cli over the file and returns the text. No always-on process, no
 * port, no egress — works identically in Local-Only mode.
 *
 * Engine + model arrive like every other engine/model: versioned and
 * sha256-pinned in core/runtimes/catalog.json (§27, fail-closed), fetched on
 * the user's first "set up voice input". KAI_WHISPER_BIN / KAI_WHISPER_MODEL
 * override for power users and tests.
 */

const TRANSCRIBE_TIMEOUT_MS = 120000;
const MAX_WAV_BYTES = 10 * 1024 * 1024; // ~5 min of 16k mono 16-bit

/** Run whisper-cli once over a WAV file; resolve with the plain text. */
function transcribeWav({ binPath, modelPath, wavPath, timeoutMs = TRANSCRIBE_TIMEOUT_MS, signal }) {
  return new Promise((resolve, reject) => {
    // --no-timestamps: stdout is the transcription lines and nothing else;
    // banner/perf chatter goes to stderr on every build we ship.
    ensureCrtBeside(binPath); // MSVC runtime beside the exe (win32 no-op elsewhere)
    const child = spawn(binPath, ["-m", modelPath, "-f", wavPath, "--no-timestamps", "-t", "2"], {
      windowsHide: true,
      cwd: path.dirname(binPath), // whisper.cpp zips keep DLLs beside the exe
      env: engineEnv(binPath), // KMP guards + LD_LIBRARY_PATH (llama field lessons)
      timeout: timeoutMs,
      signal,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err = (err + c).slice(-2000)));
    let failure;
    child.on("error", e => { failure = e; });
    child.on("close", (code) => {
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`voice engine exited ${code}: ${err.slice(-300)}`));
      const text = out
        .replace(/\r/g, "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ")
        .trim();
      resolve(text);
    });
  });
}

/** 64 hex chars = a real pin; anything else (PENDING) fails closed. */
function pinned(sha) {
  return typeof sha === "string" && /^[0-9a-f]{64}$/i.test(sha);
}

class VoiceManager {
  constructor({ provisioner, catalogPath, voiceDir, onEvent }) {
    this.provisioner = provisioner || null; // null when KAI_LLAMA_BIN forces llama — voice then needs KAI_WHISPER_BIN
    this.voiceDir = voiceDir;
    this.onEvent = onEvent || (() => {});
    this._setup = null; // {state:"running"|"done"|"error", error?}
    let cat = null;
    try {
      cat = JSON.parse(fs.readFileSync(catalogPath, "utf8")).whisper || null;
    } catch {
      /* no catalog — env overrides only */
    }
    this.catalog = cat;
    this.model = cat?.models?.["base-en"] || null;
  }

  _envBin() {
    return process.env.KAI_WHISPER_BIN || null;
  }

  _envModel() {
    return process.env.KAI_WHISPER_MODEL || null;
  }

  /** Engine binary path if it exists locally (no downloads here). */
  _binPath() {
    const forced = this._envBin();
    if (forced) return fs.existsSync(forced) ? forced : null;
    if (!this.provisioner || !this.catalog) return null;
    try {
      const p = this.provisioner.installedBinPath("whisper");
      return fs.existsSync(p) ? p : null;
    } catch {
      return null; // no build for this platform
    }
  }

  _modelPath() {
    const forced = this._envModel();
    if (forced) return fs.existsSync(forced) ? forced : null;
    if (!this.model) return null;
    const p = path.join(this.voiceDir, this.model.filename);
    return fs.existsSync(p) ? p : null;
  }

  /** Can this platform ever get voice from the catalog (pins published)? */
  _installable() {
    if (this._envBin()) return true;
    if (!this.provisioner || !this.catalog) return false;
    let build;
    try {
      build = this.provisioner.selectBuild("whisper");
    } catch {
      return false;
    }
    return pinned(build.sha256) && pinned(this.model?.sha256);
  }

  status() {
    const engine = !!this._binPath();
    const model = !!this._modelPath();
    return {
      available: engine && model,
      engine,
      model,
      installable: this._installable(),
      // Rough one-time download for the setup confirm dialog.
      downloadBytes: (engine ? 0 : this._buildSize()) + (model ? 0 : this.model?.sizeBytes || 0),
      setup: this._setup,
    };
  }

  _buildSize() {
    try {
      return this.provisioner?.selectBuild("whisper")?.sizeBytes || 0;
    } catch {
      return 0;
    }
  }

  /** Fetch engine + model (idempotent). Kicked by POST /core/voice/setup. */
  async ensure({ signal } = {}) {
    signal?.throwIfAborted();
    if (this._setup?.state === "running") return;
    this._setup = { state: "running" };
    try {
      if (!this._binPath()) {
        if (!this.provisioner) throw new Error("KAI_WHISPER_BIN not set and no provisioner available");
        await this.provisioner.ensure("whisper", { signal });
        signal?.throwIfAborted();
        // Same ggml loader as llama.cpp, same Arrow Lake variant-probe crash:
        // strip the exotic CPU-variant DLLs down to the safe baseline NOW,
        // not after a user's first transcription dies (v0.22.x field lesson).
        const bin = this._binPath();
        if (bin) stripCpuVariants(bin);
      }
      if (!this._modelPath()) {
        signal?.throwIfAborted();
        if (!this.model) throw new Error("no voice model in catalog");
        if (!pinned(this.model.sha256)) throw new Error("voice model not yet published (hash unpinned)");
        fs.mkdirSync(this.voiceDir, { recursive: true });
        const dest = path.join(this.voiceDir, this.model.filename);
        let lastPct = -1;
        await downloadFile(this.model.url, dest, {
          signal,
          sha256: this.model.sha256,
          sizeBytes: this.model.sizeBytes,
          onProgress: (p) => {
            if (p.pct !== null && p.pct !== lastPct) {
              lastPct = p.pct;
              this.onEvent({ type: "voice:model-download", ...p });
            }
          },
        });
      }
      signal?.throwIfAborted();
      this._setup = { state: "done" };
      this.onEvent({ type: "voice:ready" });
    } catch (e) {
      this._setup = { state: "error", error: String(e.message || e) };
      this.onEvent({ type: "voice:setup-failed", message: this._setup.error });
      throw e;
    }
  }

  /** Transcribe a WAV buffer; resolves to the text. */
  async transcribe(wavBuffer, { signal } = {}) {
    if (this.transcribing) throw new Error("Voice input is busy. Try again in a moment.");
    if (!wavBuffer?.length) throw new Error("empty audio");
    if (wavBuffer.length > MAX_WAV_BYTES) throw new Error("recording too long — keep it under ~5 minutes");
    const binPath = this._binPath();
    const modelPath = this._modelPath();
    if (!binPath || !modelPath) throw new Error("voice input is not set up");
    const wavPath = path.join(os.tmpdir(), `kai-voice-${process.pid}-${Date.now()}.wav`);
    fs.writeFileSync(wavPath, wavBuffer);
    this.transcribing = true;
    try {
      const t0 = Date.now();
      const text = await transcribeWav({ binPath, modelPath, wavPath, signal });
      return { text, ms: Date.now() - t0 };
    } finally {
      try { fs.rmSync(wavPath, { force: true }); } finally { this.transcribing = false; }
    }
  }
}

module.exports = { VoiceManager, transcribeWav, MAX_WAV_BYTES };
