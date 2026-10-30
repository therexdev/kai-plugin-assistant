"use strict";
(() => {
  const bridge = window.kaiCompanionBridge;
  async function checked(promise) { const out = await promise; if (!out?.ok) throw new Error(out?.error || "Companion unavailable."); return out.result; }
  // Only final replies receive automatic recall. Planning accesses Brain with
  // explicit private tools, so ordinary web research never starts with notes.
  async function enrich(body, signal) {
    if (!body.model) return body;
    signal?.throwIfAborted();
    const query = [...(body.messages || [])].reverse().find(m => m.role === "user" && typeof m.content === "string")?.content || "";
    const final = body.stream !== false;
    const out = bridge ? await checked(bridge.context(body.model, final ? query.slice(0, 500) : null)) : { eligible: false };
    signal?.throwIfAborted();
    const next = out.eligible ? { ...body, kai_private_desktop: true } : { ...body };
    const notes = final && out.eligible && out.context ? [out.context.slice(0, 2400)] : [];
    signal?.throwIfAborted();
    if (notes.length) next.messages = [{ role: "system", content: notes.join("\n\n") }, ...(body.messages || [])];
    return next;
  }
  function toolJSON(model, fallback, signal, context = {}) {
    let privateUsed = false, privateTools = [], session = null, stopped = false, lastState = null;
    const panel = context.host && document.createElement("details");
    if (panel) { panel.className = "kai-action-results"; panel.hidden = true; context.host.append(panel); }
    function paint(state) {
      if (!panel || (!state?.actions?.length && !state?.plans?.length)) return;
      panel.hidden = false; const opened = panel.open; panel.replaceChildren();
      const summary = document.createElement("summary"); summary.textContent = "KAI actions · " + state.actions.length; panel.append(summary); panel.open = opened;
      for (const plan of state.plans || []) { const p = document.createElement("p"); p.textContent = plan.name + ": " + plan.steps.join(" → "); panel.append(p); }
      for (const action of state.actions) {
        const row = document.createElement("div"), title = document.createElement("strong"), detail = document.createElement("p");
        title.textContent = action.name; detail.textContent = action.runStatus || action.status;
        row.append(title, detail);
        if (action.message) { const message = document.createElement("p"); message.textContent = action.message; row.append(message); }
        for (const link of action.links || []) { try { const u = new URL(link); if (u.protocol !== "https:" || u.username || u.password) continue; const a = document.createElement("a"); a.href = u.href; a.target = "_blank"; a.rel = "noopener noreferrer"; KaiI18n.setText(a, "Open result ↗"); row.append(a); } catch {} }
        panel.append(row);
      }
    }
    async function refresh() { if (session && !stopped) try { lastState = await checked(bridge.session("status", { id: session.id, model })); paint(lastState); } catch {} }
    let timer;
    async function finish() { signal?.removeEventListener("abort", cancel); clearInterval(timer); if (!session || stopped) return; await refresh(); stopped = true; await bridge.session("finish", { id: session.id, cancel: !!signal?.aborted }).catch(() => {});
      if (panel && bridge.activity && !signal?.aborted && lastState?.actions?.some(a => ["running", "waiting"].includes(a.runStatus))) {
        let polls = 0;
        const watch = setInterval(async () => {
          if (!panel.isConnected || signal?.aborted || ++polls > 600) { clearInterval(watch); return; }
          try { const turns = await checked(bridge.activity(model, context.conversationId || "main")); const state = turns.find(t => t.id === session.id); paint(state); if (!state?.actions.some(a => ["running", "waiting"].includes(a.runStatus))) clearInterval(watch); } catch { clearInterval(watch); }
        }, 2000);
      }
    }

    const cancel = () => bridge?.cancel().catch(() => {});
    signal?.addEventListener("abort", cancel, { once: true });
    const json = async (url, options = {}) => {
      signal?.throwIfAborted();
      if (!bridge) return fallback(url, options);
      if (url === "/core/tools") {
        const [core, extra] = await Promise.all([fallback(url, options), checked(bridge.tools(model))]);
        privateTools = extra;
        const canSession = bridge.session && context.question;
        const active = canSession ? extra.filter(t => !t.name.startsWith("connection_")) : extra.filter(t => !t.conversationAction);
        privateTools = active;
        return { ...core, tools: [...(core.tools || []).filter(t => !/^memory_(save|search)$/.test(t.name)), ...active] };
      }
      if (url === "/core/tools/call") {
        const call = JSON.parse(options.body);
        if (privateTools.some(t => t.name === call.name)) {
          if (privateTools.find(t => t.name === call.name)?.conversationAction && !session) {
            session = await checked(bridge.session("begin", { model, question: context.question.slice(0, 4000), conversationId: context.conversationId || "main" }));
            signal?.throwIfAborted();
          }
          privateUsed = true;
          context.onPrivateTool?.(true, call.name);
          try { if (session && panel) timer = setInterval(refresh, 1500); const result = await checked(bridge.tool(call.name, call.args, model, session?.id)); signal?.throwIfAborted(); await refresh(); return { ok: true, result: typeof result === "string" ? result : JSON.stringify(result) }; }
          catch (e) { await refresh(); signal?.throwIfAborted(); if (/declined|uncertain|already stopped/.test(e.message)) { const error = new Error(e.message); error.stopTools = true; throw error; } throw e; }
          finally { if (timer) clearInterval(timer); context.onPrivateTool?.(false, call.name); }
        }
        // Once private observations enter the planner, it cannot forward them
        // to a web/MCP/Core tool. Further private connection calls ask natively.
        if (privateUsed) throw new Error("Private Brain or connection data is in this turn. Use connected_research for a reviewed public query/page; other Core/MCP tools require a separate request.");
      }
      return fallback(url, options);
    };
    json.finish = finish;
    return json;
  }
  window.KaiCompanionClient = { enrich, toolJSON, checked };
})();
