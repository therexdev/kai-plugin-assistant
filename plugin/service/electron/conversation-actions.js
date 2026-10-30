"use strict";
const crypto = require("crypto");
const { CompanionError, copy, id, text } = require("./action-store");
const { searchWeb, searchBusinesses, fetchPage, assertPublicTarget, publicPageRequest } = require("../core/lib/websearch");
const Profiles = require("../ui/connection-profiles");
const digest = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value) ?? null)).digest("hex");
function canonical(v) { if (Array.isArray(v)) return v.map(canonical); if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])); return v; }
function bounded(v, max = 48000) { if (JSON.stringify(v).length > max) throw new CompanionError("Narrow this action; its data is too large."); return copy(v); }
function walk(v, fn, depth = 0) {
  if (depth > 15) throw new CompanionError("Action input is nested too deeply.");
  if (Array.isArray(v)) return v.map(x => walk(x, fn, depth + 1));
  if (v && typeof v === "object") {
    if (Object.hasOwn(v, "$ref")) { if (Object.keys(v).length !== 1 || !/^[A-Za-z][\w]*\.[\w.]+$/.test(v.$ref)) throw new CompanionError("Use {$ref: 'stepId.field'} for a result reference."); return fn(v.$ref); }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => { if (["__proto__", "constructor", "prototype"].includes(k)) throw new CompanionError("Unsupported input field."); return [k, walk(x, fn, depth + 1)]; }));
  }
  return v;
}
function reference(ref, outputs) {
  let value = outputs;
  for (const part of ref.split(".")) { if (["__proto__", "constructor", "prototype"].includes(part) || value == null || !Object.hasOwn(value, part)) throw new CompanionError("Missing result reference: " + ref); value = value[part]; }
  return copy(value);
}
function summarize(raw) {
  let data = raw; if (typeof raw === "string") { try { data = JSON.parse(raw); } catch { /* text output */ } }
  const links = [], ids = [];
  function visit(v, depth = 0) {
    if (depth > 8 || links.length > 20 || ids.length > 40) return;
    if (Array.isArray(v)) return v.slice(0, 100).forEach(x => visit(x, depth + 1));
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string" && /(?:^id$|Id$|_id$)/.test(k)) ids.push({ field: k, value: x.slice(0, 200) });
      if (typeof x === "string" && /(?:url|link)$/i.test(k)) { try { const u = new URL(x); if (u.protocol === "https:" && !u.username && !u.password && !links.includes(u.href)) links.push(u.href); } catch { /* not a link */ } }
      if (typeof x === "object") visit(x, depth + 1);
    }
  }
  visit(data); return { data, ids: ids.slice(0, 20), links: links.slice(0, 8) };
}
const TOOLS = [
  ["connected_find", "Find connected apps/accounts and setup guidance for calendar, sheets, folders, messages, email or projects.", { query: "app or capability" }],
  ["connected_actions", "Find selected permitted actions for an account. Discover before creating or sending.", { connectionId: "from connected_find", query: "create spreadsheet, find person, send message, read file…" }],
  ["connected_describe", "Get exact input schema for a selected action. Use before connected_call; never guess fields.", { connectionId: "account id", operationId: "action id" }],
  ["connected_call", "Run a selected app action with exact native review and durable receipt. Chain using returned IDs; verify created objects with a read.", { connectionId: "account id", operationId: "action id", arguments: "object matching described schema", body: "custom REST writes only" }],
  ["connected_history", "Inspect recent action receipts and results in this conversation for follow-ups or partial recovery.", { receiptId: "optional exact receipt id" }],
  ["workflow_control", "Find/inspect/run/status/cancel/resume a saved workflow. Drafts must first be reviewed in Workflows.", { operation: "find | inspect | run | status | cancel | resume", query: "name for find", id: "workflow id or run id", input: "run inputs", revision: "saved revision for run" }],
  ["instant_workflow", "Run a one-time chain of selected app actions or save its plan as a disabled builder draft. Steps use {$ref:'stepId.data.id'} for earlier results.", { operation: "run | save", name: "plan title", steps: "array {id,label,connectionId,operationId,arguments,body}; max 12; see connected_describe first" }],
  ["connected_research", "Find real local businesses as structured spreadsheet rows, search the public web, or read a public page. For local businesses use operation businesses once instead of scraping directories. Native review shows exactly what goes public; never sends chat history.", { operation: "businesses | search | read", category: "dentists, restaurants, lawyers…", location: "city, state or area", limit: "1-20; default 12", query: "public search terms", url: "public page URL" }],
];
class ConversationActions {
  constructor({ hub, privacyMode, fetchImpl = fetch, lookup }) {
    Object.assign(this, { hub, store: hub.store, privacyMode, fetch: fetchImpl, lookup }); this.owners = new Map(); this.busy = new Set();
    if (!this.store.locked && this.store.available()) this.store.change(d => {
      d.conversations ||= [];
      for (const turn of d.conversations) {
        if (turn.status === "active") turn.status = "interrupted";
        for (const a of turn.actions) if (["review", "dispatching"].includes(a.status)) { a.status = a.status === "dispatching" && a.write ? "uncertain" : "interrupted"; a.message = "KAI restarted. Inspect the destination before repeating an uncertain action."; }
      }
    });
  }
  tools() { return TOOLS.map(([name, description, params]) => ({ name, description, params, privateCompanion: true, conversationAction: true, egress: false, sensitive: false, label: name.replace(/_/g, " ") })); }
  begin(owner, model, input = {}) {
    if (!this.hub.canUseModel(model)) throw new CompanionError("Choose a local or private desktop model for connected actions.");
    const conversationId = text(input.conversationId || "conversation", 200, "Conversation"), question = text(input.question, 4000, "Request"), key = id();
    // One attended turn per window; beginning a new turn invalidates the old one.
    for (const [k, value] of this.owners) if (value.owner === owner) this.finish(owner, k);
    this.store.change(d => {
      d.conversations ||= [];
      const retained = d.conversations.filter(t => t.status === "active" || t.actions.some(a => ["uncertain", "dispatching"].includes(a.status)));
      if (retained.length >= 90) throw new CompanionError("Review uncertain actions in Connections before starting more work.");
      const ordinary = d.conversations.filter(t => !retained.includes(t) && t.at > Date.now() - 30 * 86400000).slice(0, 99 - retained.length);
      d.conversations = [...retained, ...ordinary].sort((a,b) => b.at - a.at);
      d.conversations.unshift({ id: key, conversationId, question, model, at: Date.now(), status: "active", actions: [], plans: [] });
    });
    this.owners.set(key, { owner, model, controller: new AbortController() }); return { id: key, ...this.view(key) };
  }
  turn(key) { const t = this.store.data.conversations?.find(x => x.id === key); if (!t) throw new CompanionError("Conversation action record is unavailable."); return t; }
  authorize(owner, key, model) {
    const s = this.owners.get(key); if (!s || s.owner !== owner || s.model !== model || !this.hub.canUseModel(model)) throw new CompanionError("Start a new attended chat request for this action.");
    s.controller.signal.throwIfAborted(); return s;
  }
  finish(owner, key, cancel = false) {
    const s = this.owners.get(key); if (!s || s.owner !== owner) return;
    s.controller.abort(); this.owners.delete(key);
    if (cancel) for (const a of this.turn(key).actions) if (a.runId && ["running", "waiting"].includes(this.hub.workflows.get(a.runId)?.status)) void this.hub.workflows.cancel(a.runId).catch(() => {});
    this.store.change(d => { const t = d.conversations.find(x => x.id === key); if (t) t.status = cancel ? "cancelled" : "finished"; });
  }
  stop(owner) { for (const [key, s] of this.owners) if (owner == null || s.owner === owner) this.finish(s.owner, key, true); }
  view(key) {
    const t = this.turn(key);
    return { id: t.id, conversationId: t.conversationId, status: t.status, plans: t.plans.map(p => ({ name: p.name, steps: p.steps.map(s => s.label || s.operationId) })), actions: t.actions.map(({ data, arguments: _a, ...a }) => ({ ...a, ...(a.runId ? { runStatus: this.hub.workflows.get(a.runId)?.status } : {}) })) };
  }
  patch(key, receiptId, change) { return this.store.change(d => { const a = d.conversations.find(x => x.id === key)?.actions.find(a => a.id === receiptId); if (!a) throw new CompanionError("Action record missing."); Object.assign(a, change); return a; }); }
  add(key, action) { return this.store.change(d => { const t = d.conversations.find(x => x.id === key); if (t.actions.length >= 60) throw new CompanionError("This request reached its 60-action limit. Continue in a new request."); const a = { id: id(), at: Date.now(), ...action }; t.actions.push(a); return a; }); }
  account(key, operationId) {
    const c = this.hub.connectionRows.find(c => c.id === key);
    if (!c?.enabled || !c.allowAgent) throw new CompanionError("In Connections → Connected apps → Manage access, enable Use in conversations and select the required actions.");
    if (c.provider === "composio" && (!true || c.status !== "ACTIVE" || c.accountDisabled)) throw new CompanionError("Refresh or reconnect this account in Connections.");
    const op = operationId && c.operations.find(o => o.id === operationId); if (operationId && !op) throw new CompanionError("Select this action in the account's Manage access settings first.");
    return { c, op };
  }
  find(query) {
    const words = String(query || "").toLowerCase().split(/\W+/).filter(Boolean);
    const matches = c => !words.length || words.some(w => (c.name + " " + (c.toolkit || "") + " " + (Profiles[c.toolkit]?.keywords || "")).toLowerCase().includes(w));
    return { accounts: this.hub.connections.list().filter(matches).slice(0, 20).map(c => ({ id: c.id, name: c.name, toolkit: c.toolkit || "custom", status: c.status, enabled: c.enabled, useInChat: c.allowAgent, selectedActions: c.operations.length, profile: Profiles[c.toolkit] || null })), setup: "Connections → Explore apps to connect; Connected apps → Manage access to select actions. A connected account alone does not enable chat actions.", date: new Date().toISOString(), localDate: new Date().toLocaleString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  history(key, receiptId) {
    const turns = this.store.data.conversations.filter(t => t.conversationId === this.turn(key).conversationId);
    const actions = turns.flatMap(t => t.actions.map(a => ({ ...a, request: t.question })));
    if (receiptId) { const a = actions.find(a => a.id === receiptId); if (!a) throw new CompanionError("Receipt not found in this conversation."); return a; }
    return actions.sort((a,b) => a.at - b.at).slice(-20).map(({ data, arguments: _a, ...a }) => a);
  }
  async request(key, input, confirm, signal) {
    const { c, op } = this.account(input.connectionId, input.operationId);
    const request = await this.hub.connections.prepare(c.id, op.id, input.arguments || {}, input.body);
    const requestHash = digest(request), fingerprint = digest({ connectionId: c.id, operationId: op.id, arguments: input.arguments || {}, body: input.body ?? null }), previous = request.method !== "GET" && this.turn(key).actions.find(a => a.fingerprint === fingerprint);
    if (previous) { if (previous.status === "returned") return previous; throw new CompanionError("This action already stopped, failed or has an uncertain result. Inspect its receipt; do not retry it in this request."); }
    const uncertain = this.store.data.conversations.flatMap(t => t.actions).find(a => a.fingerprint === fingerprint && ["dispatching", "uncertain"].includes(a.status));
    if (uncertain) throw new CompanionError("A matching action has an uncertain outcome (receipt " + uncertain.id + "). Inspect the destination before repeating it.");
    const a = this.add(key, { name: request.name, connectionId: c.id, operationId: op.id, revision: c.revision, fingerprint, write: request.method !== "GET", status: "review", arguments: bounded(input.arguments || {}, 16000) });
    let dispatched = false;
    try {
      signal.throwIfAborted(); this.account(c.id, op.id);
      if (this.privacyMode() === "local-only") throw new CompanionError("Local-Only blocks connected actions.");
      if (digest(await this.hub.connections.prepare(c.id, op.id, input.arguments || {}, input.body)) !== requestHash) throw new CompanionError("The connection or input changed after review.");
      this.patch(key, a.id, { status: "dispatching" }); dispatched = true;
      const raw = await this.hub.connections.execute(request, signal), result = summarize(raw);
      const encoded = JSON.stringify(result.data);
      return this.patch(key, a.id, { status: "returned", message: "Provider returned a result. Verify created content with a read; message acceptance does not imply it was read.", data: encoded.length <= 24000 ? result.data : encoded.slice(0, 24000), truncated: encoded.length > 24000, ids: result.ids, links: result.links, finishedAt: Date.now() });
    } catch (e) {
      if (this.turn(key).actions.find(x => x.id === a.id)?.status !== "declined") this.patch(key, a.id, { status: /declined|cancelled by user/i.test(e.message || "") ? "declined" : dispatched && a.write ? "uncertain" : signal.aborted ? "cancelled" : "failed", message: e instanceof CompanionError ? e.message : "The request stopped. Inspect its outcome before retrying." });
      throw e;
    }
  }
  async workflow(key, args, confirm, signal) {
    const w = this.hub.workflows, list = this.hub.workflowRows;
    if (args.operation === "find") return list.filter(x => (x.name + " " + x.description).toLowerCase().includes(String(args.query || "").toLowerCase())).slice(0, 20).map(x => ({ id: x.id, name: x.name, draft: x.draft, revision: x.revision, description: x.description }));
    if (args.operation === "inspect") { const x = list.find(x => x.id === args.id); if (!x) throw new CompanionError("Workflow not found."); return { id: x.id, name: x.name, draft: x.draft, revision: x.revision, steps: x.steps, inputFields: x.graph?.nodes.find(n => n.type === "trigger")?.config.inputFields || [], model: x.model }; }
    if (args.operation === "status") { const r = w.get(args.id); if (!r) throw new CompanionError("Run not found."); return { id: r.id, name: r.name, status: r.status, output: r.output || r.previous, pending: r.pending, error: r.error, steps: r.steps }; }
    if (args.operation === "run") {
      const x = list.find(x => x.id === args.id); if (!x || x.draft) throw new CompanionError("Review and save the workflow in Workflows first.");
      if (x.revision !== args.revision) throw new CompanionError("Inspect the current saved workflow revision before running.");
      const snapshot = digest(x);
      const existing = this.turn(key).actions.find(a => a.workflowId === x.id && a.workflowInput === digest(args.input ?? ""));
      if (existing?.runId) return this.workflow(key, { operation: "status", id: existing.runId }, confirm, signal);
      if (!await confirm("Run " + x.name, { revision: x.revision, input: args.input ?? "", steps: x.steps, note: "Runs with the saved local model. Step approvals still apply; no schedule is enabled." })) throw new CompanionError("User declined. Do not retry.");
      signal.throwIfAborted(); if (digest(list.find(w => w.id === args.id)) !== snapshot || digest(this.hub.workflowRows.find(w => w.id === args.id)) !== snapshot) throw new CompanionError("Workflow changed after review.");
      const receipt = this.add(key, { name: x.name, workflowId: x.id, workflowInput: digest(args.input ?? ""), status: "starting" });
      const runId = await w.begin(x.id, args.input ?? "", "chat"); this.patch(key, receipt.id, { runId, status: "started" }); return this.workflow(key, { operation: "status", id: runId }, confirm, signal);
    }
    const r = w.get(args.id); if (!r) throw new CompanionError("Run not found.");
    if (!["cancel", "resume"].includes(args.operation)) throw new CompanionError("Choose a supported workflow operation.");
    const before = digest(r.pending);
    if (!await confirm((args.operation === "cancel" ? "Stop " : "Resume ") + r.name, r.pending || { id: r.id, status: r.status })) throw new CompanionError("User declined. Do not retry.");
    signal.throwIfAborted(); if (args.operation === "resume" && digest(w.get(r.id).pending) !== before) throw new CompanionError("Pending action changed; inspect the run again.");
    if (args.operation === "cancel") await w.cancel(r.id); else await w.resume(r.id);
    return this.workflow(key, { operation: "status", id: r.id }, confirm, signal);
  }
  async instant(key, args, confirm, signal) {
    const name = text(args.name, 100, "Plan name"), steps = bounded(args.steps);
    if (!Array.isArray(steps) || !steps.length || steps.length > 12) throw new CompanionError("An instant workflow needs 1–12 steps.");
    const seen = new Set();
    for (const s of steps) {
      if (!/^[A-Za-z][\w]{0,39}$/.test(s.id) || seen.has(s.id) || ["constructor", "prototype", "__proto__"].includes(s.id)) throw new CompanionError("Use unique letter-led step IDs.");
      this.account(s.connectionId, s.operationId);
      walk([s.arguments || {}, s.body || {}], ref => { if (!seen.has(ref.split(".")[0]) || ref.split(".").some(p => ["constructor", "prototype", "__proto__"].includes(p))) throw new CompanionError("References must point to an earlier step."); return null; });
      seen.add(s.id);
    }
    if (args.operation === "save") {
      const literal = value => typeof value === "string" ? "=" + JSON.stringify(value) : Array.isArray(value) ? value.map(literal) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k, literal(v)])) : value;
      function template(v) { if (v && !Array.isArray(v) && typeof v === "object" && v.$ref) { const [node, ...parts] = v.$ref.split("."); if (parts.shift() !== "data") throw new CompanionError("Saved workflow references must start with stepId.data."); return "=nodes[" + JSON.stringify(node) + "].json" + parts.map(p => "[" + JSON.stringify(p) + "]").join(""); } if (Array.isArray(v)) return v.map(template); if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k,x]) => [k,template(x)])); return literal(v); }
      const nodes = [{ id: "start", type: "trigger", label: "Manual", position: { x: 0, y: 0 }, config: { kind: "manual" } }, ...steps.map((s,i) => ({ id: s.id, type: "tool_call", label: String(s.label || s.operationId).slice(0,100), position: { x: 0, y: 170 * (i + 1) }, config: { connectionId: s.connectionId, operationId: s.operationId, variables: template(s.arguments || {}), body: template(s.body || {}), requireApproval: true } }))];
      if (seen.has("start")) throw new CompanionError("Reserve the step ID start for the trigger.");
      const saved = await this.hub.workflows.save({ name, graph: { version: 2, nodes, edges: nodes.slice(1).map((n,i) => ({ id: "edge" + i, from: nodes[i].id, to: n.id, port: "main", input: "main" })) }, enabled: false }, { draft: true });
      return { id: saved.id, message: "Disabled draft saved in Workflows. Review it and parameterize inputs before use." };
    }
    if (args.operation !== "run") throw new CompanionError("Choose run or save.");
    this.store.change(d => { const t = d.conversations.find(t => t.id === key); if (t.plans.length >= 5) throw new CompanionError("Save or finish the existing plans first."); t.plans.push({ name, steps }); });
    const outputs = {};
    for (const s of steps) { signal.throwIfAborted(); outputs[s.id] = await this.request(key, { connectionId: s.connectionId, operationId: s.operationId, arguments: walk(s.arguments || {}, ref => reference(ref, outputs)), ...(s.body ? { body: walk(s.body, ref => reference(ref, outputs)) } : {}) }, confirm, signal); }
    return { name, steps: outputs, message: "Actions returned. Verify destination content and report partial or unverified outcomes accurately." };
  }
  async research(args, confirm, signal) {
    if (!["businesses", "search", "read"].includes(args.operation)) throw new CompanionError("Choose businesses, search or read.");
    const payload = args.operation === "businesses"
      ? { category: text(args.category, 100, "Business category"), location: text(args.location, 200, "Business location"), limit: Math.max(1, Math.min(20, Number(args.limit) || 12)) }
      : args.operation === "search" ? { query: text(args.query, 1000, "Public query") } : { url: text(args.url, 2000, "Public URL") };
    if (!await confirm("Use public research", { ...payload, note: "Only this query or URL goes to the public web; no conversation or Brain transcript is sent. Check it contains only information you intend to disclose." }, { key: "public-research", label: "Public research" })) throw new CompanionError("User declined public research. Do not retry.");
    signal.throwIfAborted(); if (this.privacyMode() === "local-only") throw new CompanionError("Local-Only blocks public research.");
    const controller = new AbortController(), both = AbortSignal.any([signal, controller.signal]);
    const timer = setInterval(() => { if (this.privacyMode() === "local-only") controller.abort(); }, 100); timer.unref?.();
    const fetchImpl = async (url, init = {}) => {
      both.throwIfAborted();
      const signal = AbortSignal.any([both, ...(init.signal ? [init.signal] : [])]);
      const addresses = this.fetch === fetch ? (init.addresses || await assertPublicTarget(url, { lookup: this.lookup })) : null;
      const r = await (this.fetch === fetch ? publicPageRequest : this.fetch)(url, { ...init, ...(addresses ? { addresses } : {}), signal });
      if (Number(r.headers.get("content-length")) > 1000000) { await r.body?.cancel(); throw new CompanionError("Page too large."); }
      const chunks = []; let size = 0;
      for await (const chunk of r.body || []) { both.throwIfAborted(); size += chunk.length; if (size > 1000000) throw new CompanionError("Page too large."); chunks.push(chunk); }
      return new Response(Buffer.concat(chunks), { status: r.status, headers: r.headers });
    };
    try {
      const result = args.operation === "businesses" ? await searchBusinesses(payload.category, payload.location, { fetchImpl, limit: payload.limit })
        : args.operation === "search" ? await searchWeb(payload.query, { fetchImpl }) : await fetchPage(payload.url, { fetchImpl, lookup: this.lookup });
      both.throwIfAborted(); return { ...result, retrievedAt: new Date().toISOString() };
    } finally { clearInterval(timer); }
  }
  async tool(owner, key, name, args, model, confirm, signal) {
    const session = this.authorize(owner, key, model), both = AbortSignal.any([signal, session.controller.signal]);
    if (this.busy.has(key)) throw new CompanionError("Wait for the current conversation action."); this.busy.add(key);
    try {
      if (name === "connected_find") return this.find(args.query);
      if (name === "connected_history") return this.history(key, args.receiptId);
      if (name === "connected_actions" || name === "connected_describe") {
        const { c, op } = this.account(args.connectionId, name === "connected_describe" ? args.operationId : null);
        if (op) return { connectionId: c.id, account: c.name, action: op, guidance: Profiles[c.toolkit]?.guidance || "Resolve exact inputs and verify results." };
        const words = String(args.query || "").toLowerCase().split(/\W+/).filter(Boolean);
        return c.operations.filter(o => !words.length || words.some(w => (o.name + " " + o.id).toLowerCase().includes(w))).slice(0, 30).map(o => ({ id: o.id, name: o.name, readOnly: o.readOnly ?? o.method === "GET" }));
      }
      if (name === "connected_call") return await this.request(key, args, confirm, both);
      if (name === "workflow_control") return await this.workflow(key, args, confirm, both);
      if (name === "instant_workflow") return await this.instant(key, args, confirm, both);
      if (name === "connected_research") return await this.research(args, confirm, both);
      throw new CompanionError("Unknown connected action.");
    } finally { this.busy.delete(key); }
  }
}
module.exports = { ConversationActions, summarize, walk, reference, digest };
