"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const pluginId = "kai.assistant";
const permissions = Object.freeze({ "assistant.request": "assistant.chat", "assistant.poll": "assistant.chat", "assistant.cancel": "assistant.chat", "assistant.native": "assistant.native", "assistant.payment": "assistant.network", "assistant.navigate": "assistant.read", "assistant.external": "assistant.read", "assistant.copyText": "assistant.read", "assistant.privacy": "assistant.network", "assistant.media": "assistant.media", "assistant.list": "assistant.read", "assistant.get": "assistant.read", "assistant.save": "assistant.write", "assistant.rename": "assistant.write", "assistant.pin": "assistant.write", "assistant.delete": "assistant.write" });
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/, MAX_FILE = 32 * 1024 * 1024, MAX_TEXT = 800000;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function stat(file) { try { return fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function create(ctx) {
  let restored;
  const base = path.resolve(ctx.dataDir), dir = path.join(base, "chats"), store = ctx.core?.gateway?.chats;
  if (!store || path.resolve(store.dir) !== dir) throw Error("Saved conversation storage is unavailable");
  function directory(createIfMissing = false) {
    const root = stat(base); if (!root?.isDirectory() || root.isSymbolicLink()) throw Error("Conversation profile must be a real directory");
    let info = stat(dir); if (!info && createIfMissing) { fs.mkdirSync(dir, { mode: 0o700 }); info = stat(dir); }
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw Error("Conversation directory cannot be a symbolic link");
    return !!info;
  }
  function file(id) { if (typeof id !== "string" || !ID.test(id)) throw Error("Invalid conversation id"); return path.join(dir, id + ".json"); }
  function read(id) {
    directory(); const target = file(id), before = stat(target);
    if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FILE) throw Error("Conversation must be a regular file within the size limit; it was not changed");
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    let bytes;
    try { const opened = fs.fstatSync(fd); if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw Error("Conversation changed while being opened"); bytes = fs.readFileSync(fd); if (bytes.length !== before.size) throw Error("Conversation changed while being read"); } finally { fs.closeSync(fd); }
    let doc; try { doc = JSON.parse(bytes); } catch { throw Error("Saved conversation is unreadable; it was not changed"); }
    if (!object(doc) || doc.id !== id || !Array.isArray(doc.messages) || doc.messages.length > 10000 || doc.messages.some(m => !object(m) || typeof m.role !== "string" || typeof m.content !== "string")) throw Error("Saved conversation is invalid; it was not changed");
    return { doc, revision: hash(bytes) };
  }
  function publicChat({ doc, revision }) {
    const messages = doc.messages.map(m => ({ role: m.role.slice(0, 30), content: m.content, ...(Array.isArray(m.images) && m.images.length ? { attachments: m.images.length } : {}) }));
    if (messages.reduce((n, m) => n + m.content.length, 0) > MAX_TEXT) throw Error("Conversation is too large to open in this plugin; the original file is preserved");
    return { id: doc.id, title: String(doc.title || "Untitled chat").slice(0, 80), pinned: !!doc.pinned, updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : null, revision, system: typeof doc.system === "string" ? doc.system.slice(0, 4000) : "", persona: typeof doc.persona === "string" ? doc.persona.slice(0, 40) : "", messages };
  }
  function write(id, doc, revision) {
    directory(true); const target = file(id), temp = path.join(dir, `.${id}-${crypto.randomUUID()}.tmp`);
    const bytes = Buffer.from(JSON.stringify(doc)); if (bytes.length > MAX_FILE) throw Error("Conversation exceeds the size limit");
    try {
      fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
      if (revision) { if (read(id).revision !== revision) throw Error("Conversation changed elsewhere. Reopen it before saving"); }
      else if (stat(target)) throw Error("Conversation already exists. Reopen it before saving");
      directory(); fs.renameSync(temp, target);
    } finally { if (stat(temp)) fs.unlinkSync(temp); }
    return { id, revision: hash(bytes), updatedAt: doc.updatedAt };
  }
  function current(input) { const existing = read(input.id); if (typeof input.revision !== "string" || existing.revision !== input.revision) throw Error("Conversation changed elsewhere. Reopen it before saving"); return existing; }
  const restoredMethods = new Set(["assistant.request", "assistant.poll", "assistant.cancel", "assistant.native", "assistant.payment", "assistant.navigate", "assistant.external", "assistant.copyText", "assistant.privacy", "assistant.media"]);
  const restore = () => restored ||= require("./assistant-original").create(ctx, { read, write,
        list: signal => service.call("assistant.list", {}, signal),
        remove(id, revision) { if (read(id).revision !== revision) throw Error("Conversation changed; reopen it before deleting"); fs.unlinkSync(file(id)); },
      });
  const service = { keepAliveOnWindowClose: true, startBackground: () => restore().startBackground(), async call(method, input = {}, signal) {
    if (restoredMethods.has(method)) {
      return restore().call(method, input, signal);
    }
    signal?.throwIfAborted(); if (!Object.hasOwn(permissions, method)) throw Error("Unknown Assistant method");
    if (!object(input)) throw Error("Invalid Assistant request");
    if (method === "assistant.list") {
      if (!directory()) return { chats: [], warnings: [] };
      const files = fs.readdirSync(dir).filter(name => name.endsWith(".json")), chats = []; let skipped = Math.max(0, files.length - 5000);
      for (const name of files.slice(0, 5000)) {
        try { const { doc, revision } = read(name.slice(0, -5)); chats.push({ id: doc.id, title: String(doc.title || "Untitled chat").slice(0, 80), pinned: !!doc.pinned, updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : (typeof doc.createdAt === "string" ? doc.createdAt : null), messages: doc.messages.length, revision }); }
        catch { skipped++; }
      }
      chats.sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return { chats, warnings: skipped ? [`${skipped} conversation file(s) could not be listed safely. Their original files were preserved.`] : [] };
    }
    if (method === "assistant.get") return publicChat(read(input.id));
    if (method === "assistant.save") {
      const messages = input.messages;
      if (!Array.isArray(messages) || !messages.length || messages.length > 10000 || messages.some(m => !object(m) || !["user", "assistant", "system", "tool"].includes(m.role) || typeof m.content !== "string" || !m.content.length) || messages.reduce((n, m) => n + m.content.length, 0) > MAX_TEXT) throw Error("Conversation messages must contain bounded text");
      const previous = input.id ? current(input) : null, old = previous?.doc.messages || [];
      // Autosave only appends. Existing media, citations, flags and unknown
      // legacy metadata stay byte-equivalent as JSON values instead of being
      // reconstructed from the intentionally limited renderer representation.
      if (messages.length < old.length || old.some((m, i) => m.role !== messages[i]?.role || m.content !== messages[i]?.content)) throw Error("Existing conversation messages cannot be replaced; start a new conversation");
      const id = previous?.doc.id || `c${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`, now = new Date().toISOString();
      const doc = { ...(previous?.doc || { id, title: String(typeof input.title === "string" && input.title.trim() ? input.title.trim() : messages.find(m => m.role === "user")?.content || "Untitled chat").slice(0, 80), createdAt: now }), updatedAt: now, messages: [...old, ...messages.slice(old.length).map(m => ({ role: m.role, content: m.content }))] };
      return write(id, doc, previous?.revision);
    }
    const previous = current(input);
    if (method === "assistant.delete") {
      if (!await ctx.confirm("Delete saved conversation?", `Delete “${String(previous.doc.title || "Untitled chat").slice(0, 80)}” from this device?`)) return { deleted: false };
      signal?.throwIfAborted(); if (read(input.id).revision !== previous.revision) throw Error("Conversation changed while confirmation was open; it was not deleted");
      fs.unlinkSync(file(input.id)); return { deleted: true };
    }
    const doc = { ...previous.doc };
    if (method === "assistant.rename") { if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 80) throw Error("Use a conversation title from 1 to 80 characters"); doc.title = input.title.trim(); doc.renamed = true; doc.updatedAt = new Date().toISOString(); }
    if (method === "assistant.pin") { if (typeof input.pinned !== "boolean") throw Error("Invalid favorite value"); doc.pinned = input.pinned; }
    return write(input.id, doc, previous.revision);
  }, privacyChanged: mode => restored?.privacyChanged(mode), async dispose() { await restored?.dispose(); } };
  return service;
}
module.exports = { pluginId, permissions, create };
