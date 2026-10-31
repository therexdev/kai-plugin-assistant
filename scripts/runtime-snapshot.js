"use strict";
// Release checks use the same complete-file boundary as Core. Native workers
// may write their own data, but must never add to or change their signed code.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
function snapshotRuntime(root) {
  const files = Object.create(null), buffer = Buffer.allocUnsafe(256 * 1024);
  function walk(directory, prefix = "") {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw Error("Unsafe runtime directory: " + (prefix || "."));
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix + name, file = path.join(directory, name), before = fs.lstatSync(file);
      if (before.isSymbolicLink()) throw Error("Linked runtime file: " + relative);
      if (before.isDirectory()) { walk(file, relative + "/"); continue; }
      if (!before.isFile() || before.nlink !== 1) throw Error("Runtime file is not a regular unlinked file: " + relative);
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)), hash = crypto.createHash("sha256"); let bytes = 0;
      const same = next => before.dev === next.dev && before.ino === next.ino && before.size === next.size && before.mtimeMs === next.mtimeMs && before.ctimeMs === next.ctimeMs;
      try {
        if (!same(fs.fstatSync(fd))) throw Error("Runtime file changed while opening: " + relative);
        let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) { bytes += count; hash.update(buffer.subarray(0, count)); }
        if (bytes !== before.size || !same(fs.fstatSync(fd)) || !same(fs.lstatSync(file))) throw Error("Runtime file changed while reading: " + relative);
      } finally { fs.closeSync(fd); }
      files[relative] = { bytes, sha256: hash.digest("hex"), mode: before.mode & 0o777, dev: before.dev, ino: before.ino };
    }
  }
  walk(root); return files;
}
function assertRuntimeUnchanged(before, after) {
  for (const [name, entry] of Object.entries(after)) {
    if (!Object.hasOwn(before, name)) throw Error("Native runtime added an unverified file: " + name);
    if (entry.bytes !== before[name].bytes || entry.sha256 !== before[name].sha256) throw Error("Native runtime changed a signed file: " + name);
  }
  for (const name of Object.keys(before)) if (!Object.hasOwn(after, name)) throw Error("Native runtime removed a signed file: " + name);
}
function assertRuntimeBuild(snapshot, record) {
  if (record?.schema !== 1 || !record.files || typeof record.files !== "object" || Array.isArray(record.files)) throw Error("Runtime build inventory is invalid");
  for (const [name, entry] of Object.entries(snapshot)) {
    if (!Object.hasOwn(record.files, name)) throw Error("Assembled runtime contains an unverified file: " + name);
    // Extraction serializes this metadata again. Its original object is checked
    // by extract-review-payload; the before/after snapshot still protects it.
    if (name !== "manifest.json" && record.files[name] !== entry.sha256) throw Error("Assembled runtime differs from its build: " + name);
  }
  for (const name of Object.keys(record.files)) if (!Object.hasOwn(snapshot, name)) throw Error("Assembled runtime is incomplete: " + name);
}
function readonlyRuntime(root, snapshot) {
  const applied = [];
  const restore = () => {
    for (const name of applied) {
      const file = path.join(root, ...name.split("/")); let info;
      try { info = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      // Never follow a new link or chmod an unrelated replacement during cleanup.
      if (info.isFile() && !info.isSymbolicLink() && info.dev === snapshot[name].dev && info.ino === snapshot[name].ino) fs.chmodSync(file, snapshot[name].mode);
    }
  };
  try {
    for (const name of Object.keys(snapshot)) { fs.chmodSync(path.join(root, ...name.split("/")), /\.(?:bin|exe)$/i.test(name) ? 0o500 : 0o400); applied.push(name); }
  } catch (error) { restore(); throw error; }
  return restore;
}
module.exports = { snapshotRuntime, assertRuntimeUnchanged, assertRuntimeBuild, readonlyRuntime };
