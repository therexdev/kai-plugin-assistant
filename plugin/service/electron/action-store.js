"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
class CompanionError extends Error {}
const id = () => crypto.randomUUID(), copy = value => structuredClone(value);
function text(value, max, label = "Text") { if (typeof value !== "string" || !value.trim() || value.length > max) throw new CompanionError(`${label} is required (maximum ${max} characters).`); return value.trim(); }
// Only Assistant conversation receipts and its own review preferences live here.
// Account secrets, Brain memories and saved workflows remain with their owners.
class ActionStore {
  constructor({ dataDir, storage }) {
    this.file = path.join(dataDir, "conversation-actions.json"); this.storage = storage; this.locked = false;
    this.data = { version: 1, conversations: [], settings: { approvalGrants: [] } };
    try {
      if (fs.existsSync(this.file)) {
        const stat = fs.lstatSync(this.file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 24 * 1024 * 1024) throw Error("Invalid action journal");
        this.requireStorage(); const saved = JSON.parse(storage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(this.file, "utf8")).encrypted, "base64")));
        if (saved.version !== 1 || !Array.isArray(saved.conversations) || saved.conversations.some(t => !t || !Array.isArray(t.actions) || !Array.isArray(t.plans))) throw Error("Invalid action journal");
        this.data = saved;
      }
    } catch { this.locked = true; }
  }
  available() { return this.storage.isEncryptionAvailable() && this.storage.getSelectedStorageBackend?.() !== "basic_text"; }
  requireStorage() { if (!this.available() || this.locked) throw new CompanionError("Unlock secure storage to use conversation actions. Existing records have been preserved."); }
  change(fn) {
    this.requireStorage(); const next = copy(this.data), result = fn(next), json = JSON.stringify(next);
    if (Buffer.byteLength(json) > 24 * 1024 * 1024) throw new CompanionError("The conversation action journal is full.");
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); const temp = this.file + "." + id() + ".tmp";
    try { fs.writeFileSync(temp, JSON.stringify({ version: 1, encrypted: this.storage.encryptString(json).toString("base64") }), { flag: "wx", mode: 0o600 }); fs.renameSync(temp, this.file); this.data = next; }
    finally { fs.rmSync(temp, { force: true }); }
    return result === undefined ? undefined : copy(result);
  }
}
module.exports = { ActionStore, CompanionError, copy, id, text };
