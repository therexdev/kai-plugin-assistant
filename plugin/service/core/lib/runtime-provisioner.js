"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const { downloadFile } = require("./download");
const { extractZipAsync } = require("./zip");

/** Extract a .tar.gz via the system tar (universal on the Linux/macOS
 *  machines these archives target; Windows builds stay zips). Async spawn —
 *  never blocks the app process. */
function extractTarGzAsync(file, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const child = require("child_process").spawn("tar", ["-xzf", file, "-C", destDir], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => reject(new Error(`tar unavailable: ${e.message}`)));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${err.slice(0, 200)}`))));
  });
}

/** Streaming sha256 of a file — never loads it whole. */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = require("crypto").createHash("sha256");
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

/*
 * Runtime provisioner: fetches the right inference-engine build for this
 * machine exactly like a model package — versioned, hash-pinned, fail-closed
 * (§27) — so onboarding's one click covers model AND engine (§5: everything
 * handled automatically). Build selection: platform-arch-capability, with a
 * CPU fallback when no matching GPU build exists.
 */

class RuntimeProvisioner {
  constructor({ catalogPath, runtimesDir, hardware, onEvent }) {
    this.catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    this.runtimesDir = runtimesDir;
    this.hardware = hardware;
    this.onEvent = onEvent || (() => {});
    this._active = null; // in-flight provision promise
    this._progress = null;
  }

  downloadProgress() {
    return this._active ? this._progress : null;
  }

  /** Which build entry this machine gets, or throw with a clear reason. */
  selectBuild(kind, { cap } = {}) {
    const rt = this.catalog[kind];
    if (!rt) throw new Error(`Unknown runtime kind: ${kind}`);
    // NVIDIA → CUDA. Modern Intel/AMD GPUs (Arc, Iris Xe, Radeon) → Vulkan.
    // macOS → Metal. Conservative detection keeps unknown desktop GPUs on
    // CPU, while every supported Mac has a Metal-capable graphics device.
    if (!cap) {
      if (this.hardware?.capabilities?.cudaEligible) cap = "cuda";
      else if ((this.hardware?.gpus || []).some((g) => /\b(arc|iris xe|radeon|rx \d{3,4})\b/i.test(String(g.name || "")))) cap = "vulkan";
      else if (this.hardware?.capabilities?.metalEligible) cap = "metal";
      else cap = "cpu";
    }
    const keys = [`${process.platform}-${process.arch}-${cap}`, `${process.platform}-${process.arch}-cpu`];
    for (const key of keys) {
      if (rt.builds[key]) return { key, version: rt.version, ...rt.builds[key] };
    }
    throw new Error(
      `No ${kind} build for this machine (${keys[0]}). ` +
        "Point KAI_LLAMA_BIN at an existing llama-server binary as a workaround."
    );
  }

  installedBinPath(kind, opts) {
    const b = this.selectBuild(kind, opts);
    return path.join(this.runtimesDir, kind, b.version, b.key, ...b.binPath.split("/"));
  }

  /** Ensure the runtime binary exists locally; download + extract if not. */
  async ensure(kind, opts = {}) {
    opts.signal?.throwIfAborted();
    if (this._active) {
      if (!opts.signal) return this._active;
      // A voice setup can join an already-running model-runtime setup. Its
      // own cancellation must release its waiter without stopping that other
      // operation or keeping plugin disposal blocked behind the download.
      return new Promise((resolve, reject) => {
        const cleanup = () => opts.signal.removeEventListener("abort", abort);
        const abort = () => { cleanup(); reject(opts.signal.reason); };
        opts.signal.addEventListener("abort", abort, { once: true });
        this._active.then(value => { cleanup(); if (opts.signal.aborted) reject(opts.signal.reason); else resolve(value); }, error => { cleanup(); reject(error); });
      });
    }
    const run = this._ensure(kind, opts);
    this._active = run;
    try {
      return await run;
    } finally {
      this._active = null;
    }
  }

  async _ensure(kind, opts) {
    opts.signal?.throwIfAborted();
    const build = this.selectBuild(kind, opts);
    const bin = path.join(this.runtimesDir, kind, build.version, build.key, ...build.binPath.split("/"));
    if (fs.existsSync(bin)) return bin;

    const installDir = path.dirname(path.join(this.runtimesDir, kind, build.version, build.key, "x"));
    this.onEvent({ type: "runtime:provisioning", kind, build: build.key, version: build.version });

    // Main archive first, then companion archives (e.g. CUDA's cudart
    // runtime) — all hash-verified, all extracted into the same directory.
    const archives = [
      { url: build.url, sha256: build.sha256, sizeBytes: build.sizeBytes },
      ...(build.extras || []),
    ];
    // Big engines need room to unpack — refuse up front in plain words,
    // not halfway through with a cryptic write error.
    const needBytes = archives.reduce((s, a) => s + (a.sizeBytes || 0), 0) * 2.4;
    try {
      const free = fs.statfsSync(os.tmpdir()).bavail * fs.statfsSync(os.tmpdir()).bsize;
      if (free < needBytes) {
        throw new Error(`Setting up this engine needs ~${Math.ceil(needBytes / 1e9)} GB free disk space — free some up and try again`);
      }
    } catch (e) {
      if (String(e.message).includes("free disk space")) throw e;
      /* statfs unsupported — proceed */
    }
    for (let i = 0; i < archives.length; i++) {
      opts.signal?.throwIfAborted();
      const a = archives[i];
      // llama.cpp ships Windows builds as .zip and Linux builds as .tar.gz —
      // keep the downloaded file's real extension so extraction picks the
      // right tool (the arm64/Pi support runs on tarballs).
      const isTar = /\.t(ar\.)?gz$/i.test(String(a.url));
      const zipPath = path.join(os.tmpdir(), `kai-runtime-${kind}-${build.version}-${build.key}-${i}.${isTar ? "tar.gz" : "zip"}`);
      // A finished download that never got extracted (app closed mid-setup)
      // is reused after hash verification — nobody re-downloads gigabytes.
      const reusable = fs.existsSync(zipPath) && (await sha256File(zipPath)) === String(a.sha256).toLowerCase();
      opts.signal?.throwIfAborted();
      if (!reusable) {
        let lastPct = -1;
        await downloadFile(a.url, zipPath, {
          signal: opts.signal,
          sha256: a.sha256,
          sizeBytes: a.sizeBytes,
          onProgress: (p) => {
            this._progress = { kind, archive: i + 1, archives: archives.length, ...p };
            // Emit (and therefore log) only on whole-percent changes — the raw
            // callback fires per network chunk and would flood core.log.
            if (p.pct !== null && p.pct !== lastPct) {
              lastPct = p.pct;
              this.onEvent({ type: "runtime:download", kind, ...p });
            }
          },
        });
      }
      opts.signal?.throwIfAborted();
      // Unpacking runs off the main thread — Core shares the app's main
      // process, and a synchronous 1.4 GB extract froze the window for
      // minutes (field finding). The UI shows "Setting up engine…".
      this._progress = { kind, phase: "extracting" };
      this.onEvent({ type: "runtime:extracting", kind, archive: i + 1, archives: archives.length });
      opts.signal?.throwIfAborted();
      if (isTar) await extractTarGzAsync(zipPath, installDir);
      else await extractZipAsync(zipPath, installDir);
      opts.signal?.throwIfAborted();
      fs.rmSync(zipPath, { force: true });
      this._progress = null;
    }
    opts.signal?.throwIfAborted();
    if (!fs.existsSync(bin)) {
      throw new Error(
        `Runtime archive for ${build.key} did not contain expected binary at ${build.binPath} — catalog binPath is wrong`
      );
    }
    if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
    this.onEvent({ type: "runtime:provisioned", kind, bin });
    return bin;
  }

  /** Blow away an installed build and download+extract it fresh. The heal
   *  path for a corrupted extraction (§5: never strand the user). */
  async reprovision(kind, opts = {}) {
    const build = this.selectBuild(kind, opts);
    const installDir = path.dirname(path.join(this.runtimesDir, kind, build.version, build.key, "x"));
    fs.rmSync(installDir, { recursive: true, force: true });
    this.onEvent({ type: "runtime:reprovision", kind, build: build.key, version: build.version });
    return this.ensure(kind, opts);
  }
}

module.exports = { RuntimeProvisioner };
