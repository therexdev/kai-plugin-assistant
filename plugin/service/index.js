"use strict";
const fs = require("node:fs"), path = require("node:path");
function create(api) {
  if (api.version !== 1) throw Error("Assistant needs Foundation native API v1");
  const electron = require("electron"), { createRuntime } = require("./runtime");
  fs.mkdirSync(api.plugin.dataDir, { recursive: true, mode: 0o700 });
  const runtime = createRuntime(api, electron), chats = new (require("./core/lib/chats").ChatStore)(path.join(api.plugin.dataDir, "chats"));
  let companion, service, disposed = false;
  const window = () => electron.BrowserWindow.fromId(api.desktop.hostWindowId());
  const contents = () => electron.webContents.fromId(api.desktop.rendererId());
  // This is an Assistant-local adapter, assembled from public primitives. No
  // Core/gateway instance, feature engine or global settings are imported.
  const gateway = { chats, network: api.network, staticAssets: runtime.staticAssets,
    get voice() { return runtime.voice; }, get speech() { return runtime.speech; }, get turn() { return runtime.turn; }, get port() { return runtime.port; } };
  const ctx = { dataDir: api.plugin.dataDir, electron, core: { models: { aliases: () => api.models.list() }, gateway },
    get origin() { return runtime.origin(); }, mascotSession: runtime.mascotSession,
    getWindow: window, getPluginWindow: window, getWebContents: contents, getPluginWebContents: contents, isVisible: () => api.desktop.isVisible(),
    confirm: (title, detail) => api.desktop.confirm(title, typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)),
    openPlugin: id => api.desktop.openPlugin(id), openCoreView: view => {
      const plugins = { brain: "kai.brain", connections: "kai.connections", workflows: "kai.workflows", docs: "kai.documents", compare: "kai.model-compare", code: "kai.code", tools: "kai.tools", devtools: "kai.tools", api: "kai.remote-access", tasks: "kai.workflows" };
      if (plugins[view]) return api.desktop.openPlugin(plugins[view], view);
      if (/^koinos(?:-|$)/.test(view)) return api.desktop.openPlugin("kai.koinos-node", view);
      return api.desktop.openCore(({ earn: "earning", "payment-wallet": "wallet", "network-overview": "network", recovery: "credits" })[view] || view);
    },
    setPrivacyMode: privacyMode => api.network.configure({ privacyMode }),
    runPayment: async (action, input) => {
      if (!["run-open", "run-execute", "run-input", "run-status", "run-list", "run-stop"].includes(action)) return api.wallet.authorize(action, input);
      let timer, after = 0, busy = false;
      const runId = input?.runId;
      const poll = async () => { if (busy || !runId) return; busy = true; try { const out = await api.services.call("kai.tools", "paymentEvents", { runId, after }); for (const event of out.events || []) { after = Math.max(after, event.sequence); api.desktop.send("koin:chat-progress", { runId, trace: event.trace }); } } finally { busy = false; } };
      if (action === "run-execute" && runId) { timer = setInterval(() => { void poll().catch(() => {}); }, 200); timer.unref?.(); }
      try { const out = await api.services.call("kai.tools", "payment", { action, input }); if (timer) await poll(); return out; }
      finally { clearInterval(timer); }
    },
    runtimeEnsure: () => runtime.ensure(), runtimeRequest: (input, signal) => runtime.request(input, signal), runtimePoll: (id, signal) => runtime.poll(id, signal), runtimeCancel: id => runtime.cancel(id), runtimeDispose: () => runtime.dispose(),
    getCompanion() { return companion ||= require("./electron/companion-client").createCompanion(api, model => api.models.list().some(m => m.alias === model && m.status === "ready")); },
  };
  service = require("./electron/plugin-services/assistant").create(ctx);
  runtime.setClientRequest((input, signal) => service.call("assistant.request", input, signal));
  const disposeExport = api.services.provide("kai.assistant", { methods: ["models.privateEligible", "chats.list", "chats.read", "chats.get", "chats.save", "chats.grant", "chats.grantWrite", "chats.restrict", "chats.revoke"], call: async (method, input = {}, context = {}) => {
    if (context.remote || typeof context.caller !== "string") throw Error("Assistant service requires a local installed caller");
    if (method === "models.privateEligible") {
      try {
        const selected = require("./electron/provider-http").parseModel(input.model);
        const providers = new (require("./electron/providers").DesktopProviders)({ dataDir: api.plugin.dataDir, safeStorage: api.secrets, privacyMode: () => api.network.status().privacyMode });
        const status = providers.status(), provider = status.providers.find(p => p.id === selected.provider);
        return !status.blocked && status.available && !status.locked && !!provider?.configured && provider.models.some(m => m.id === selected.model);
      } catch { return false; }
    }
    const key = "chat-access", all = api.settings.get(key, {}), grant = all[context.caller] || { reads: [], writes: {} }, granted = grant.reads;
    if (method === "chats.revoke") { delete all[context.caller]; api.settings.set(key, all); return { revoked: true }; }
    if (method === "chats.restrict") {
      if (!Array.isArray(input.ids) || input.ids.some(id => typeof id !== "string")) throw Error("Choose remaining conversation IDs");
      all[context.caller] = { ...grant, reads: (grant.reads || []).filter(id => input.ids.includes(id)) }; api.settings.set(key, all); return { ids: all[context.caller].reads };
    }
    if (method === "chats.grant") {
      if (!Array.isArray(input.ids) || input.ids.length > 100 || input.ids.some(id => typeof id !== "string")) throw Error("Choose up to 100 conversations");
      const rows = await Promise.all([...new Set(input.ids)].map(id => service.call("assistant.get", { id }, context.signal)));
      if (!await api.desktop.confirm("Share selected Assistant conversations?", `Allow ${context.caller} to read these conversations in the background until you revoke access or remove the plugin?\n\n` + rows.map(r => r.title + " (" + r.id + ")").join("\n"))) throw Error("Conversation access declined");
      context.signal?.throwIfAborted(); all[context.caller] = { ...grant, reads: rows.map(r => r.id) }; api.settings.set(key, all); return { ids: rows.map(r => r.id) };
    }
    if (method === "chats.grantWrite") {
      if (typeof input.scope !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(input.scope) || typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) throw Error("Use an exact workflow scope and name");
      if (!await api.desktop.confirm("Allow workflow conversation output?", `Allow ${context.caller} to create new Assistant conversations for “${input.name}” while it runs in the background? Existing conversations cannot be changed by this grant. You can revoke it in Assistant Settings.`)) throw Error("Conversation output declined");
      context.signal?.throwIfAborted(); all[context.caller] = { ...grant, writes: { ...grant.writes, [input.scope]: { name: input.name, at: Date.now() } } }; api.settings.set(key, all); return { scope: input.scope };
    }
    const savedWrite = method === "chats.save" && !input.id && typeof input.grantScope === "string" && Object.hasOwn(grant.writes || {}, input.grantScope);
    const savedRead = ["chats.get", "chats.read"].includes(method) && Array.isArray(granted) && granted.includes(input.id);
    if (!savedRead && !savedWrite && !await api.desktop.confirm(method === "chats.save" ? "Save an Assistant conversation?" : "Share Assistant conversation data?", method === "chats.list" ? `Allow ${context.caller} to read conversation titles and metadata?` : `${context.caller}: ${method === "chats.save" ? "Save" : "Read"} conversation ${String(input.id || "new")} in Assistant?`)) throw Error("Conversation access declined");
    context.signal?.throwIfAborted(); return method === "chats.list" ? service.call("assistant.list", {}, context.signal) : service.call(method === "chats.save" ? "assistant.save" : "assistant.get", input, context.signal);
  } });
  return { keepAliveOnWindowClose: true,
    async startBackground() { await runtime.ensure(); await service.startBackground(); },
    async call(method, input = {}, signal) {
      if (disposed) throw Error("Assistant is closing"); signal?.throwIfAborted();
      if (method === "desktop.preferencesRead") return {};
      if (method === "assistant.access.list") return api.settings.get("chat-access", {});
      if (method === "assistant.access.revoke") { const all = api.settings.get("chat-access", {}); if (typeof input.caller !== "string" || !Object.hasOwn(all, input.caller)) throw Error("Choose a granted plugin"); delete all[input.caller]; api.settings.set("chat-access", all); return { revoked: true }; }
      await runtime.ensure(); return service.call(method, input, signal);
    },
    async privacyChanged(mode) { await service.privacyChanged(mode); },
    async dispose(options) { if (disposed) return; disposed = true; await service.dispose(options); await companion?.stop(); await runtime.dispose(); disposeExport?.(); },
  };
}
module.exports = { create };
