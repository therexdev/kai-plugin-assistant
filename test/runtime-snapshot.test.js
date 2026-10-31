"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { snapshotRuntime, assertRuntimeUnchanged, assertRuntimeBuild, readonlyRuntime } = require("../scripts/runtime-snapshot");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-code-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "service/native"), { recursive: true });
  fs.writeFileSync(path.join(root, "manifest.json"), '{ "version": "1.0.0" }\n');
  fs.writeFileSync(path.join(root, "service/worker.js"), '"use strict";', { mode: 0o640 });
  fs.writeFileSync(path.join(root, "service/native/engine.exe"), "fixture, never executed", { mode: 0o750 });
  return { root, before: snapshotRuntime(root) };
}
test("runtime snapshot detects CRT additions and preserves the unexpected file", t => {
  const { root, before } = fixture(t), extra = path.join(root, "service/native/msvcp140.dll"); fs.writeFileSync(extra, "synthetic OS CRT");
  assert.throws(() => assertRuntimeUnchanged(before, snapshotRuntime(root)), /added an unverified file.*msvcp140.dll/); assert.equal(fs.readFileSync(extra, "utf8"), "synthetic OS CRT");
});
test("runtime snapshot detects same-length modifications and removed code", t => {
  const { root, before } = fixture(t), file = path.join(root, "service/worker.js");
  fs.writeFileSync(file, '"use sloppy";'); assert.throws(() => assertRuntimeUnchanged(before, snapshotRuntime(root)), /changed a signed file/);
  fs.unlinkSync(file); assert.throws(() => assertRuntimeUnchanged(before, snapshotRuntime(root)), /removed a signed file/);
});
test("runtime snapshot refuses hardlinks instead of accepting duplicated code", t => {
  const { root } = fixture(t); fs.linkSync(path.join(root, "service/worker.js"), path.join(root, "service/alias.js"));
  assert.throws(() => snapshotRuntime(root), /regular unlinked file/);
});
test("Core-style readonly file modes leave bytes intact and restore original modes", t => {
  const { root, before } = fixture(t), restore = readonlyRuntime(root, before);
  try {
    const after = snapshotRuntime(root); assert.doesNotThrow(() => assertRuntimeUnchanged(before, after));
    assert.equal(after["service/worker.js"].mode & 0o222, 0); assert.equal(after["service/native/engine.exe"].mode & 0o222, 0);
    if (process.platform !== "win32") { assert.equal(after["service/worker.js"].mode, 0o400); assert.equal(after["service/native/engine.exe"].mode, 0o500); }
  } finally { restore(); }
  const after = snapshotRuntime(root); for (const name of Object.keys(before)) assert.equal(after[name].mode, before[name].mode);
});
test("build inventory detects prior contamination while permitting extracted manifest formatting", t => {
  const { root, before } = fixture(t), record = { schema: 1, files: Object.fromEntries(Object.entries(before).map(([name, entry]) => [name, entry.sha256])) };
  fs.writeFileSync(path.join(root, "manifest.json"), '{"version":"1.0.0"}'); assert.doesNotThrow(() => assertRuntimeBuild(snapshotRuntime(root), record));
  fs.writeFileSync(path.join(root, "service/native/vcruntime140.dll"), "synthetic CRT"); assert.throws(() => assertRuntimeBuild(snapshotRuntime(root), record), /unverified file/);
});
