"use strict";
const localeFixture = require("./i18n-fixture");
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { CRT_DLLS, nativeLibraryEnv } = require("../plugin/service/core/lib/native-library-env");
const { snapshotRuntime, assertRuntimeUnchanged } = require("../scripts/runtime-snapshot");

test("Windows native workers find existing system and Electron CRTs without changing Core's environment", () => {
  const env = { SystemRoot: "C:\\Windows", Path: "C:\\existing", KEEP: "unchanged" }, before = { ...env };
  const dirs = ["C:\\Windows\\System32", "D:\\KAI Core"], probes = [];
  const result = nativeLibraryEnv({ env, platform: "win32", execPath: "D:\\KAI Core\\KAI Core.exe", exists: file => { probes.push(file); return dirs.includes(path.win32.dirname(file)); } });
  assert.deepEqual(env, before); assert.notEqual(result, env);
  assert.equal(result.Path, "C:\\Windows\\System32;D:\\KAI Core;C:\\existing");
  assert.equal(result.KEEP, "unchanged"); assert.deepEqual(probes.map(file => path.win32.dirname(file)), dirs);
  assert.ok(probes.every(file => CRT_DLLS.includes(path.win32.basename(file))));
});
test("Electron's existing CRT remains available when System32 has no runtime", () => {
  const result = nativeLibraryEnv({ env: { SYSTEMROOT: "C:\\Windows" }, platform: "win32", execPath: "D:\\KAI\\kai.exe", exists: file => path.win32.dirname(file) === "D:\\KAI" });
  assert.equal(result.PATH, "D:\\KAI");
});
test("mixed System32 and Electron runtime components remain discoverable", () => {
  const existing = new Set(["C:\\Windows\\System32\\vcruntime140.dll", "D:\\KAI\\msvcp140.dll", "D:\\KAI\\vcruntime140_1.dll"]);
  const result = nativeLibraryEnv({ env: { SystemRoot: "C:\\Windows" }, platform: "win32", execPath: "D:\\KAI\\kai.exe", exists: file => existing.has(file) });
  assert.equal(result.PATH, "C:\\Windows\\System32;D:\\KAI");
});
test("unavailable, relative and PATH-injecting runtime folders are not added", () => {
  const env = { SystemRoot: "relative", PATH: "unchanged" };
  assert.deepEqual(nativeLibraryEnv({ env, platform: "win32", execPath: "relative\\kai.exe", exists: () => true }), env);
  assert.deepEqual(nativeLibraryEnv({ env: { ...env, SystemRoot: "C:\\bad;injection" }, platform: "win32", execPath: "relative\\kai.exe", exists: () => true }), { ...env, SystemRoot: "C:\\bad;injection" });
  assert.deepEqual(nativeLibraryEnv({ env, platform: "win32", execPath: "D:\\KAI\\kai.exe", exists: () => false }), env);
});
test("non-Windows environments are copied without filesystem access or path changes", () => {
  const env = { PATH: "/usr/bin" }; assert.deepEqual(nativeLibraryEnv({ env, platform: "linux", exists: () => { throw Error("Unexpected filesystem access"); } }), env);
});
test("Windows PATH casing is consolidated and duplicate runtime directories are not added", () => {
  const result = nativeLibraryEnv({ env: { SystemRoot: "C:\\Windows", Path: "original", PATH: "shadow" }, platform: "win32", execPath: "c:\\windows\\system32\\node.exe", exists: () => true });
  assert.equal(result.Path, "C:\\Windows\\System32;original"); assert.equal(Object.hasOwn(result, "PATH"), false);
});

for (const relative of ["core/lib/speech-worker.js", "core/lib/smart-turn-worker.js", "electron/pocket-voice-worker.js"]) {
  test(relative + " does not add Windows CRT files to signed code while starting its engine", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-assistant-immutable-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const nativeDir = path.join(root, "node_modules/onnxruntime-node/bin/napi-v3/win32/x64"); fs.mkdirSync(nativeDir, { recursive: true });
    const binding = path.join(nativeDir, "onnxruntime_binding.node"); fs.writeFileSync(binding, "synthetic signed addon"); fs.chmodSync(binding, 0o400);
    const before = snapshotRuntime(root), messages = [], listeners = new Map(); let reachedNative = false;
    const port = { on: (name, callback) => listeners.set(name, callback), postMessage: value => messages.push(value) };
    const requireFixture = name => {
      if (["path", "node:path"].includes(name)) return path;
      if (name === "worker_threads") return { parentPort: port, workerData: { modelPath: "synthetic.onnx", modelDir: root } };
      if (name.endsWith("/runtimes/llamacpp")) return { ensureCrtBeside: () => { for (const dll of CRT_DLLS) fs.writeFileSync(path.join(nativeDir, dll), "old runtime copied DLL"); } };
      if (name === "./speech-wasm") return { installWasmRuntime() { reachedNative = true; } };
      if (name === "onnxruntime-node") { reachedNative = true; throw Error("Synthetic native load reached"); }
      if (name === "sherpa-onnx-node") { reachedNative = true; return { OfflineTts: { createAsync() { throw Error("Synthetic native load reached"); } } }; }
      throw Error("Unexpected fixture dependency: " + name);
    };
    requireFixture.resolve = name => name === "onnxruntime-node" ? path.join(root, "node_modules/onnxruntime-node/dist/index.js") : path.join(root, "node_modules/sherpa-onnx-win-x64/package.json");
    const source = fs.readFileSync(path.join(__dirname, "../plugin/service", relative), "utf8");
    vm.runInNewContext(source, { KaiI18n: localeFixture,  require: requireFixture, process: { platform: "win32", arch: "x64", env: { KAI_POCKET_DIR: root }, parentPort: port, cpuUsage: () => ({ user: 0, system: 0 }) }, module: { exports: {} }, Buffer, performance, console, setTimeout, clearTimeout }, { filename: relative });
    const value = { id: 1, type: "warm", voice: "fixture" };
    await listeners.get("message")(relative.startsWith("electron/") ? { data: value } : value);
    assert.equal(reachedNative, true); assert.ok(messages.some(value => typeof value.error === "string"));
    assertRuntimeUnchanged(before, snapshotRuntime(root));
  });
}
