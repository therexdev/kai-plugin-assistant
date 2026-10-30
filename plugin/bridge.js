"use strict";
// The sandboxed UI talks only to its own installed Assistant service.
// Assistant owns providers, conversations, speech and desktop controls.
(() => {
  const keys = ["kai-chat-mode", "kai-chat-source", "kai-web-search", "kai-credit-model", "kai-credit-paid-first", "kai-interface-language", "kai-chat-model-openai", "kai-chat-model-anthropic"];
  const originalSet = Storage.prototype.setItem, originalRemove = Storage.prototype.removeItem;
  let preferencesReady = false, saved = {}, writing = Promise.resolve();
  const persistPreferences = () => {
    const values = Object.fromEntries(keys.filter(key => localStorage.getItem(key) !== null).map(key => [key, localStorage.getItem(key)]));
    if (JSON.stringify(values) === JSON.stringify(saved)) return;
    saved = values;
    writing = writing.then(() => window.kai.call("storage.set", { key: "original-ui-preferences", value: values })).catch(error => {
      saved = {}; window.dispatchEvent(new CustomEvent("kai-preferences-error", { detail: error.message }));
    });
  };
  Storage.prototype.setItem = function(key, value) { originalSet.call(this, key, value); if (this === localStorage && preferencesReady && keys.includes(String(key))) persistPreferences(); };
  Storage.prototype.removeItem = function(key) { originalRemove.call(this, key); if (this === localStorage && preferencesReady && keys.includes(String(key))) persistPreferences(); };
  window.kaiAssistantPreferencesReady = window.kai.call("storage.get", { key: "original-ui-preferences" }).then(stored => {
    if (stored !== null && (!stored || typeof stored !== "object" || Array.isArray(stored))) throw Error("Saved Assistant preferences are unreadable; they were not replaced.");
    for (const key of keys) {
      const value = typeof stored?.[key] === "string" ? stored[key] : undefined;
      if (typeof value === "string") originalSet.call(localStorage, key, value);
    }
    preferencesReady = true; persistPreferences();
    const apply = () => {
      if (typeof setChatMode === "function") setChatMode(localStorage.getItem("kai-chat-mode") || "chat");
      if (typeof setWebSearch === "function") setWebSearch(localStorage.getItem("kai-web-search") === "1");
      const source = document.getElementById("src-pick"); if (source) { source.value = ""; source.dataset.sig = ""; }
      const paid = document.getElementById("network-paid-first"); if (paid) paid.checked = localStorage.getItem("kai-credit-paid-first") === "true";
      if (typeof refresh === "function") void refresh();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true }); else apply();
  }).catch(error => { const report = () => window.dispatchEvent(new CustomEvent("kai-preferences-error", { detail: error.message })); if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", report, { once: true }); else report(); });
  const invoke = (action, ...args) => window.kai.call("assistant.native", { action, args });
  const on = (channel, callback) => window.kai.onEvent(channel, callback);
  window.kaiProviderBridge = Object.freeze({
    status: () => invoke("providers:status"), save: (id, value) => invoke("providers:save", id, value),
    remove: id => invoke("providers:remove", id), refresh: id => invoke("providers:refresh", id),
    chat: (id, body) => invoke("providers:chat", id, body), cancel: id => invoke("providers:cancel", id),
    onDelta: callback => on("providers:delta", callback), onChanged: callback => on("providers:changed", callback),
  });
  window.kaiCompanionBridge = Object.freeze(Object.fromEntries(["manage", "context", "tools", "tool", "activity", "session", "cancel"].map(action => [action, (...args) => invoke("companion:" + action, ...args)])));
  window.koinosShell = Object.freeze({ launchMascot: options => invoke("mascot:launch", options), onMascotOpenView: callback => on("mascot:open-view", callback) });
  window.kaiLanguageBridge = Object.freeze({ get: () => invoke("language:get"), save: language => invoke("language:save", language), onChanged: callback => on("shell:language-changed", callback) });
  window.kaiKoinTestBridge = Object.freeze({ run: (action, input) => window.kai.call("assistant.payment", { action, input }), onProgress: callback => on("koin:chat-progress", callback) });
  window.fetch = async (path, init = {}) => {
    if (typeof path !== "string" || !path.startsWith("/core/") || path.includes("#")) throw Error("Assistant requests must use its reviewed Core APIs");
    init.signal?.throwIfAborted();
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    let body = init.body, bodyBase64;
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob) {
      const bytes = new Uint8Array(body instanceof Blob ? await body.arrayBuffer() : body instanceof ArrayBuffer ? body : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
      let text = ""; for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
      bodyBase64 = btoa(text); body = undefined;
    }
    const result = await window.kai.call("assistant.request", { path, method: init.method || "GET", headers, ...(body === undefined ? {} : { body }), ...(bodyBase64 === undefined ? {} : { bodyBase64 }), stream: true });
    if (!result.streamId) return new Response(result.bodyBase64 ? Uint8Array.from(atob(result.bodyBase64), c => c.charCodeAt(0)) : typeof result.body === "string" ? result.body : JSON.stringify(result.body), { status: result.status, headers: result.headers });
    const streamId = result.streamId; let ended = false;
    const cancel = () => { if (!ended) void window.kai.call("assistant.cancel", { streamId }).catch(() => {}); };
    init.signal?.addEventListener("abort", cancel, { once: true });
    const stream = new ReadableStream({
      async pull(controller) {
        if (ended) return;
        try {
          init.signal?.throwIfAborted();
          await new Promise(resolve => setTimeout(resolve, 100));
          const next = await window.kai.call("assistant.poll", { streamId });
          init.signal?.throwIfAborted();
          if (next.error) throw Error(next.error);
          for (const chunk of next.chunks || []) controller.enqueue(new TextEncoder().encode(chunk));
          if (next.done) { ended = true; init.signal?.removeEventListener("abort", cancel); controller.close(); }
        } catch (error) { cancel(); ended = true; init.signal?.removeEventListener("abort", cancel); controller.error(error); }
      },
      cancel() { cancel(); ended = true; init.signal?.removeEventListener("abort", cancel); },
    });
    return new Response(stream, { status: result.status, headers: result.headers });
  };
})();
