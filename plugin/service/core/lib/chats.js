"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/*
 * Chat history (local-first): one JSON file per conversation under
 * <dataDir>/chats. Files never leave the machine — history is a local
 * convenience, not a synced product surface. Sizes stay tiny (text), so
 * whole-file reads are fine; the list view carries a search blob so the
 * UI can filter without loading every conversation.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

class ChatStore {
  constructor(dir) {
    this.dir = dir;
  }

  _file(id) {
    if (!ID_RE.test(String(id))) throw new Error("bad chat id");
    return path.join(this.dir, `${id}.json`);
  }

  list() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
        out.push({
          id: j.id,
          title: j.title || "Untitled chat",
          pinned: Boolean(j.pinned),
          updatedAt: j.updatedAt || j.createdAt || null,
          messages: (j.messages || []).length,
          // Search blob: enough content to find a chat, small enough to list.
          searchText: (j.messages || []).map((m) => m.content).join(" ").slice(0, 1200),
        });
      } catch {
        /* skip a corrupt file rather than break the list */
      }
    }
    // Favorites float above everything; within each group, newest first.
    return out.sort((a, b) => (b.pinned - a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  get(id) {
    return JSON.parse(fs.readFileSync(this._file(id), "utf8"));
  }

  save({ id, title, messages, system, persona }) {
    if (!Array.isArray(messages) || messages.length === 0) throw new Error("messages required");
    id = id || `c${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
    const file = this._file(id);
    let createdAt = new Date().toISOString();
    let keptTitle = null;
    let keptPinned = false;
    try {
      const prev = JSON.parse(fs.readFileSync(file, "utf8"));
      createdAt = prev.createdAt || createdAt;
      // A user-chosen title (via rename) outlives autosaves.
      if (prev.renamed) keptTitle = prev.title;
      // A favorite outlives autosaves the same way — save() rebuilds the doc,
      // so every user-set flag must be explicitly carried forward.
      keptPinned = Boolean(prev.pinned);
    } catch {
      /* new chat */
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const doc = {
      id,
      title: String(keptTitle || title || messages.find((m) => m.role === "user")?.content || "Untitled chat").slice(0, 80),
      renamed: Boolean(keptTitle),
      ...(keptPinned ? { pinned: true } : {}),
      createdAt,
      updatedAt: new Date().toISOString(),
      // Persona/system prompt ride along so reopening a chat keeps its voice.
      ...(system ? { system: String(system).slice(0, 4000) } : {}),
      ...(persona ? { persona: String(persona).slice(0, 40) } : {}),
      messages: messages.map((m) => ({
        role: String(m.role),
        content: String(m.content),
        // Web-search citations ride with the assistant message that used them
        // (bounded + sanitized: title/url pairs only, http(s) only).
        ...(Array.isArray(m.citations) && m.citations.length
          ? {
              citations: m.citations
                .slice(0, 8)
                .map((c) => ({ title: String(c?.title || "").slice(0, 120), url: String(c?.url || "").slice(0, 500) }))
                .filter((c) => /^https?:\/\//i.test(c.url)),
            }
          : {}),
        // Attached images ride with the user message that sent them —
        // data: URIs only (renderer CSP allows img data:), bounded so one
        // chat file can't balloon (the UI downscales before attach anyway).
        ...(Array.isArray(m.images) && m.images.length
          ? {
              images: m.images
                .map((u) => String(u))
                .filter((u) => u.startsWith("data:image/") && u.length <= 2_500_000)
                .slice(0, 3),
            }
          : {}),
      })),
    };
    fs.writeFileSync(file, JSON.stringify(doc));
    return { id };
  }

  setPinned(id, pinned) {
    const file = this._file(id);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (pinned) doc.pinned = true;
    else delete doc.pinned;
    // Deliberately NOT bumping updatedAt: starring a chat shouldn't reorder
    // the recency ranking underneath the pinned group.
    fs.writeFileSync(file, JSON.stringify(doc));
    return { id, pinned: Boolean(pinned) };
  }

  rename(id, title) {
    title = String(title || "").trim().slice(0, 80);
    if (!title) throw new Error("title required");
    const file = this._file(id);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.title = title;
    doc.renamed = true; // survives later autosaves
    doc.updatedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(doc));
    return { id, title };
  }

  remove(id) {
    try {
      fs.unlinkSync(this._file(id));
    } catch {
      /* already gone */
    }
    return {};
  }
}

module.exports = { ChatStore };
