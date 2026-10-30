"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const bridge = fs.readFileSync(path.join(__dirname, "../plugin/bridge.js"), "utf8");
async function session(stored, original = {}) {
  const writes = [], errors = [], listeners = [];
  class Storage { constructor() { this.data = new Map(); } getItem(key) { return this.data.get(String(key)) ?? null; } setItem(key, value) { this.data.set(String(key), String(value)); } removeItem(key) { this.data.delete(String(key)); } }
  const localStorage = new Storage(), window = { kai: { call: async (method, input) => {
    if (method === "storage.get") return structuredClone(stored);
    if (method === "desktop.preferencesRead") return original;
    if (method === "storage.set") { writes.push(structuredClone(input.value)); return true; }
    throw Error(method);
  }, onEvent: () => () => {} }, dispatchEvent: event => errors.push(event.detail) };
  const context = vm.createContext({ window, Storage, localStorage, CustomEvent: class { constructor(_name, options) { this.detail = options.detail; } }, document: { readyState: "loading", addEventListener: (_name, callback) => listeners.push(callback) } });
  vm.runInContext(bridge, context);
  await window.kaiAssistantPreferencesReady; await new Promise(setImmediate);
  return { writes, errors, localStorage, listeners, flush: () => new Promise(setImmediate) };
}
test("Assistant migrates original choices, persists changes and restores them in a fresh plugin window", async () => {
  const first = await session(null, { "kai-chat-mode": "research", "kai-chat-source": "openai", "kai-chat-model-openai": "desktop:openai:example" });
  assert.equal(first.localStorage.getItem("kai-chat-mode"), "research");
  first.localStorage.setItem("kai-chat-mode", "chat"); first.localStorage.setItem("kai-credit-paid-first", "true"); await first.flush();
  const second = await session(first.writes.at(-1), { "kai-chat-mode": "research" });
  assert.equal(second.localStorage.getItem("kai-chat-mode"), "chat"); assert.equal(second.localStorage.getItem("kai-credit-paid-first"), "true");
  assert.equal(second.localStorage.getItem("kai-chat-model-openai"), "desktop:openai:example");
});
test("Assistant stores only fixed nonsecret UI preferences", async () => {
  const f = await session(null); const count = f.writes.length;
  f.localStorage.setItem("provider-key", "synthetic-do-not-store"); await f.flush();
  assert.equal(f.writes.length, count); assert.equal(f.writes.some(value => Object.hasOwn(value, "provider-key")), false);
});
test("unreadable saved preferences cannot be overwritten by defaults", async () => {
  const f = await session("broken"); f.localStorage.setItem("kai-chat-mode", "chat"); await f.flush();
  assert.equal(f.writes.length, 0); f.listeners.forEach(callback => callback()); assert.match(f.errors[0], /unreadable/);
});
