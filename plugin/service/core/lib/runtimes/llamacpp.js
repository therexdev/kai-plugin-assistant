"use strict";

const { spawn } = require("child_process");
const net = require("net");
const path = require("path");

/*
 * llama.cpp runtime adapter (V1 working choice; spec §6 keeps runtimes
 * swappable). Core supervises a `llama-server` child process, which natively
 * serves OpenAI-compatible /v1/chat/completions with streaming — the gateway
 * proxies to it and adds policy in front.
 *
 * The adapter interface every runtime implements:
 *   start({ modelPath, contextSize, gpuLayers }) -> { endpoint }
 *   stop() -> void            status() -> { running, pid, endpoint, model }
 */

const HEALTH_TIMEOUT_MS = 120000; // model load can be slow on first start
const HEALTH_POLL_MS = 500;

/** An OS-assigned free port on `host`, released just before we hand it out. */
function freePort(host) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Engine self-test (no model involved): a binary that can't even print its
 * version can't serve — catch machine incompatibility at provision time,
 * not at first chat. Throws with the decoded exit code on failure.
 */
/*
 * Field finding, two generations of it. v0.1.1: an old msvcp140.dll on the
 * DLL search path crashed modern llama.cpp builds at load (std::mutex
 * 0xC0000005), so we placed Electron's CRT beside the engine — the exe's
 * own directory wins the search order. v0.22.1: that cure became the
 * disease — Electron's bundled CRT aged behind the engine toolchain, and
 * copy-if-absent made the stale copy permanent, crashing BOTH engine
 * builds on every packaged install (CI stayed green: headless node has no
 * CRT beside it to copy). Now: prefer the OS-serviced System32 redist
 * (newest on the machine), fall back to Electron's only when there is no
 * redist at all, and overwrite a differing copy instead of keeping it.
 */
/** Spawn env for the engine. Official archives keep shared libraries beside
 *  the binary — use the platform loader path so Linux .so and macOS .dylib
 *  companions resolve even when a build lacks a relative rpath. */
function engineEnv(binPath, { platform = process.platform, env = process.env } = {}) {
  const libDir = path.dirname(binPath);
  return {
    ...env,
    KMP_AFFINITY: "disabled",
    KMP_DUPLICATE_LIB_OK: "TRUE",
    ...(platform === "linux"
      ? { LD_LIBRARY_PATH: [libDir, env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
      : platform === "darwin"
        ? { DYLD_LIBRARY_PATH: [libDir, env.DYLD_LIBRARY_PATH].filter(Boolean).join(":") }
        : {}),
  };
}

const CRT_DLLS = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
function ensureCrtBeside(binPath, srcDirOverride) {
  if (process.platform !== "win32") return;
  const fs = require("fs");
  const dstDir = path.dirname(binPath);
  const sys32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const electronDir = srcDirOverride || path.dirname(process.execPath);
  const srcDir = CRT_DLLS.every((dll) => fs.existsSync(path.join(sys32, dll))) ? sys32 : electronDir;
  for (const dll of CRT_DLLS) {
    const src = path.join(srcDir, dll);
    const dst = path.join(dstDir, dll);
    try {
      if (!fs.existsSync(src)) continue;
      const stale = fs.existsSync(dst) && fs.statSync(dst).size !== fs.statSync(src).size;
      if (stale) fs.rmSync(dst);
      if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
    } catch {
      /* best effort — self-test still reports the truth */
    }
  }
}

/*
 * llama.cpp CPU-variant strip (field finding, Arrow Lake): official builds
 * bundle ggml-cpu ISA variants (haswell, icelake, sapphirerapids, …) and
 * probe them at startup. On very new hybrid CPUs a mis-scored probe can
 * access-violate inside a variant DLL — in the CPU AND Vulkan builds alike,
 * while CI's older server CPUs never see it. The registry only probes DLLs
 * that exist, so deleting the exotic variants and keeping a conservative
 * baseline turns a crashing engine into a working (slightly slower) one.
 */
const SAFE_CPU_VARIANTS = /^ggml-cpu(-(x64|sse42|haswell))?\.dll$/i;
function stripCpuVariants(binPath) {
  const fs = require("fs");
  const dir = path.dirname(binPath);
  let removed = 0;
  let kept = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^ggml-cpu.*\.dll$/i.test(f)) continue;
      if (SAFE_CPU_VARIANTS.test(f)) {
        kept++;
        continue;
      }
      try {
        fs.rmSync(path.join(dir, f));
        removed++;
      } catch { /* locked — self-test will tell */ }
    }
  } catch {
    /* dir unreadable — nothing to strip */
  }
  // Only claim a strip happened if a baseline remains to serve — deleting
  // every variant would turn a crash into a missing-backend error.
  return removed > 0 && kept > 0;
}

/** What actually sits beside the engine binary — decisive when remote
 *  debugging an extraction or dispatch failure. Names+KB, capped. */
function dirSnapshot(binPath) {
  const fs = require("fs");
  try {
    return fs
      .readdirSync(path.dirname(binPath))
      .map((f) => {
        try {
          return `${f}:${Math.round(fs.statSync(path.join(path.dirname(binPath), f)).size / 1024)}k`;
        } catch {
          return f;
        }
      })
      .join(" ")
      .slice(0, 500);
  } catch {
    return "(unreadable)";
  }
}

function removeCrtBeside(binPath) {
  if (process.platform !== "win32") return false;
  const fs = require("fs");
  let removed = false;
  for (const dll of CRT_DLLS) {
    try {
      fs.rmSync(path.join(path.dirname(binPath), dll));
      removed = true;
    } catch {
      /* wasn't there */
    }
  }
  return removed;
}

async function selfTest(binPath) {
  const { spawn } = require("child_process");
  ensureCrtBeside(binPath);
  // NOTE: the Electron dir is deliberately NOT prepended to PATH — its
  // bundled CRT aging behind the engine toolchain was the v0.22.1 field
  // crash; the beside-copies above are the sanctioned channel.
  // clang-built engine releases link LLVM OpenMP (libomp140), whose
  // topology detection can access-violate at process load on very new
  // hybrid CPUs (field machine: Arrow Lake Core Ultra). Disabling affinity
  // skips the crashing path; ggml does its own thread placement anyway.
  // Async spawn, never spawnSync: a 15s blocking probe on an earning node
  // starves scheduler long-polls and heartbeats — presence must survive a
  // slow first self-test.
  const attempt = () =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawn(binPath, ["--version"], {
          windowsHide: true,
          cwd: path.dirname(binPath),
          env: engineEnv(binPath),
        });
      } catch (e) {
        return resolve({ error: e, status: null, stdout: "", stderr: "" });
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, 15000);
      child.stdout?.on("data", (d) => { stdout += d; });
      child.stderr?.on("data", (d) => { stderr += d; });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ error: e, status: null, stdout, stderr });
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr, ...(timedOut ? { error: new Error("spawn ETIMEDOUT") } : {}) });
      });
    });
  let r = await attempt();
  // llama-server prints its version and exits 0 (some builds exit 1 after
  // printing usage); a loader crash gives a big NTSTATUS code and no output.
  const crashed = (x) => x.error || (`${x.stdout || ""}${x.stderr || ""}`.trim().length === 0 && x.status !== 0);
  if (crashed(r) && removeCrtBeside(binPath)) {
    // Self-heal: if OUR planted CRT is what kills the loader, the binary
    // runs fine on the machine's own redist — try once without it.
    r = await attempt();
  }
  if (crashed(r)) {
    const code = r.status;
    const hint =
      code === 3221225781
        ? " (0xC0000135: required DLL not found)"
        : code === 3221225477
          ? " (0xC0000005: access violation — build incompatible with this machine)"
          : code != null
            ? ` (exit code ${code})`
            : ` (${r.error?.message || "no output"})`;
    throw new Error(`Engine self-test failed for ${path.basename(binPath)}${hint}`);
  }
}

class LlamaCppRuntime {
  // No fixed default port: each start() probes a free one, so a second Core
  // instance (tests) or a stale llama-server from a crashed run can never be
  // mistaken for — or collide with — this instance's engine.
  constructor({ binPath, host = "127.0.0.1", port, onEvent, spawnProcess = spawn }) {
    this._fixedPort = port ?? null;
    this.binPath = binPath;
    this.spawnProcess = spawnProcess;
    this.host = host;
    this.port = port;
    this.onEvent = onEvent || (() => {});
    this.child = null;
    this.model = null;
    this._stopping = false;
  }

  get endpoint() {
    return `http://${this.host}:${this.port}`;
  }

  status() {
    return {
      kind: "llamacpp",
      running: !!this.child,
      pid: this.child?.pid ?? null,
      endpoint: this.child ? this.endpoint : null,
      model: this.model,
    };
  }

  async _waitHealthy(timeoutMs = HEALTH_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._startError) throw this._startError;
      if (!this.child) {
        const code = this._lastExit?.code;
        // Decode the two classic Windows loader deaths — they print nothing.
        const hint =
          code === 3221225781
            ? " (0xC0000135: a required DLL was not found — Visual C++ runtime or CUDA libraries missing)"
            : code === 3221225595
              ? " (0xC000007B: bad image — 32/64-bit or dependency mismatch)"
              : code != null
                ? ` (exit code ${code})`
                : "";
        throw new Error(`llama-server exited during startup${hint}`);
      }
      try {
        const r = await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    throw new Error("llama-server did not become healthy in time");
  }

  async start({ modelPath, contextSize = 4096, gpuLayers = 0, extraArgs = [], sizeBytes = 0 }) {
    if (this.child) throw new Error("Runtime already running — stop it first");
    this._stopping = false;
    this._startError = null;
    this.port = this._fixedPort ?? (await freePort(this.host));
    const args = [
      "--model", modelPath,
      "--host", this.host,
      "--port", String(this.port),
      "--ctx-size", String(contextSize),
      // GPU offload only when hardware detection approved it; 0 = pure CPU.
      "--n-gpu-layers", String(gpuLayers),
      ...extraArgs,
    ];

    ensureCrtBeside(this.binPath);
    // Windows CRT comes from the beside-copies above (System32-preferred);
    // Electron's dir is deliberately NOT on the child's PATH — its bundled
    // CRT aging behind the engine toolchain crashed the loader (v0.22.1).
    // KMP guards: see selfTest — libomp topology crash on new hybrid CPUs.
    const child = this.spawnProcess(this.binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: engineEnv(this.binPath),
      // llama.cpp release archives keep shared libs beside the binary.
      cwd: path.dirname(this.binPath),
    });
    this.child = child;
    this.model = modelPath;

    /*
     * Courtesy: the engine runs BELOW NORMAL priority (niceness 10 on
     * POSIX). Earning shares the machine with whatever its owner is doing,
     * and the OS scheduler resolves CPU contention in the owner's favour
     * only if we say so. Costs nothing on an idle machine — a lone
     * below-normal process still gets the whole CPU. (GPU contention is the
     * load guard's job — priority classes don't reach the GPU.)
     */
    try {
      const os = require("os");
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch { /* unsupported platform or the child already exited */ }

    // ENOENT/EACCES arrive as an asynchronous `error`, not an `exit`.
    // Handle them immediately so a failed launch neither crashes the app nor
    // consumes the model's full multi-minute loading budget.
    child.once("error", error => {
      if (this.child !== child) return;
      this._startError = error;
      this.child = null;
      this.model = null;
      this.onEvent({ type: "runtime:crashed", kind: "llamacpp", code: error.code, message: error.message });
    });
    let stderrTail = "";
    child.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      const wasStopping = this._stopping;
      this._lastExit = { code, signal };
      this.child = null;
      this.model = null;
      if (!wasStopping) {
        this.onEvent({
          type: "runtime:crashed",
          kind: "llamacpp",
          code,
          signal,
          stderrTail: stderrTail.slice(-1000),
        });
      }
    });

    try {
      // Big models on laptop disks — and first-run Vulkan pipeline
      // compilation on Intel/AMD GPUs — legitimately take minutes. Scale
      // the patience with the weights instead of failing a healthy load.
      const budget = Math.max(HEALTH_TIMEOUT_MS, Math.ceil((sizeBytes / 1e9) * 30000));
      await this._waitHealthy(budget);
    } catch (e) {
      const tail = stderrTail.slice(-600);
      this.stop();
      throw new Error(`${e.message}${tail ? `\nllama-server said: ${tail}` : ""}`);
    }
    this.onEvent({ type: "runtime:ready", kind: "llamacpp", endpoint: this.endpoint });
    return { endpoint: this.endpoint };
  }

  stop() {
    if (!this.child) return;
    this._stopping = true;
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
    this.child = null;
    this.model = null;
  }
}

module.exports = { LlamaCppRuntime, selfTest, engineEnv, ensureCrtBeside, removeCrtBeside, stripCpuVariants, dirSnapshot };
