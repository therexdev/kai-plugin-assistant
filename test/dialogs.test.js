"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const read = file => fs.readFileSync(path.join(__dirname, "../plugin", file), "utf8");
const app = read("app.js"), extras = read("assistant-extras.js");
const between = (source, start, end) => { const from = source.indexOf(start); assert.ok(from >= 0, start); const to = source.indexOf(end, from); assert.ok(to > from, end); return source.slice(from, to); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);

test("tool consent stays pending and preserves cancellation without synchronous browser dialogs", async () => {
  const pending = deferred(), reviews = [];
  const context = vm.createContext({ window: { kai: { dialogs: { confirm: (...args) => { reviews.push(args); return pending.promise; } } } } });
  vm.runInContext(between(app, "function confirmTool(", "// ---- web search toggle"), context);
  let settled = false;
  const result = context.confirmTool("mcp:local:write_file", { path: "example.txt", content: "draft" }).then(value => { settled = true; return value; });
  await tick(); assert.equal(settled, false); assert.match(reviews[0][0], /write_file/); assert.match(reviews[0][0], /path: example.txt/);
  pending.resolve(false); assert.equal(await result, false);
});

test("Analyst execution receives a resolved boolean and never an approval Promise", async () => {
  for (const accepted of [false, true]) {
    const pending = deferred();
    const body = between(app, "      let allowSensitive = false;", "      const resp = creditRun");
    const context = vm.createContext({ window: { kai: { dialogs: { confirm: () => pending.promise } } }, template: "analyst", text: "Analyze data", chatModel: "local-model" });
    let settled = false;
    const result = vm.runInContext(`(async () => { ${body} return teamBody; })()`, context).then(value => { settled = true; return value; });
    await tick(); assert.equal(settled, false);
    pending.resolve(accepted); const request = await result;
    assert.equal(request.allowSensitive, accepted); assert.equal(typeof request.allowSensitive, "boolean");
  }
});

test("voice setup downloads only after asynchronous approval and cancellation leaves it untouched", async () => {
  for (const accepted of [false, true]) {
    const pending = deferred(), requests = []; let statusReads = 0;
    const context = vm.createContext({
      window: { kai: { dialogs: { confirm: () => pending.promise } } },
      voiceStatus: async () => ++statusReads === 1 ? { installable: true, downloadBytes: 123000000 } : { available: true },
      fetch: async (...args) => { requests.push(args); }, btn: { classList: { add() {}, remove() {} } }, flash() {}, setTimeout: fn => { fn(); }
    });
    vm.runInContext(between(extras, "  async function ensureSetup()", "  async function startRecording()"), context);
    const result = context.ensureSetup(); await tick(); assert.equal(requests.length, 0);
    pending.resolve(accepted); assert.equal(await result, accepted);
    assert.equal(requests.length, accepted ? 1 : 0);
    if (accepted) { assert.equal(requests[0][0], "/core/voice/setup"); assert.equal(requests[0][1].method, "POST"); }
  }
});

test("voice button cannot open duplicate async consent and recovers from dialog errors", async () => {
  const pending = deferred(), failures = []; let click, starts = 0;
  const context = vm.createContext({ btn: { addEventListener: (_name, callback) => { click = callback; } }, startRecording: () => { starts++; return pending.promise; }, stopRecording() {}, flash: message => failures.push(message) });
  const start = extras.indexOf('  btn.addEventListener("click", async () => {');
  vm.runInContext('let busy = false, rec = null;\n' + extras.slice(start, extras.indexOf("})();", start)), context);
  const first = click(); await click(); assert.equal(starts, 1);
  pending.reject(Error("Dialog closed")); await first; assert.match(failures[0], /Dialog closed/);
  await click(); assert.equal(starts, 2);
});

class Element {
  constructor() { this.listeners = new Map(); this.value = "1"; this.checked = false; this.returnValue = ""; this.textContent = ""; this.form = null; }
  addEventListener(name, fn, options) { const rows = this.listeners.get(name) || []; rows.push({ fn, once: options?.once }); this.listeners.set(name, rows); }
  emit(name, event = {}) { const rows = this.listeners.get(name) || []; this.listeners.set(name, rows.filter(row => !row.once)); for (const row of rows) row.fn(event); }
  appendChild() {} setAttribute() {} replaceChildren() {} showModal() { this.open = true; } querySelector() { return this.form ||= new Element(); }
  close(value) { if (value !== undefined) this.returnValue = value; this.open = false; this.emit("close"); }
}

test("closing a reopened run budget cannot reuse a previous Start approval", async () => {
  const nodes = new Map(), created = [], requests = [];
  const document = { body: new Element(), addEventListener() {}, createElement: () => { const node = new Element(); created.push(node); return node; }, getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); } };
  const bridge = { run: async (method, input) => { requests.push([method, input]); if (method === "run-open") return { run: { id: "a".repeat(64) } }; if (method === "run-list") return { runs: [] }; return {}; } };
  const window = { kaiKoinTestBridge: bridge, KaiNetwork: { refresh: async () => ({ product: "prepaid-usd-v1", activation: "ready", runBudgets: true }), selectedModel: () => null } };
  vm.runInNewContext(read("credit-runs.js"), { window, document });
  const dialog = created[0];
  const first = window.KaiCreditRuns.begin("research"); await tick(); dialog.close("start"); assert.equal(await first, true);
  await window.KaiCreditRuns.finish();
  const second = window.KaiCreditRuns.begin("research"); await tick(); assert.equal(dialog.returnValue, ""); dialog.close();
  assert.equal(await second, false); assert.equal(requests.filter(([method]) => method === "run-open").length, 1);
  const third = window.KaiCreditRuns.begin("research"); await tick(); dialog.close("cancel"); assert.equal(await third, false);
});

test("main renderers use only the asynchronous Core dialog API", () => {
  for (const source of [app, extras]) assert.doesNotMatch(source, /(?<![\w.])(?:window\.)?(?:confirm|alert)\s*\(/);
});
