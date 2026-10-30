"use strict";
(() => {
  const bridge = window.kaiKoinTestBridge;
  let info = { configured: false }, pending, availabilityTimer;
  const progress = text => { const node = document.getElementById("network-chat-status"); if (node) { node.textContent = text; node.dataset.source = "chat"; } };
  const amount = value => { const n = BigInt(value); return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")}`; };
  const alias = value => String(value || "").replace(/^koinos-network:/, "");
  const paidFirstPreference = () => localStorage.getItem("kai-credit-paid-first") === "true";
  function paintCreditPriority() {
    const toggle = document.getElementById("network-paid-first"), help = document.getElementById("network-credit-priority-help");
    if (!toggle || !help) return;
    const supported = info.product === "prepaid-usd-v1" && info.creditPriority === true && !info.blocked;
    toggle.checked = info.freeOnlySession === true ? false : paidFirstPreference();
    // A saved preference can always be turned off, even during an outage.
    toggle.disabled = info.freeOnlySession === true || !supported && !toggle.checked;
    help.textContent = info.deviceFree === true ? "Free credits are ready to use. Buying credits connects your KOIN wallet."
      : info.freeOnlySession === true ? "This temporary connection uses free credits only. Your saved credit priority applies again when you reconnect with protected storage."
      : supported ? (toggle.checked
      ? "Purchased credits are used first. Eligible free credits cover the rest when needed. Your choice is saved on this computer."
      : "Free credits are used first on eligible models, then purchased credits. Your choice is saved on this computer.")
      : toggle.checked ? "Paid-first is saved, but network support is unavailable. Turn it off to use free credits first."
      : ["signin-required", "wallet-connection-required", "wallet-reauthorization-required", "secure-storage-required"].includes(info.activation) ? "Free credits are used first. Connect your wallet in Credits to check your available credit options."
      : "Free credits are used first. Paid-first will be available after the network service update.";
    const chatHelp = document.getElementById("network-chat-help");
    if (chatHelp && info.maxRequestCredits) chatHelp.textContent = `Send a message to use your credits. ${info.deviceFree ? "Free credits are used automatically." : info.freeOnlySession ? "This temporary connection uses free credits only." : toggle.checked ? "Purchased credits are used first." : "Free credits are used first."} Up to ${info.maxRequestCredits} credits per message.`;
  }
  function paidFirst() {
    if (info.freeOnlySession === true) return false;
    const selected = paidFirstPreference();
    if (selected && (info.creditPriority !== true || info.blocked)) throw Error("Paid-first is unavailable on this network. Turn it off in Settings to use free credits first.");
    return selected;
  }
  function selectedModel(value = document.getElementById("model-pick")?.value) {
    return Array.isArray(info.models) ? info.models.find(m => m.model === alias(value)) : null;
  }
  function availabilityFresh() {
    return !info.blocked && (info.modelAvailabilityUntil === undefined || Number.isSafeInteger(info.modelAvailabilityUntil) && info.modelAvailabilityUntil > Date.now());
  }
  function paintPrice() {
    const node = document.getElementById("network-model-price"); if (!node) return;
    const visible = info.product === "prepaid-usd-v1" && Array.isArray(info.models) && document.getElementById("src-pick")?.value === "network";
    node.hidden = !visible;
    if (!visible) return;
    if (info.blocked) { node.textContent = info.blocked; return; }
    const model = selectedModel();
    node.textContent = model ? `${model.label || model.model} · ${!availabilityFresh() ? "Checking availability" : model.available ? "Available" : "Unavailable"} · ${model.inputCreditsPerMillion} input / ${model.outputCreditsPerMillion} output credits per million tokens`
      : "This selected model is unavailable. Choose another network model.";
  }
  async function refresh() {
    if (!bridge) return info;
    if (!pending) pending = bridge.run("chat-info").then(value => {
      if (!value || typeof value.enabled !== "boolean") throw Error("Network configuration unavailable");
      const wasFresh = availabilityFresh(), changed = JSON.stringify(info.models) !== JSON.stringify(value.models);
      info = value;
      // Historical payment setup has its own account-help panel. A late
      // legacy read must not leave its connection instruction below a ready
      // current-service chat, or erase this chat's own progress/errors.
      const chatStatus = document.getElementById("network-chat-status");
      if (value.configured && value.product === "prepaid-usd-v1" && chatStatus?.dataset.source === "legacy") {
        chatStatus.textContent = ""; delete chatStatus.dataset.source;
      }
      clearTimeout(availabilityTimer);
      if (Number.isSafeInteger(value.modelAvailabilityUntil) && value.modelAvailabilityUntil > Date.now()) {
        availabilityTimer = setTimeout(() => { paintPrice(); window.dispatchEvent(new Event("kai-network-models-changed")); }, value.modelAvailabilityUntil - Date.now());
      }
      if (value.activation === "ready") window.KaiCredits?.refresh();
      paintCreditPriority();
      const recover = document.getElementById("network-recover"); if (recover) recover.hidden = !info.recoveryAvailable;
      paintPrice();
      if (changed || wasFresh !== availabilityFresh()) window.dispatchEvent(new Event("kai-network-models-changed"));
      return info;
    }).catch(error => {
      clearTimeout(availabilityTimer); info = { ...info, configured: true, blocked: "Network configuration unavailable. Refresh your network account." };
      paintPrice(); paintCreditPriority(); window.dispatchEvent(new Event("kai-network-models-changed")); throw error;
    }).finally(() => { pending = null; });
    return pending;
  }
  async function chatFetch(body, init) {
    const current = await refresh();
    if (!current.configured) throw Error("Connect your network account before using paid chat");
    if (current.blocked) throw Error(current.blocked);
    if (current.product === "prepaid-usd-v1" && Array.isArray(current.models)) {
      const model = selectedModel(body.model);
      if (!model?.available) throw Error("This network model is unavailable. Choose an available model; your credits have not been charged.");
    }
    if (current.product === "prepaid-usd-v1") body = { ...body, freeOnly: current.freeOnlySession === true, paidFirst: paidFirst() };
    if (body.stream !== false && ["prepaid-v1", "prepaid-usd-v1"].includes(current.product)) return streamFetch(body, init);
    const signal = init.signal, stop = () => { bridge.run("stop").catch(() => {}); };
    signal?.throwIfAborted(); signal?.addEventListener("abort", stop, { once: true });
    progress("Checking your network account…");
    try {
      const result = await (window.KaiCreditRuns ? window.KaiCreditRuns.dispatch(body) : bridge.run("chat-completion", body));
      signal?.throwIfAborted();
      const charge = result.koin?.receipt?.usage?.amount;
      const creditText = charge ? (() => { const n = BigInt(charge); return `${n / 100000n}.${(n % 100000n).toString().padStart(5, "0")}`.replace(/\.?0+$/, "") || "0"; })() : "0";
      const warning = ["prepaid-v1", "prepaid-usd-v1"].includes(result.koin?.product) ? `${creditText} credits` : charge ? `${amount(charge)} KOIN · ${result.koin.state === "settled" ? "settled" : "verified usage, settlement pending"}` : "Verified network answer";
      const headers = { "x-kai-paid-request": result.id, "x-kai-buffered": "true" };
      progress(warning);
      if (body.stream === false) return Response.json(result, { headers });
      const frame = { model: "koinos-network", servedModel: result.servedModel, choices: [{ delta: { content: result.choices[0].message.content } }], warning };
      return new Response("data: " + JSON.stringify(frame) + "\n\ndata: [DONE]\n\n", { headers: { ...headers, "content-type": "text/event-stream" } });
    } catch (error) {
      const message = String(error.message || "Request interrupted. Send the original message again to recover it.")
        .replace(/^Error invoking remote method 'koin:test-payments': (?:Error: )?/, "");
      progress(message); throw Object.assign(new Error(message), { name: error.name });
    }
    finally { signal?.removeEventListener("abort", stop); window.dispatchEvent(new Event("kai-network-account-changed")); }
  }
  function streamFetch(body, init) {
    const signal = init.signal; signal?.throwIfAborted();
    let response, controller, prefix = "", requestId, finished = false, unsubscribe;
    const encoder = new TextEncoder(), stop = () => { bridge.run("stop").catch(() => {}); };
    const cleanup = () => { unsubscribe?.(); signal?.removeEventListener("abort", stop); window.dispatchEvent(new Event("kai-network-account-changed")); };
    const frame = value => { if (!finished) controller.enqueue(encoder.encode("data: " + JSON.stringify(value) + "\n\n")); };
    const stream = new ReadableStream({
      start(c) { controller = c; },
      cancel() { finished = true; stop(); cleanup(); },
    });
    response = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    unsubscribe = bridge.onProgress?.(value => {
      if (finished || typeof value?.delta !== "string" || !/^[a-f0-9]{64}$/.test(value.requestId || "")) return;
      if (requestId && requestId !== value.requestId) return;
      requestId = value.requestId; response.headers.set("x-kai-paid-request", requestId);
      prefix += value.delta;
      frame({ model: "koinos-network", servedModel: value.servedModel, choices: [{ delta: { content: value.delta } }] });
    });
    signal?.addEventListener("abort", stop, { once: true });
    (window.KaiCreditRuns ? window.KaiCreditRuns.dispatch(body) : bridge.run("chat-completion", body)).then(result => {
      if (finished) return;
      const output = result.choices?.[0]?.message?.content || "";
      if (!output.startsWith(prefix)) throw Error("The saved reply differs from the verified stream");
      response.headers.set("x-kai-paid-request", result.id);
      if (!prefix) response.headers.set("x-kai-buffered", "true");
      const n = BigInt(result.koin?.receipt?.usage?.amount || "0");
      const credits = `${n / 100000n}.${(n % 100000n).toString().padStart(5, "0")}`.replace(/\.?0+$/, "") || "0";
      frame({ model: "koinos-network", servedModel: result.servedModel, choices: [{ delta: { content: output.slice(prefix.length) } }], warning: `${credits} credits` });
      controller.enqueue(encoder.encode("data: [DONE]\n\n")); finished = true; controller.close(); progress(`${credits} credits`);
    }).catch(error => {
      if (!finished) { finished = true; controller.error(error); progress(String(error.message || "Stream interrupted. Your saved reply can be recovered.")); }
    }).finally(cleanup);
    return response;
  }
  bridge?.onProgress?.(value => { if (typeof value?.text === "string") progress(value.text); });
  const paidFirstToggle = document.getElementById("network-paid-first");
  paidFirstToggle?.addEventListener("change", () => {
    localStorage.setItem("kai-credit-paid-first", String(paidFirstToggle.checked)); paintCreditPriority();
  });
  document.getElementById("nav-settings")?.addEventListener("click", () => refresh().catch(() => {}));
  paintCreditPriority();
  document.getElementById("network-add-koin")?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("kai-network-add-koin", { detail: document.getElementById("network-koin-amount").value }));
  });
  document.getElementById("network-account")?.addEventListener("click", () => window.dispatchEvent(new Event("kai-network-account")));
  document.getElementById("network-recover")?.addEventListener("click", () => window.dispatchEvent(new Event("kai-network-recover")));
  document.getElementById("model-pick")?.addEventListener("change", paintPrice);
  document.getElementById("model-pick")?.addEventListener("focus", () => { if (document.getElementById("src-pick")?.value === "network") refresh().catch(() => {}); });
  window.KaiNetwork = { refresh, chatFetch, selectedModel, paintPrice, availabilityFresh, paidFirst, get info() { return info; },
    acknowledge: async id => {
      const result = await bridge.run("chat-ack", id);
      // Finish any read started before delivery, then sample recovery again.
      // A successful saved reply must not advertise interrupted recovery.
      if (pending) await pending.catch(() => {});
      await refresh(); return result;
    },
    recover: () => bridge.run("chat-recover"),
    paint() {
      paintPrice();
      const network = document.getElementById("src-pick")?.value === "network", strip = document.getElementById("network-chat-account"); if (strip) strip.hidden = !(info.configured && network);
      const pick = document.getElementById("mode-pick");
      const unavailable = network && (info.product !== "prepaid-usd-v1" || info.activation !== "ready" || info.runBudgets !== true || !!info.blocked);
      for (const option of pick?.options || []) {
        if (option.value === "chat") continue;
        if (unavailable) { if (!option.dataset.creditDisabled) option.dataset.creditDisabled = String(option.disabled); option.disabled = true; option.title = "This network has not activated shared credit run budgets."; }
        else if (option.dataset.creditDisabled !== undefined) { option.disabled = option.dataset.creditDisabled === "true"; delete option.dataset.creditDisabled; option.title = ""; }
      }
      for (const id of ["btn-pg-run", "btn-dev-run"]) {
        const button = document.getElementById(id); if (!button) continue;
        if (unavailable) { if (button.dataset.creditDisabled === undefined) button.dataset.creditDisabled = String(button.disabled); button.disabled = true; button.title = "Shared network run budgets are unavailable. Choose a local route."; }
        else if (button.dataset.creditDisabled !== undefined) { button.disabled = button.dataset.creditDisabled === "true"; delete button.dataset.creditDisabled; button.title = ""; }
      }
      if (pick?.selectedOptions[0]?.disabled && network) { pick.value = "chat"; pick.dispatchEvent(new Event("change")); }
    } };
})();
