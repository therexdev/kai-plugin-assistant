(function (root, factory) { const api = factory(); if (typeof module === "object" && module.exports) module.exports = api; else root.AssistantLogic = api; })(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function buildPrompt(messages, system = "", limit = 16000) {
    if (!Array.isArray(messages) || !messages.length) throw Error("Add a message first");
    const prefix = "Continue this conversation. Reply to the most recent user message.\n" + (system ? "Instructions: " + String(system).slice(0, 3000) + "\n" : "");
    const suffix = "\nAssistant:", selected = []; let used = prefix.length + suffix.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]; if (!message || typeof message.content !== "string") throw Error("Invalid conversation message");
      const text = `${message.role === "assistant" ? "Assistant" : message.role === "system" ? "Instructions" : message.role === "user" ? "User" : "Context"}: ${message.content}\n`;
      if (used + text.length > limit) { if (!selected.length) throw Error("The latest message is too long for local inference"); break; }
      selected.unshift(text); used += text.length;
    }
    return { prompt: prefix + selected.join("") + suffix, omitted: messages.length - selected.length, systemTrimmed: String(system).length > 3000 };
  }
  function readyModels(value) { return Array.isArray(value) ? value.filter(m => m && m.status === "ready" && typeof m.alias === "string" && m.alias).map(m => ({ alias: m.alias, label: typeof m.label === "string" ? m.label : m.alias })) : []; }
  function filterChats(chats, query) { const search = String(query || "").toLocaleLowerCase().trim(); return chats.filter(chat => String(chat.title || "").toLocaleLowerCase().includes(search)); }
  return { buildPrompt, readyModels, filterChats };
});
