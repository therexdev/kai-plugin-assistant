"use strict";
(() => {
  const bridge = window.kaiProviderBridge;
  const read = (key, fallback = "") => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* optional */ } };
  const isModel = model => typeof model === "string" && model.startsWith("desktop:");
  const label = model => model?.startsWith("desktop:openai:") ? "OpenAI" : model?.startsWith("desktop:anthropic:") ? "Anthropic" : "";
  let current = { available: false, providers: [] }, refreshPending;
  async function checked(promise) {
    const result = await promise;
    if (!result?.ok) throw new Error(result?.error || "Desktop provider connection unavailable.");
    return result;
  }
  async function refresh() {
    if (!bridge) return current;
    if (!refreshPending) refreshPending = checked(bridge.status()).then(result => (current = result)).finally(() => { refreshPending = null; });
    return refreshPending;
  }
  function models() {
    if (!current.available || current.locked || current.blocked) return [];
    return current.providers.filter(p => p.configured).flatMap(p => p.models.map(m => ({
      alias: `desktop:${p.id}:${m.id}`, label: `${p.label} · ${m.label}`, status: "ready", contextSize: 32768,
    })));
  }
  async function chatFetch(url, init) {
    let body = JSON.parse(init.body);
    init.signal?.throwIfAborted();
    if (window.KaiCompanionClient) body = await window.KaiCompanionClient.enrich(body, init.signal);
    init.signal?.throwIfAborted();
    if (body.model?.startsWith("koinos-network") && window.KaiNetwork) {
      const network = await window.KaiNetwork.refresh();
      if (network.configured) return window.KaiNetwork.chatFetch(body, init);
    }
    if (!isModel(body.model)) return fetch(url, { ...init, body: JSON.stringify(body) });
    if (!bridge) throw new Error("This model is available only in the desktop app.");
    const signal = init.signal;
    if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
    const id = crypto.randomUUID(), encoder = new TextEncoder();
    let controller, finished = false, unsubscribe;
    const cleanup = () => { unsubscribe?.(); signal?.removeEventListener("abort", abort); };
    const error = (message, aborted) => {
      if (finished) return;
      finished = true; cleanup(); controller.error(aborted ? new DOMException("Stopped", "AbortError") : new Error(message));
    };
    const abort = () => { bridge.cancel(id).catch(() => {}); error("Stopped", true); };
    const stream = new ReadableStream({
      start(c) { controller = c; },
      cancel() { finished = true; cleanup(); bridge.cancel(id).catch(() => {}); },
    });
    unsubscribe = bridge.onDelta(event => {
      if (event.id !== id || finished) return;
      if (event.error) return error(event.error, event.aborted);
      if (event.content) controller.enqueue(encoder.encode("data: " + JSON.stringify({ model: body.model,
        servedModel: label(body.model), choices: [{ delta: { content: event.content } }] }) + "\n\n"));
      if (event.done) {
        finished = true; cleanup();
        controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: event.finishReason || "stop" }], warning: event.warning }) + "\n\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close();
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    bridge.chat(id, body).then(result => { if (!result?.ok) error(result?.error || "Could not start the provider request.", result?.aborted); }, () => error("Desktop provider connection unavailable."));
    if (signal?.aborted) abort();
    if (body.stream !== false) return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    // Planning uses the same cancellable streaming connection internally, then
    // receives the ordinary completion shape expected by both agent runtimes.
    let content = "", buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let at;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const data = frame.slice(6);
        if (data !== "[DONE]") content += JSON.parse(data).choices[0].delta.content || "";
      }
    }
    return Response.json({ model: body.model, choices: [{ message: { role: "assistant", content } }] });
  }
  function fillSettings() {
    const host = document.getElementById("desktop-providers");
    if (!host) return;
    host.hidden = !bridge;
    if (!bridge) return;
    const note = document.getElementById("provider-privacy");
    KaiI18n.setText(note, current.locked ? "Saved keys could not be unlocked. Restart with your original OS account and keychain." :
      !current.available ? "Unlock your system keychain and restart to use secure provider storage." :
      current.blocked ? "Local-Only currently blocks online requests. Open Local API → Privacy and choose Local-First to use these connections. Provider chats always go directly to the selected provider." :
      "Online requests allowed. Provider chats go directly to the selected provider; your earning node keeps its own models.");
    for (const p of current.providers) {
      const card = document.getElementById("provider-" + p.id);
      if (!card) continue;
      KaiI18n.setText(card.querySelector("[data-provider-state]"), p.configured ? `Key saved · ${p.models.length} model${p.models.length === 1 ? "" : "s"}` : "Not connected");
      card.querySelector("input[type=password]").placeholder = p.configured ? "Saved securely · enter a replacement key" : "Paste your API key";
      for (const b of card.querySelectorAll("button")) b.disabled = !current.available || current.locked ||
        (["refresh", "use"].includes(b.dataset.providerAction) && (!p.configured || current.blocked)) ||
        (b.dataset.providerAction === "remove" && !p.configured) || (b.dataset.providerAction === "use" && !p.models.length);
    }
  }
  async function renderSettings() {
    try { await refresh(); fillSettings(); } catch { /* Core startup / shell unavailable */ }
  }
  document.getElementById("desktop-providers")?.addEventListener("click", async event => {
    const button = event.target.closest("[data-provider-action]");
    if (!button || button.disabled) return;
    const card = button.closest("[data-provider]"), id = card.dataset.provider, action = button.dataset.providerAction;
    const status = card.querySelector("[data-provider-result]");
    if (action === "use") { window.dispatchEvent(new CustomEvent("kai-provider-use", { detail: id })); return; }
    const keyField = card.querySelector("input[type=password]");
    const options = { key: keyField.value, model: card.querySelector("[data-provider-model]").value };
    if (action === "save") keyField.value = "";
    card.querySelectorAll("button").forEach(b => { b.disabled = true; });
    KaiI18n.setText(status, action === "refresh" ? "Checking your key and available models…" : "Saving…");
    try {
      current = await checked(bridge[action](id, options));
      KaiI18n.setText(status, action === "save" ? "Saved securely. Test & refresh models to check access, or use your model ID." :
        action === "refresh" ? "Connected. Models refreshed. Choose Use in chat or pick a brain in KAI." : "Connection removed.");
      window.dispatchEvent(new Event("kai-providers-changed"));
    } catch (e) { status.textContent = e.message; }
    finally { options.key = ""; fillSettings(); }
  });
  bridge?.onChanged(() => { refresh().then(() => { fillSettings(); window.dispatchEvent(new Event("kai-providers-changed")); }).catch(() => {}); });
  window.KaiProviders = { isModel, label, chatFetch, refresh, models, renderSettings, read, write,
    get status() { return current; }, get desktop() { return !!bridge; } };
})();
