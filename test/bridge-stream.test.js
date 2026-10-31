"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { webcrypto } = require("node:crypto"), { getEventListeners } = require("node:events");
const source = fs.readFileSync(path.join(__dirname, "../plugin/bridge.js"), "utf8");
function fixture(call) {
  const calls = [];
  class Storage { constructor() { this.values = new Map(); } getItem(key) { return this.values.get(key) ?? null; } setItem(key, value) { this.values.set(key, String(value)); } removeItem(key) { this.values.delete(key); } }
  const window = { kai: { call: async (method, input) => { if (method === "storage.get") return null; if (method === "storage.set") return true; calls.push({ method, input }); return call(method, input); }, onEvent: () => () => {} }, dispatchEvent() {} };
  vm.runInNewContext(source, { window, Storage, localStorage: new Storage(), document: { readyState: "loading", addEventListener() {} },
    Headers, Response, ReadableStream, TextEncoder, Uint8Array, ArrayBuffer, Blob, DOMException, crypto: webcrypto, btoa, atob,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 2)), clearTimeout });
  return { fetch: window.fetch, calls };
}
async function within(promise, ms = 1000) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Operation stayed pending")), ms); })]); } finally { clearTimeout(timer); } }
const streamReply = { streamId: "response-1", status: 200, headers: { "content-type": "text/event-stream" } };

test("a pending Assistant read survives empty polls before and between delayed tokens", async () => {
  const sequence = [[], [], ["first "], [], [], ["second"]]; let poll = 0;
  const f = fixture(async method => {
    if (method === "assistant.request") return streamReply;
    if (method === "assistant.poll") return { chunks: sequence[poll] || [], done: ++poll >= sequence.length };
    throw Error(method);
  });
  const response = await f.fetch("/core/chat/completions", { method: "POST", body: "{}" });
  assert.equal(await within(response.text()), "first second"); assert.equal(poll, sequence.length);
});

test("empty completion and stream errors settle the reader instead of hanging", async () => {
  for (const failure of [false, true]) {
    let polls = 0;
    const f = fixture(async method => method === "assistant.request" ? streamReply : method === "assistant.cancel" ? { stopped: true } : ++polls < 3 ? { chunks: [], done: false } : { chunks: [], done: !failure, ...(failure ? { error: "The model stopped unexpectedly" } : {}) });
    const response = await f.fetch("/core/chat/completions");
    if (failure) await assert.rejects(within(response.text()), /model stopped unexpectedly/);
    else assert.equal(await within(response.text()), "");
  }
});

test("Stop rejects immediately while waiting for headers and cancels any late stream", async () => {
  let headers; const pending = new Promise(resolve => { headers = resolve; }), abort = new AbortController();
  const f = fixture(async method => method === "assistant.request" ? pending : { stopped: true });
  const response = f.fetch("/core/chat/completions", { signal: abort.signal });
  abort.abort(); await assert.rejects(within(response), { name: "AbortError" });
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  const first = f.calls.find(c => c.method === "assistant.cancel"); assert.ok(first.input.requestId); assert.equal(first.input.streamId, undefined);
  headers(streamReply); await new Promise(setImmediate);
  const last = f.calls.filter(c => c.method === "assistant.cancel").at(-1);
  assert.equal(last.input.streamId, streamReply.streamId); assert.equal(last.input.requestId, first.input.requestId);
});

test("Stop wakes an empty pending body read and removes its signal listener", async () => {
  const abort = new AbortController();
  const f = fixture(async method => method === "assistant.request" ? streamReply : method === "assistant.poll" ? { chunks: [], done: false } : { stopped: true });
  const response = await f.fetch("/core/chat/completions", { signal: abort.signal }), text = response.text();
  abort.abort(); await assert.rejects(within(text), { name: "AbortError" });
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  assert.ok(f.calls.some(c => c.method === "assistant.cancel" && c.input.streamId === streamReply.streamId));
});

test("cancelling a response reader interrupts an outstanding poll", async () => {
  let polled; const polling = new Promise(resolve => { polled = resolve; });
  const f = fixture(async method => {
    if (method === "assistant.request") return streamReply;
    if (method === "assistant.poll") { polled(); return new Promise(() => {}); }
    return { stopped: true };
  });
  const response = await f.fetch("/core/chat/completions"), reader = response.body.getReader(), pending = reader.read();
  await within(polling); await within(reader.cancel()); assert.equal((await within(pending)).done, true);
  assert.ok(f.calls.some(c => c.method === "assistant.cancel"));
});

test("audio upload and nonstream binary responses keep their bytes and metadata", async () => {
  const bytes = new Uint8Array([0, 1, 128, 255]), abort = new AbortController();
  const f = fixture(async () => ({ status: 200, bodyBase64: Buffer.from(bytes).toString("base64"), headers: { "content-type": "audio/wav" } }));
  const response = await f.fetch("/core/transcribe", { method: "POST", body: bytes, signal: abort.signal });
  assert.equal(f.calls[0].input.bodyBase64, "AAGA/w=="); assert.equal(f.calls[0].input.body, undefined);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes); assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});
