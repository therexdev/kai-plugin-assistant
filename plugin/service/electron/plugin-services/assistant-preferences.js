"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const MAX_BYTES = 1024 * 1024;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const digest = bytes => bytes === null ? null : crypto.createHash("sha256").update(bytes).digest("hex");
function createWindowPreferences(dataDir) {
  const rawDir = path.resolve(dataDir), root = fs.lstatSync(rawDir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw Error("Window preferences need a real profile directory; saved data was preserved");
  const directory = fs.realpathSync(rawDir), filePath = path.join(directory, "window.json");
  let observed, data, backupPath = null;
  function checkDirectory() {
    const current = fs.lstatSync(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== root.dev || current.ino !== root.ino) throw Error("The profile directory changed; window preferences were preserved");
  }
  function read() {
    checkDirectory(); let before;
    try { before = fs.lstatSync(filePath); } catch (error) { if (error.code === "ENOENT") return { bytes: null, hash: null, ino: null, dev: null, data: {} }; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) throw Error("Window preferences must be a bounded regular file; original data was preserved");
    const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    let bytes;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 || opened.size > MAX_BYTES) throw Error("Window preferences changed while opening; original data was preserved");
      bytes = fs.readFileSync(fd); if (bytes.length !== opened.size) throw Error("Window preferences changed while reading; original data was preserved");
    } finally { fs.closeSync(fd); }
    let next; try { next = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw Error("Saved window preferences are unreadable; original data was preserved"); }
    if (!plain(next)) throw Error("Saved window preferences are invalid; original data was preserved");
    checkDirectory();
    return { bytes, hash: digest(bytes), dev: before.dev, ino: before.ino, data: next };
  }
  function load() { observed = read(); data = observed.data; }
  function parts(key) {
    if (typeof key !== "string" || !key || key.length > 250) throw Error("Invalid window preference key");
    const keys = key.split(".");
    if (keys.some(part => !part || ["__proto__", "constructor", "prototype"].includes(part))) throw Error("Invalid window preference key");
    return keys;
  }
  function unchanged(current) {
    if (current.hash !== observed.hash || current.ino !== observed.ino || current.dev !== observed.dev) throw Error("Window preferences changed elsewhere. Read them again before saving; original data was preserved");
  }
  function jsonValue(value, depth = 0) {
    if (depth > 40 || value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || typeof value === "number" && !Number.isFinite(value)) throw Error("Invalid window preference value");
    if (value === null || typeof value !== "object") return;
    if (!Array.isArray(value) && !plain(value)) throw Error("Invalid window preference value");
    for (const child of Object.values(value)) jsonValue(child, depth + 1);
  }
  load();
  return {
    filePath,
    get backupPath() { return backupPath; },
    get(key, fallback) {
      const keys = parts(key); load();
      let value = data; for (const part of keys) { if (!plain(value) || !Object.hasOwn(value, part)) return structuredClone(fallback); value = value[part]; }
      return structuredClone(value);
    },
    set(key, value) {
      const keys = parts(key); jsonValue(value); unchanged(read());
      const next = structuredClone(data); let target = next;
      for (const part of keys.slice(0, -1)) { if (!Object.hasOwn(target, part)) target[part] = {}; else if (!plain(target[part])) throw Error("A saved preference branch has another value; it was preserved"); target = target[part]; }
      target[keys.at(-1)] = structuredClone(value);
      const bytes = Buffer.from(JSON.stringify(next, null, 2)); if (bytes.length > MAX_BYTES) throw Error("Window preferences exceed the supported size; original data was preserved");
      if (!backupPath && observed.bytes !== null) {
        const backup = filePath + ".core-backup-" + Date.now() + "-" + crypto.randomBytes(6).toString("hex");
        fs.writeFileSync(backup, observed.bytes, { flag: "wx", mode: 0o600 });
        if (!fs.readFileSync(backup).equals(observed.bytes)) { fs.rmSync(backup, { force: true }); throw Error("Window preference backup could not be verified"); }
        backupPath = backup;
      }
      const temp = filePath + "." + crypto.randomBytes(12).toString("hex") + ".tmp";
      try {
        fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
        unchanged(read()); fs.renameSync(temp, filePath); load();
      } finally { fs.rmSync(temp, { force: true }); }
      return structuredClone(value);
    },
  };
}
module.exports = { createWindowPreferences };
