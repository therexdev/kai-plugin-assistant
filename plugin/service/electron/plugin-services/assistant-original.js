"use strict";
const crypto = require("node:crypto");
const CHAT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PAYMENT_ACTIONS = new Set("credit-status chat-info chat-completion chat-ack chat-recover stop run-open run-chat run-execute run-input run-list run-status run-stop".split(" "));
function create(ctx, files) {
  const revisions = new Map(); let native, disposed = false;
  const response = body => ({ ok: true, status: 200, headers: { "content-type": "application/json" }, body });
  const body = input => {
    const value = typeof input.body === "string" ? JSON.parse(input.body) : input.body || {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid conversation request"); return value;
  };
  function current(id) {
    if (typeof id !== "string" || !CHAT_ID.test(id)) throw Error("Invalid conversation id");
    const row = files.read(id);
    if (!revisions.has(id) || revisions.get(id) !== row.revision) throw Error("Conversation changed in another window. Reopen it before saving.");
    return row;
  }
  function commit(id, doc, revision) {
    const result = files.write(id, doc, revision); revisions.set(id, result.revision); return result;
  }
  async function reviewRuntimeRequest(input) {
    // Tool execution is delegated to the owning Tools service, which performs
    // native action review against its exact current configuration.
    return input;
  }
  async function request(input, signal) {
    if (!input || typeof input.path !== "string") throw Error("Invalid Assistant request");
    const method = String(input.method || "GET").toUpperCase();
    if (method === "POST" && /^\/core\/(?:voice|speech)\/setup(?:\?|$)/.test(input.path)) await (native ||= require("./assistant-native").create(ctx)).startBackground();
    const match = /^\/core\/chats(?:\/([a-z0-9][a-z0-9-]{0,63}))?$/.exec(input.path);
    if (!match) return ctx.runtimeRequest( await reviewRuntimeRequest(input, signal), signal);
    if (input.bodyBase64 !== undefined) throw Error("Conversation requests require a JSON body");
    const id = match[1];
    if (method === "GET" && !id) {
      const rows = await files.list(signal), chats = [];
      for (const item of rows.chats) {
        const row = files.read(item.id); if (!revisions.has(item.id)) revisions.set(item.id, row.revision);
        chats.push({ ...item, searchText: row.doc.messages.map(m => m.content).join(" ").slice(0, 1200) });
      }
      return response({ ok: true, chats, warnings: rows.warnings });
    }
    if (method === "GET" && id) {
      const row = files.read(id); revisions.set(id, row.revision); return response({ ok: true, chat: row.doc });
    }
    if (method === "POST" && !id) {
      const input = body(arguments[0]), messages = input.messages;
      if (!Array.isArray(messages) || !messages.length || messages.length > 10000 || JSON.stringify(messages).length > 16 * 1024 * 1024) throw Error("Conversation is too large to save");
      const safe = messages.map(m => {
        if (!m || typeof m !== "object" || !["user", "assistant", "system", "tool"].includes(m.role) || typeof m.content !== "string") throw Error("Invalid conversation message");
        const citations = Array.isArray(m.citations) ? m.citations.slice(0, 8).map(c => ({ title: String(c?.title || "").slice(0, 120), url: String(c?.url || "").slice(0, 500) })).filter(c => /^https?:\/\//i.test(c.url)) : [];
        const images = Array.isArray(m.images) ? m.images.filter(u => typeof u === "string" && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u) && u.length <= 2500000).slice(0, 3) : [];
        return { role: m.role, content: m.content, ...(citations.length ? { citations } : {}), ...(images.length ? { images } : {}) };
      });
      const previous = input.id ? current(input.id) : null;
      const key = previous?.doc.id || `c${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`, now = new Date().toISOString();
      const old = previous?.doc || {}, doc = { ...old, id: key, title: old.renamed ? old.title : String(input.title || safe.find(m => m.role === "user")?.content || "Untitled chat").slice(0, 80), createdAt: old.createdAt || now, updatedAt: now,
        messages: safe.map((message, i) => old.messages?.[i]?.role === message.role && old.messages[i].content === message.content ? { ...old.messages[i], ...message } : message) };
      if (input.system) doc.system = String(input.system).slice(0, 4000); else delete doc.system;
      if (input.persona) doc.persona = String(input.persona).slice(0, 40); else delete doc.persona;
      return response({ ok: true, ...commit(key, doc, previous?.revision) });
    }
    if (method === "PATCH" && id) {
      const input = body(arguments[0]), previous = current(id), doc = { ...previous.doc };
      if (Object.keys(input).some(k => !["title", "pinned"].includes(k))) throw Error("Unsupported conversation edit");
      if (input.title !== undefined) { if (typeof input.title !== "string" || !input.title.trim()) throw Error("Use a conversation title"); doc.title = input.title.trim().slice(0, 80); doc.renamed = true; doc.updatedAt = new Date().toISOString(); }
      if (input.pinned !== undefined) { if (typeof input.pinned !== "boolean") throw Error("Invalid favorite value"); doc.pinned = input.pinned; }
      return response({ ok: true, ...commit(id, doc, previous.revision) });
    }
    if (method === "DELETE" && id) {
      const previous = current(id);
      if (!await ctx.confirm("Delete conversation?", `Delete “${previous.doc.title || "Untitled chat"}” from this device?`)) return response({ ok: true, cancelled: true });
      signal?.throwIfAborted(); current(id); await files.remove(id, previous.revision, signal); revisions.delete(id); return response({ ok: true });
    }
    throw Error("Unsupported conversation request");
  }
  return {
    startBackground: () => (native ||= require("./assistant-native").create(ctx)).startBackground(),
    async call(method, input = {}, signal) {
      signal?.throwIfAborted(); if (disposed) throw Error("Assistant is closing");
      if (method === "assistant.request") return request(input, signal);
      if (method === "assistant.poll") return ctx.runtimePoll( input.streamId, signal);
      if (method === "assistant.cancel") return ctx.runtimeCancel( input.streamId);
      if (method === "assistant.native") return (native ||= require("./assistant-native").create(ctx)).call(input, signal);
      if (method === "assistant.payment") {
        if (!PAYMENT_ACTIONS.has(input.action)) throw Error("This payment action is unavailable to Assistant");
        if (!ctx.runPayment) throw Error("Network chat is unavailable");
        return ctx.runPayment(input.action, input.input, { window: ctx.getWindow(), webContents: ctx.getWebContents?.(), isVisible: ctx.isVisible, signal });
      }
      if (method === "assistant.navigate") { if (typeof input.view !== "string") throw Error("Choose a destination"); return ctx.openCoreView(input.view); }
      if (method === "assistant.copyText") { if (typeof input.text !== "string" || input.text.length > 800000 || Object.keys(input).some(key => key !== "text")) throw Error("Invalid text to copy"); ctx.electron.clipboard.writeText(input.text); return { copied: true }; }
      if (method === "assistant.external") {
        const url = new URL(input.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw Error("Only public web links can be opened");
        return ctx.electron.shell.openExternal(url.href);
      }
      if (method === "assistant.privacy") {
        if (!["local-only", "local-first", "network"].includes(input.privacyMode)) throw Error("Choose a privacy mode");
        return ctx.setPrivacyMode(input.privacyMode);
      }
      if (method === "assistant.media") return { available: true };
      throw Error("Unknown Assistant operation");
    },
    privacyChanged: mode => native?.privacyChanged(mode),
    async dispose() { disposed = true; try { await native?.dispose(); } finally { await ctx.runtimeDispose?.(); } },
  };
}
module.exports = { create, PAYMENT_ACTIONS };
