"use strict";
const { id } = require("./action-store");
function registerCompanionIPC({ ipcMain, service, getTrustedWindow, dialog, ownsService = false }) {
  const channels = [], jobs = new Map(), sessions = new Map(); let reviewing = false;
  function handle(channel, management, run) {
    channels.push(channel); ipcMain.handle(channel, async (event, ...args) => {
      const window = getTrustedWindow(event, { management }); if (!window) throw Error("Companion access denied");
      if (jobs.size >= 12) throw Error("Finish the current companion operation first");
      const controller = new AbortController(), sender = event.sender, key = id();
      const stop = () => controller.abort(), navigate = (_e, _url, _inPlace, main) => { if (main) stop(); };
      jobs.set(key, { controller, sender }); sender.on("destroyed", stop); sender.on("render-process-gone", stop); sender.on("did-start-navigation", navigate);
      const confirm = async (name, details) => {
        controller.signal.throwIfAborted(); if (reviewing || !window.isVisible()) return false;
        const detail = JSON.stringify(details, null, 2); if (detail.length > 20000) throw Error("Action is too large to review");
        reviewing = true;
        try { const result = await dialog.showMessageBox(window, { type: "question", title: "KAI · Review action", message: name, detail, buttons: ["Cancel", "Allow once"], defaultId: 0, cancelId: 0, noLink: true }); return result.response === 1 && !controller.signal.aborted && !!getTrustedWindow(event, { management }) && window.isVisible(); }
        finally { reviewing = false; }
      };
      try { return { ok: true, result: await run({ event, window, signal: controller.signal, confirm }, ...args) }; }
      catch (error) { return { ok: false, error: error.name === "AbortError" ? "Operation stopped." : String(error.message || error).slice(0, 1000) }; }
      finally { jobs.delete(key); sender.removeListener("destroyed", stop); sender.removeListener("render-process-gone", stop); sender.removeListener("did-start-navigation", navigate); }
    });
  }
  handle("companion:context", false, (ctx, model, query) => service.context(model, query, ctx.signal));
  handle("companion:tools", false, (ctx, model) => service.toolList(model, ctx.signal));
  handle("companion:tool", false, (ctx, name, args, model, sessionId) => service.tool(name, args || {}, model, ctx.confirm, ctx.signal, { owner: ctx.event.sender.id, id: sessionId }));
  handle("companion:activity", false, async (ctx, model, conversationId) => { if (!service.canUseModel(model)) throw Error("Choose a local or private model"); await service.refresh(ctx.signal); return service.store.data.conversations.filter(t => t.conversationId === conversationId).slice(0, 10).map(t => service.actions.view(t.id)); });
  handle("companion:session", false, async (ctx, operation, input = {}) => {
    const owner = ctx.event.sender.id;
    if (operation === "begin") {
      sessions.get(owner)?.(); await service.refresh(ctx.signal);
      const sender = ctx.event.sender, stop = () => { service.actions.stop(owner); cleanup(); }, navigate = (_e, _url, _place, main) => { if (main) stop(); };
      const cleanup = () => { sender.removeListener("destroyed", stop); sender.removeListener("render-process-gone", stop); sender.removeListener("did-start-navigation", navigate); sessions.delete(owner); };
      const result = service.actions.begin(owner, input.model, input); sender.on("destroyed", stop); sender.on("render-process-gone", stop); sender.on("did-start-navigation", navigate); sessions.set(owner, cleanup); return result;
    }
    if (operation === "finish") { const result = service.actions.finish(owner, input.id, input.cancel === true); sessions.get(owner)?.(); return result; }
    service.actions.authorize(owner, input.id, input.model); await service.refresh(ctx.signal);
    if (operation === "status") return service.actions.view(input.id);
    throw Error("Unknown conversation operation");
  });
  handle("companion:cancel", false, ctx => { service.actions.stop(ctx.event.sender.id); for (const job of jobs.values()) if (job.sender === ctx.event.sender) job.controller.abort(); return true; });
  handle("companion:manage", true, (ctx, action, input = {}) => service.manage(action, input, ctx.signal));
  return { dispose() { for (const clean of sessions.values()) clean(); if (ownsService) service.stop(); for (const job of jobs.values()) job.controller.abort(); for (const channel of channels) ipcMain.removeHandler(channel); } };
}
module.exports = { registerCompanionIPC };
