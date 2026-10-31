"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { EventEmitter } = require("node:events");
const { normalize, createRuntime } = require("../plugin/service/runtime");
const { createCompanion } = require("../plugin/service/electron/companion-client");
function fixture(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-assistant-foundation-")), lifetime = new AbortController(), calls = [];
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const api = { version: 1, plugin: { id: "kai.assistant", version: "0.3.0", dataDir, root: path.join(__dirname, "../plugin") }, signal: lifetime.signal,
    models: { list: () => [{ alias: "local-test", status: "ready" }], request: async () => new Response(JSON.stringify({ choices: [{ message: { content: "actual model result" } }] }), { headers: { "content-type": "application/json" } }), ensure: async input => input },
    network: { status: () => ({ privacyMode: "local-only" }), fetch: async () => { throw Error("Unexpected network"); }, models: async () => ({ models: [] }) },
    secrets: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
    services: { call: async (name, method, input) => { calls.push({ name, method, input }); throw Object.assign(Error("Service unavailable"), { code: "SERVICE_UNAVAILABLE" }); } },
    log: () => {}, ...overrides };
  const session = Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest(fn) { this.filter = fn; }, onBeforeSendHeaders(fn) { this.headers = fn; } }, clearStorageData: async () => {} });
  return { api, calls, dataDir, lifetime, electron: { session: { fromPartition: () => session } }, session };
}
test("new manifest declares native trust and owns its service and dependencies", () => {
  const m = require("../plugin/manifest.json"); assert.equal(m.schema, 2); assert.equal(m.apiVersion, 3); assert.equal(m.runtime, "native"); assert.ok(m.permissions.includes("native.execute")); assert.equal(m.service, "service/index.js");
  assert.deepEqual(m.consumes, ["kai.brain", "kai.connections", "kai.workflows", "kai.tools"]);
  for (const file of ["service/ui/mascot.js", "service/electron/mascot.js", "service/electron/providers.js", "service/core/lib/speech.js", "service/electron/conversation-actions.js"]) assert.ok(fs.existsSync(path.join(__dirname, "../plugin", file)), file);
  assert.equal(fs.existsSync(path.join(__dirname, "../plugin/service/electron/companion-hub.js")), false);
});
test("Assistant request validation rejects traversal, external paths and unexpected binary bodies", () => {
  for (const value of [{ path: "https://example.com" }, { path: "/core/../wallet" }, { path: "/core/%2e%2e/wallet" }, { path: "/core/chats", method: "POST", bodyBase64: "YQ==" }, { path: "/core/transcribe", method: "POST", bodyBase64: "bad" }]) assert.throws(() => normalize(value));
  assert.equal(normalize({ path: "/core/transcribe", method: "POST", bodyBase64: "YQ==" }).bytes.toString(), "a");
});
test("local model inference uses the public API and response streams remain cancellable", async t => {
  const f = fixture(t), runtime = createRuntime(f.api, f.electron); t.after(() => runtime.dispose());
  assert.deepEqual((await runtime.request({ path: "/core/models" })).body.aliases, f.api.models.list());
  const response = await runtime.request({ path: "/core/chat/completions", method: "POST", body: { model: "local-test", stream: false, messages: [{ role: "user", content: "hello" }] } });
  assert.equal(response.body.choices[0].message.content, "actual model result");
  f.api.models.request = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"delta":"hello"}\n\n')); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
  const stream = await runtime.request({ path: "/core/chat/completions", method: "POST", body: { model: "local-test" } }); await new Promise(setImmediate);
  const polled = await runtime.poll(stream.streamId); assert.match(polled.chunks.join(""), /hello/); assert.equal(polled.done, true);
  await runtime.cancel(stream.streamId);
});
test("Tools owns advanced run dispatch and missing providers produce an explicit error", async t => {
  const f = fixture(t), runtime = createRuntime(f.api, f.electron); t.after(() => runtime.dispose());
  await assert.rejects(runtime.request({ path: "/core/teams/run", method: "POST", body: { model: "local-test", template: "research" } }), /unavailable/);
  assert.equal(f.calls[0].name, "kai.tools"); assert.equal(f.calls[0].method, "request");
  await assert.rejects(runtime.request({ path: "/core/wallet/private-key" }), /Unsupported/);
});
test("Local-Only blocks research before egress", async t => {
  const f = fixture(t), runtime = createRuntime(f.api, f.electron); t.after(() => runtime.dispose());
  await assert.rejects(runtime.request({ path: "/core/search", method: "POST", body: { q: "hello" } }), /Local-Only/);
});
test("floating companion HTTP transport requires its isolated session token", async t => {
  const f = fixture(t), runtime = createRuntime(f.api, f.electron); t.after(() => runtime.dispose()); await runtime.ensure();
  const denied = await fetch(runtime.origin() + "/core/models"); assert.equal(denied.status, 403);
  let headers; f.session.webRequest.headers({ url: runtime.origin() + "/core/models", requestHeaders: {} }, out => { headers = out.requestHeaders; });
  const allowed = await fetch(runtime.origin() + "/core/models", { headers }); assert.equal(allowed.status, 200); assert.equal((await allowed.json()).aliases[0].alias, "local-test");
  let remote; f.session.webRequest.filter({ url: "https://example.com" }, out => { remote = out; }); assert.equal(remote.cancel, true);
});
test("basic Assistant context works without optional plugins; Brain remains the context owner", async t => {
  const f = fixture(t), service = createCompanion(f.api, model => model === "local-test");
  assert.deepEqual(await service.context("local-test", "hello"), { eligible: true, context: "" });
  assert.equal(f.calls[0].name, "kai.brain"); assert.equal(f.calls[0].method, "context");
  assert.deepEqual(await service.context("network-model", "hello"), { eligible: false, context: "" });
  assert.deepEqual(Object.keys(service.store.data).sort(), ["conversations", "settings", "version"]);
  const persisted = fs.readFileSync(path.join(f.dataDir, "conversation-actions.json"), "utf8"); assert.equal(persisted.includes('"connections"'), false);
});
test("connected calls retain receipts but credential preparation and execution stay in Connections", async t => {
  const f = fixture(t), connection = { id: "c1", name: "Test account", enabled: true, allowAgent: true, operations: [{ id: "write", name: "Write", method: "POST" }] };
  f.api.network.status = () => ({ privacyMode: "local-first" });
  f.api.services.call = async (name, method, input) => { f.calls.push({ name, method, input });
    if (name === "kai.connections" && method === "list") return [connection];
    if (name === "kai.workflows" && method === "list") return [];
    if (name === "kai.connections" && method === "prepare") return { preparedId: "review-token", method: "POST", name: "Write exact data" };
    if (name === "kai.connections" && method === "execute") { assert.equal(input.preparedId, "review-token"); return { id: "created-123", url: "https://example.com/created-123" }; }
    throw Object.assign(Error("Service unavailable"), { code: "SERVICE_UNAVAILABLE" });
  };
  const service = createCompanion(f.api, () => true); await service.refresh(); const session = service.actions.begin(42, "local-test", { question: "Write test data", conversationId: "chat-test" });
  const args = { connectionId: "c1", operationId: "write", arguments: { title: "Test" } };
  const first = await service.actions.tool(42, session.id, "connected_call", args, "local-test", async () => { throw Error("Approval belongs in Connections"); }, new AbortController().signal);
  assert.equal(first.status, "returned"); assert.equal(first.ids[0].value, "created-123");
  await service.actions.tool(42, session.id, "connected_call", args, "local-test", async () => true, new AbortController().signal);
  assert.equal(f.calls.filter(c => c.method === "execute").length, 1);
  service.actions.stop();
});
test("conversation grants bind the authenticated caller, selected IDs and new-output scope", async t => {
  const Module = require("node:module"), originalLoad = Module._load, saved = new Map(), exports = new Map(); let allow = true, reviews = 0;
  const f = fixture(t, { settings: { get: (key, fallback) => saved.has(key) ? structuredClone(saved.get(key)) : fallback, set: (key, value) => saved.set(key, structuredClone(value)) }, desktop: { confirm: async () => { reviews++; return allow; } }, services: { provide: (name, spec) => { exports.set(name, spec); return () => exports.delete(name); } } });
  f.electron.BrowserWindow = { fromId: () => null }; f.electron.webContents = { fromId: () => null };
  let service;
  try { Module._load = function(name, ...args) { if (name === "electron") return f.electron; return originalLoad.call(this, name, ...args); }; service = require("../plugin/service/index").create(f.api); }
  finally { Module._load = originalLoad; }
  t.after(() => service.dispose({ reason: "quit" }));
  const invoke = (method, input, caller = "test.brain") => exports.get("kai.assistant").call(method, input, { caller, remote: false, signal: f.lifetime.signal });
  const created = await invoke("chats.save", { title: "Shared test", messages: [{ role: "user", content: "Private note" }] });
  assert.equal((await invoke("chats.get", { id: created.id })).title, "Shared test");
  await invoke("chats.grant", { ids: [created.id] }); const before = reviews; allow = false;
  assert.equal((await invoke("chats.get", { id: created.id })).messages[0].content, "Private note"); assert.equal(reviews, before);
  await assert.rejects(invoke("chats.get", { id: created.id }, "test.other"), /declined/);
  await assert.rejects(exports.get("kai.assistant").call("chats.get", { id: created.id }, { caller: "test.brain", remote: true }), /local installed caller/);
  allow = true; await invoke("chats.grantWrite", { scope: "workflow.123.revision.2", name: "Weekly notes" }, "test.workflows"); allow = false;
  const output = await invoke("chats.save", { grantScope: "workflow.123.revision.2", title: "Workflow · Weekly notes", messages: [{ role: "assistant", content: "Completed output" }] }, "test.workflows"); assert.ok(output.id);
  await assert.rejects(invoke("chats.save", { id: created.id, revision: created.revision, grantScope: "workflow.123.revision.2", messages: [{ role: "user", content: "Private note" }] }, "test.workflows"), /declined/);
  await service.call("assistant.access.revoke", { caller: "test.brain" }); await assert.rejects(invoke("chats.get", { id: created.id }), /declined/);
});
test("public network model arrays never fall back to locally installed models", async t => {
  const f = fixture(t); f.api.network.models = async () => [{ model: "remote-only", providers: 2 }];
  const runtime = createRuntime(f.api, f.electron); t.after(() => runtime.dispose());
  const result = await runtime.request({ path: "/core/network/models" }); assert.deepEqual(result.body.models, [{ model: "remote-only", providers: 2 }]); assert.equal(result.body.models.some(m => m.model === "local-test"), false);
});
test("completed network answers are delivered as a real single SSE completion", async t => {
  const f = fixture(t), runtime = createRuntime(f.api, f.electron); t.after(() => runtime.dispose());
  const result = await runtime.request({ path: "/core/chat/completions", method: "POST", body: { model: "koinos-network:remote", messages: [{ role: "user", content: "hello" }], stream: true } });
  await new Promise(setImmediate); const output = await runtime.poll(result.streamId); const text = output.chunks.join(""); assert.match(text, /actual model result/); assert.match(text, /\[DONE\]/); assert.equal(output.done, true);
});

test("Assistant can stop a model request before response headers arrive", async t => {
  const f = fixture(t), runtime = createRuntime(f.api, f.electron); t.after(() => runtime.dispose());
  let entered, signal; const started = new Promise(resolve => { entered = resolve; });
  f.api.models.request = async (_body, value) => { signal = value; entered(); return new Promise((_, reject) => value.addEventListener("abort", () => reject(value.reason), { once: true })); };
  const pending = runtime.request({ requestId: "pending-model", path: "/core/chat/completions", method: "POST", body: { model: "local-test" } });
  const rejected = assert.rejects(pending, { name: "AbortError" }); await started;
  await runtime.cancel({ requestId: "pending-model" }); await rejected; assert.equal(signal.aborted, true);
});

test("Assistant cancellation that precedes registration prevents inference", async t => {
  const f = fixture(t), runtime = createRuntime(f.api, f.electron); t.after(() => runtime.dispose()); let called = false;
  f.api.models.request = async () => { called = true; throw Error("Must not run"); };
  await runtime.cancel({ requestId: "cancel-before-start" });
  await assert.rejects(runtime.request({ requestId: "cancel-before-start", path: "/core/chat/completions", method: "POST", body: {} }), { name: "AbortError" });
  assert.equal(called, false);
});

test("late response headers after cancellation release the returned response body", async t => {
  const f = fixture(t), runtime = createRuntime(f.api, f.electron); t.after(() => runtime.dispose()); let release, cancelledBody = false;
  f.api.models.request = () => new Promise(resolve => { release = resolve; });
  const pending = runtime.request({ requestId: "late-headers", path: "/core/chat/completions", method: "POST", body: {} });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await runtime.cancel({ requestId: "late-headers" });
  release(new Response(new ReadableStream({ cancel() { cancelledBody = true; } }), { headers: { "content-type": "text/event-stream" } }));
  await rejected; assert.equal(cancelledBody, true);
});

test("request cancellation releases an idle stream and cannot target another response", async t => {
  const f = fixture(t), runtime = createRuntime(f.api, f.electron); t.after(() => runtime.dispose()); let cancelledBodies = 0;
  f.api.models.request = async () => new Response(new ReadableStream({ cancel() { cancelledBodies++; } }), { headers: { "content-type": "text/event-stream" } });
  const a = await runtime.request({ requestId: "request-a", path: "/core/chat/completions", method: "POST", body: {} });
  const b = await runtime.request({ requestId: "request-b", path: "/core/chat/completions", method: "POST", body: {} });
  await assert.rejects(runtime.cancel({ requestId: "request-a", streamId: b.streamId }), /does not belong/); assert.equal(cancelledBodies, 0);
  await runtime.cancel({ requestId: "request-a" }); assert.equal(cancelledBodies, 1);
  await assert.rejects(runtime.poll(a.streamId), /Unknown/); assert.equal((await runtime.poll(b.streamId)).done, false);
  await runtime.cancel({ streamId: b.streamId }); assert.equal(cancelledBodies, 2);
});

test("pending request tracking is bounded and cancelled requests free their slots", async t => {
  const f = fixture(t), runtime = createRuntime(f.api, f.electron); t.after(() => runtime.dispose());
  f.api.models.request = async (_body, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const pending = Array.from({ length: 32 }, (_, i) => runtime.request({ requestId: "pending-" + i, path: "/core/chat/completions", method: "POST", body: {} }));
  const results = Promise.allSettled(pending);
  await assert.rejects(runtime.request({ requestId: "over-limit", path: "/core/chat/completions", method: "POST", body: {} }), /Finish an active/);
  await Promise.all(pending.map((_, i) => runtime.cancel({ requestId: "pending-" + i }))); assert.equal((await results).every(r => r.status === "rejected"), true);
  assert.equal((await runtime.request({ requestId: "after-cancel", path: "/core/models" })).status, 200);
});

test("stopping model preparation reaches the Foundation load request signal", async t => {
  const f = fixture(t), runtime = createRuntime(f.api, f.electron); t.after(() => runtime.dispose());
  let entered; const started = new Promise(resolve => { entered = resolve; });
  f.api.models.ensure = async (body, signal) => {
    assert.equal(body.alias, "local-test"); entered();
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const pending = runtime.request({ requestId: "prepare-model", path: "/core/models/ensure", method: "POST", body: { alias: "local-test" } });
  const rejected = assert.rejects(pending, { name: "AbortError" }); await started;
  await runtime.cancel({ requestId: "prepare-model" }); await rejected;
});
