"use strict";
(() => {
  const bridge = window.kaiKoinTestBridge; if (!bridge) return;
  const dialog = document.createElement("dialog"); dialog.id = "credit-run-review";
  dialog.innerHTML = '<form method="dialog"><h2>Set a total run budget</h2><p>Research, Agents and Teams can make several AI calls. This one ceiling covers every model call and retry. Local tools add no network-credit charge; their permissions still apply.</p><label>Total credits <input id="credit-run-budget" inputmode="decimal" autocomplete="off" required /></label><label><input id="credit-run-free-only" type="checkbox" /> Free only</label><p id="credit-run-cost">Free credits are used first. Unless Free only is selected, purchased credits may cover the rest, up to this total budget.</p><p>Stop ends new work. Verified delivered work is charged once; useful partial results are saved in Account help → Research &amp; agent results.</p><p id="credit-run-error" role="alert"></p><button value="cancel" formnovalidate>Cancel</button><button id="credit-run-start" value="start" class="primary">Start within this budget</button></form>';
  document.body.appendChild(dialog);
  const saved = document.createElement("details"); saved.id = "credit-run-results"; saved.innerHTML = '<summary>Research &amp; agent results</summary><p>Saved responses from Research, Agents and Teams, including useful results from interrupted runs.</p><div id="credit-run-history"></div>';
  // Recovery belongs with account history, not beside every network message.
  document.addEventListener("DOMContentLoaded", () => document.getElementById("view-recovery")?.appendChild(saved), { once: true });
  let active = null, opening = false;
  const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
  const credits = n => { const amount = BigInt(n); return `${amount / 100000n}.${(amount % 100000n).toString().padStart(5, "0")}`.replace(/\.?0+$/, "") || "0"; };
  async function begin(mode) {
    if (opening || active) throw Error("Finish or stop the current credit run first");
    opening = true;
    try {
      const info = await window.KaiNetwork.refresh(); if (info.product !== "prepaid-usd-v1" || info.activation !== "ready" || info.runBudgets !== true || info.blocked) throw Error(info.blocked || "Advanced network modes are unavailable for this account");
      const selected = window.KaiNetwork.selectedModel();
      if (Array.isArray(info.models) && !selected?.available) throw Error("Choose an available network model before starting this run.");
      document.getElementById("credit-run-error").textContent = "";
      document.getElementById("credit-run-free-only").checked = false; paintCost();
      const accepted = await new Promise(resolve => { dialog.addEventListener("close", () => resolve(dialog.returnValue === "start"), { once: true }); dialog.showModal(); });
      if (!accepted) return false;
      const budget = document.getElementById("credit-run-budget").value.trim(), freeOnly = document.getElementById("credit-run-free-only").checked;
      const result = await bridge.run("run-open", { mode, budget, freeOnly, ...(window.KaiNetwork.paidFirst?.() === true && !freeOnly ? { paidFirst: true } : {}), ...(selected ? { model: selected.model } : {}) });
      if (!/^[a-f0-9]{64}$/.test(result.run?.id || "")) throw Error("Run approval unavailable");
      active = result.run; return true;
    } finally { opening = false; }
  }
  dialog.querySelector("form").addEventListener("submit", event => {
    if (event.submitter?.value !== "start") return;
    const value = document.getElementById("credit-run-budget").value.trim();
    if (!/^(0|[1-9]\d{0,13})(\.\d{1,5})?$/.test(value) || Number(value) <= 0) { event.preventDefault(); document.getElementById("credit-run-error").textContent = "Enter a positive total budget with up to five decimal places."; }
  });
  async function dispatch(request) {
    if (!active) return bridge.run("chat-completion", request);
    const maxOutput = window.KaiNetwork.info.models?.find(m => m.model === active.model)?.maxOutput || window.KaiNetwork.info.maxOutput;
    return bridge.run("run-chat", { runId: active.id, callId: random(), request: { ...request, max_tokens: Math.min(request.max_tokens || maxOutput, maxOutput) } });
  }
  function execute(kind, body, init = {}) {
    if (!active) throw Error("Approve a total run budget first"); const id = active.id, encoder = new TextEncoder();
    let controller, ended = false;
    const frame = value => { if (!ended) controller.enqueue(encoder.encode("data: " + JSON.stringify(value) + "\n\n")); };
    const stop = () => { bridge.run("stop").catch(() => {}); bridge.run("run-stop", id).catch(() => {}); };
    const unsubscribe = bridge.onProgress(value => { if (value?.runId === id && value.trace) frame({ trace: value.trace }); });
    const stream = new ReadableStream({ start(c) { controller = c; }, cancel() { ended = true; stop(); unsubscribe(); } });
    init.signal?.throwIfAborted(); init.signal?.addEventListener("abort", stop, { once: true });
    bridge.run("run-execute", { runId: id, kind, body }).then(result => frame(init.signal?.aborted
      ? { done: true, error: "Stopped. Delivered intermediate results are saved in Account help → Research & agent results." } : { done: true, ...result })).catch(error => frame({ done: true, error: error.message })).finally(() => {
      unsubscribe(); init.signal?.removeEventListener("abort", stop); if (!ended) { ended = true; controller.close(); }
    });
    return Promise.resolve(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  }
  async function show(id, target) {
    target.textContent = "Recovering saved results…";
    try {
      const result = await bridge.run("run-status", id); target.replaceChildren();
      const summary = document.createElement("p"); summary.textContent = `${result.run.state} · ${credits(result.run.spent)} credits used · total budget ${credits(result.run.maxTotal)} credits`; target.appendChild(summary);
      if (result.run.state === "open") {
        const stopSaved = document.createElement("button"); stopSaved.textContent = "Stop this saved run";
        stopSaved.addEventListener("click", async () => { stopSaved.disabled = true; try { await bridge.run("run-stop", id); await show(id, target); } catch (e) { stopSaved.disabled = false; summary.textContent = e.message; } });
        target.appendChild(stopSaved);
      }
      for (const [index, step] of result.steps.entries()) { const label = document.createElement("strong"), text = document.createElement("pre"); label.textContent = `Saved result ${index + 1} · ${credits(step.credits)} credits`; text.textContent = step.text; text.style.whiteSpace = "pre-wrap"; target.append(label, text); }
      if (!result.steps.length) { const empty = document.createElement("p"); empty.textContent = "No delivered results are saved for this run."; target.appendChild(empty); }
    } catch (e) { target.textContent = e.message; }
  }
  async function history() {
    const host = document.getElementById("credit-run-history");
    try {
      const result = await bridge.run("run-list"); host.replaceChildren();
      for (const run of result.runs) {
        const row = document.createElement("details"), title = document.createElement("summary"), body = document.createElement("div");
        title.textContent = `${run.mode} · ${new Date(run.createdAt).toLocaleString()} · ${credits(run.maxTotal)} credit ceiling`; row.append(title, body); host.appendChild(row);
        row.addEventListener("toggle", () => { if (row.open) show(run.id, body); });
      }
      if (!result.runs.length) host.textContent = "No saved runs for this account and network.";
    } catch (e) { host.textContent = e.message; }
  }
  async function finish() {
    if (!active) return; const id = active.id; active = null;
    await bridge.run("run-stop", id).catch(() => {}); await history(); window.KaiCredits?.refresh();
  }
  function paintCost() {
    document.getElementById("credit-run-cost").textContent = document.getElementById("credit-run-free-only").checked
      ? "This run uses free credits only, up to the total budget."
      : window.KaiNetwork.paidFirst?.() === true
        ? "Purchased credits are used first, then eligible free credits, up to this total budget."
        : "Free credits are used first. Purchased credits may cover the rest, up to this total budget.";
  }
  document.getElementById("credit-run-free-only").addEventListener("change", paintCost);
  saved.addEventListener("toggle", () => { if (saved.open) history(); });
  window.KaiCreditRuns = { begin, dispatch, execute, finish, get active() { return active; }, input: (inputId, text) => bridge.run("run-input", { runId: active?.id, inputId, text }), stop: () => active ? bridge.run("run-stop", active.id) : Promise.resolve() };
})();
