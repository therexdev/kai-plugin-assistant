"use strict";
const { ActionStore, CompanionError } = require("./action-store");
const { ConversationActions } = require("./conversation-actions");
function unavailable(error) { return error?.code === "SERVICE_UNAVAILABLE" || /not (?:installed|available|enabled)|service (?:unavailable|not available)|install and enable|No installed plugin provides/i.test(error?.message || ""); }
function createCompanion(api, describeModel) {
  const call = (name, method, input, signal) => api.services.call(name, method, input, { signal });
  async function optional(name, method, input, fallback, signal) { try { return await call(name, method, input, signal); } catch (error) { if (unavailable(error)) return fallback; throw error; } }
  const store = new ActionStore({ dataDir: api.plugin.dataDir, storage: api.secrets });
  const runs = new Map();
  const service = { store, connectionRows: [], workflowRows: [],
    canUseModel(model) { try { return !!describeModel(model); } catch { return false; } },
    async refresh(signal) {
      const [connections, workflows] = await Promise.all([
        optional("kai.connections", "list", {}, [], signal), optional("kai.workflows", "list", {}, [], signal),
      ]);
      service.connectionRows = Array.isArray(connections) ? connections : connections.connections || [];
      service.workflowRows = Array.isArray(workflows) ? workflows : workflows.workflows || [];
      for (const t of store.data.conversations) for (const action of t.actions) if (action.runId) {
        const run = await optional("kai.workflows", "status", { id: action.runId }, null, signal);
        if (run) runs.set(action.runId, run);
      }
    },
    connections: {
      list: () => service.connectionRows,
      prepare: (connectionId, operationId, variables, body) => call("kai.connections", "prepare", { connectionId, operationId, variables, body, purpose: "agent" }),
      execute: (request, signal) => call("kai.connections", "execute", request, signal),
    },
    workflows: {
      get: id => runs.get(id),
      async begin(id, input, _source) { const definition = service.workflowRows.find(w => w.id === id); const out = await call("kai.workflows", "run", { id, input, revision: definition?.revision }); const key = typeof out === "string" ? out : out.id || out.runId; if (!key) throw Error("Workflows did not return a run ID"); const run = await call("kai.workflows", "status", { id: key }); runs.set(key, run); return key; },
      async cancel(id) { const out = await call("kai.workflows", "cancel", { id }); runs.set(id, await call("kai.workflows", "status", { id })); return out; },
      async resume(id) { const out = await call("kai.workflows", "resume", { id }); runs.set(id, await call("kai.workflows", "status", { id })); return out; },
      save: input => call("kai.workflows", "propose", input),
    },
    async context(model, query, signal) {
      if (!service.canUseModel(model)) return { eligible: false, context: "" };
      const result = await optional("kai.brain", "context", { model, query }, { context: "" }, signal);
      return { eligible: true, context: typeof result === "string" ? result : result.context || "" };
    },
    async toolList(model, signal) {
      if (!service.canUseModel(model) || store.locked || !store.available()) return [];
      const [brain, connections] = await Promise.all([optional("kai.brain", "tools", { model }, [], signal), optional("kai.connections", "tools", { model }, [], signal)]);
      return [...service.actions.tools(), ...(Array.isArray(brain) ? brain : brain.tools || []), ...(Array.isArray(connections) ? connections : connections.tools || []),
        { name: "workflow_propose", description: "Save a disabled workflow draft for review in Workflows.", params: { name: "name", model: "local model", graph: "workflow graph", steps: "workflow steps" }, privateCompanion: true, sensitive: false, egress: false }];
    },
    async tool(name, args, model, confirm, signal, session) {
      if (!service.canUseModel(model)) throw new CompanionError("Choose a local or private model for private actions.");
      if (!(await service.toolList(model, signal)).some(t => t.name === name)) throw new CompanionError("This tool is unavailable. Install and enable its plugin first.");
      if (service.actions.tools().some(t => t.name === name)) { await service.refresh(signal); return service.actions.tool(session.owner, session.id, name, args, model, confirm, signal); }
      if (name.startsWith("brain_")) return call("kai.brain", "tool", { name, args, model }, signal);
      if (name === "workflow_propose") return call("kai.workflows", "propose", { ...args, model }, signal);
      if (name.startsWith("connection_")) return call("kai.connections", "tool", { name, args, model }, signal);
      throw new CompanionError("Unknown companion tool.");
    },
    async manage(action, input, signal) {
      if (action === "note") return call("kai.brain", "remember", input, signal);
      throw new CompanionError("Open the owning plugin to manage this feature.");
    },
    async stop() { service.actions.stop(); },
  };
  service.actions = new ConversationActions({ hub: service, privacyMode: () => api.network.status().privacyMode, fetchImpl: (url, init = {}) => api.network.fetch(url, { method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }), signal: init.signal }) });
  return service;
}
module.exports = { createCompanion, unavailable };
