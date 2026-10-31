"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), { spawn } = require("node:child_process");
const { snapshotRuntime, assertRuntimeUnchanged, assertRuntimeBuild, readonlyRuntime } = require("./runtime-snapshot");
const pluginRoot = path.resolve(__dirname, "../.build/plugin"), root = path.join(pluginRoot, "service");
async function checkNative() {
  // This is the same environment used by the plugin's disposable workers.
  Object.assign(process.env, require(path.join(root, "core/lib/native-library-env")).nativeLibraryEnv());
  const ort = require(path.join(root, "node_modules/onnxruntime-node")), sherpa = require(path.join(root, "node_modules/sherpa-onnx-node"));
  assert.equal(typeof ort.InferenceSession.create, "function"); assert.equal(typeof sherpa.OfflineTts, "function");
  const { SmartTurnManager } = require(path.join(root, "core/lib/smart-turn"));
  const manager = new SmartTurnManager({ modelPath: path.join(root, "resources/live-senses/turn/smart-turn-v3.2-cpu.onnx") });
  try { await manager.warm({ signal: AbortSignal.timeout(60000) }); console.log("Plugin-owned native voice dependencies and semantic turn model verified"); }
  finally { await manager.close(); }
}
async function launchNative() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, "--native-child"], { stdio: "inherit", windowsHide: true, shell: false }); let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 90000); timer.unref?.();
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); if (timedOut || code !== 0) reject(Error(timedOut ? "Native runtime check timed out" : `Native runtime check failed (${signal || code})`)); else resolve(); });
  });
}
async function main() {
  const before = snapshotRuntime(pluginRoot), record = JSON.parse(fs.readFileSync(path.join(__dirname, "../.build/runtime-build.json"), "utf8"));
  assertRuntimeBuild(before, record);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pluginRoot, "manifest.json"), "utf8")), require("../plugin/manifest.json"), "Runtime manifest must match this reviewed source");
  const restoreModes = readonlyRuntime(pluginRoot, before);
  try {
    // A second fresh process covers reopening after a first successful launch.
    // Snapshot even on an inference error so code contamination is not hidden.
    for (let launch = 1; launch <= 2; launch++) {
      try { await launchNative(); } finally { assertRuntimeUnchanged(before, snapshotRuntime(pluginRoot)); }
      console.log(`Native launch ${launch}: signed runtime inventory and bytes unchanged`);
    }
  } finally { restoreModes(); }
}
if (require.main === module) (process.argv.includes("--native-child") ? checkNative() : main()).catch(error => { console.error(error.stack); process.exitCode = 1; });
