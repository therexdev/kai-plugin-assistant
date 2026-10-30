"use strict";

/*
 * Koinos AI desktop renderer. Plain web app served by Core's own gateway —
 * everything goes over same-origin HTTP, so the identical code runs inside
 * the Electron shell or a plain browser tab. State machine:
 *   connecting -> onboarding (no model ready) -> chat (model ready)
 */

const $ = (id) => document.getElementById(id);

const state = {
  view: "chat",
  routed: false, // true once the user picks a view themselves
  alias: null, // the model alias we chat with
  ready: false, // runtime serving that alias
  chatting: false,
  abort: null,
  history: [], // [{role, content}]
  chatId: null, // persisted id of the open conversation
  chatIndex: [], // [{id,title,updatedAt,searchText}] for the sidebar
};

// ---------- boot / status polling ----------

async function coreGet(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Core answered ${r.status} for ${path}`);
  return r.json();
}

let pollTimer = null;
function schedule(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refresh, ms);
}

async function refresh() {
  clearTimeout(pollTimer);
  let models;
  try {
    models = await coreGet("/core/models");
  } catch {
    setStatus("err", "Core unreachable");
    schedule(1500);
    return;
  }

  // Prefer a model that's already on disk (returning user goes straight
  // to chat); a fresh install onboards onto the first NON-DEV catalog
  // alias — the launch model. Dev pipeline models are picked only when
  // they're the only thing ready (CI, dev machines).
  const first =
    models.aliases.find((a) => a.status === "ready" && !a.dev) ||
    models.aliases.find((a) => a.status === "ready") ||
    models.aliases.find((a) => !a.dev) ||
    models.aliases[0] ||
    null;
  state.alias = state.alias || first?.alias || null;
  const entry = models.aliases.find((a) => a.alias === state.alias) || first;
  const running = models.runtime?.runtime?.running && models.runtime.activeAlias === state.alias;
  state.ready = !!(entry && entry.status === "ready");
  // Finish asynchronous provider discovery before painting either status.
  // Otherwise every poll briefly renders local-model status above the launcher.
  await updateModelPick(models.aliases);

  if (models.download) {
    const { pct, done, total } = models.download;
    showProgress(pct, done, total);
    setStatus("busy", KaiI18n.message`Downloading model… ${pct ?? "?"}%`);
  } else if (models.runtimeDownload?.phase === "extracting") {
    showProgress(null);
    setStatus("busy", "Setting up engine… (one time — takes a few minutes, the app stays usable)");
  } else if (models.runtimeDownload) {
    const { pct, done, total } = models.runtimeDownload;
    showProgress(pct, done, total);
    setStatus("busy", KaiI18n.message`Downloading engine… ${pct ?? "?"}%`);
  } else if (models.ensure?.state === "working") {
    showProgress(null);
    setStatus("busy", "Loading model…");
  } else if (models.ensure?.state === "error" || models.runtime?.lastLoadError) {
    const reason = models.ensure?.error || models.runtime?.lastLoadError?.message || "";
    onboardError(reason);
    // The reason is actionable (engine stderr, missing file, quarantine) —
    // and truncating it hid the second engine's half of the story (field
    // finding). Full text, wrapped; the pane grows.
    setStatus("err", KaiI18n.message`Model load failed${reason ? ` — ${reason}` : ""}`);
    $("status-pane").title = reason;
  } else if (running) {
    setStatus("ok", "Model loaded");
  } else if (state.ready) {
    setStatus("ok", "Ready (model loads on first message)");
  } else {
    setStatus("busy", "Local model not installed");
  }
  KaiI18n.setText($("status-model"), entry ? entry.label.split(" (")[0] : "No models in catalog");
  const desktopReady = KaiProviders.models().some(m => m.alias === composedChatModel());
  if (desktopReady && !models.download && !models.ensure?.state) {
    setStatus("ok", "Desktop provider ready");
    $("status-model").textContent = KaiProviders.label(composedChatModel());
  }
  $("status-model").title = $("status-model").textContent;

  // Route: onboarding until the model file is on disk — but only until the user
  // goes somewhere themselves. This poll runs every few seconds, and it used to
  // slam the view back to onboarding each time, throwing anyone without a model
  // off whatever screen they were on mid-keystroke. The Koinos node in
  // particular needs no model at all.
  const route = state.ready || desktopReady || state.routed ? state.view : "onboarding";
  showView(route, { navOnly: true });
  if (!state.ready && entry) renderOnboarding(entry);

  const busy = models.download || models.ensure?.state === "working";
  schedule(busy ? 500 : 4000);
}

// Version tag in the sidebar footer: fetched once, retried until Core answers.
async function loadVersion() {
  try {
    const h = await coreGet("/core/health");
    if (h.version) KaiI18n.setText($("app-version"), KaiI18n.message`${h.productName || "Koinos AI"} v${h.version}`);
    document.body.dataset.releaseChannel = h.channel || "stable";
    if (h.channel === "test") {
      document.title = "Koinos AI Test";
      const title = document.querySelector(".tb-title");
      if (title) KaiI18n.setText(title, "Koinos AI Test");
    }
  } catch {
    setTimeout(loadVersion, 3000);
  }
}
loadVersion();

/** The footer promise must match the chosen §7 mode — never overstate privacy. */
function updatePrivacyNote(mode) {
  const el = document.getElementById("privacy-note");
  if (!el || el.dataset.mode === mode) return;
  el.dataset.mode = mode;
  el.innerHTML =
    mode === "local-only"
      ? KaiI18n.html("Your chats never leave this machine.<br />(Node and earning use their own network controls.)")
      : mode === "local-first"
        ? KaiI18n.html("Local when possible. If this machine<br />can't serve a chat, it overflows to<br />Koinos Network — and says so.")
        : KaiI18n.html("Network mode on — chats sent to<br />Koinos Network leave this machine.");
  // Web search is egress by definition, so the toggle only exists outside
  // Local-Only — same contract as network chat, enforced again in Core.
  const webBtn = document.getElementById("btn-web");
  if (webBtn) {
    webBtn.hidden = mode === "local-only";
    if (mode === "local-only") setWebSearch(false);
  }
  // Research mode reads the web; in Local-Only it's greyed out with the why.
  // Agent mode stays — the tool registry hides egress tools by itself.
  const researchOpt = document.querySelector('#mode-pick option[value="research"]');
  if (researchOpt) {
    researchOpt.disabled = mode === "local-only";
    KaiI18n.setText(researchOpt, mode === "local-only" ? "🔬 Research — needs web (see Privacy)" : "🔬 Research");
    if (mode === "local-only" && getChatMode() === "research") setChatMode("chat");
  }
}

// ---- answer mode (Chat / Research / Agent), persisted like other prefs ----
function getChatMode() {
  return document.getElementById("mode-pick")?.value || "chat";
}
function setChatMode(m) {
  const pick = document.getElementById("mode-pick");
  if (pick) pick.value = m;
  try { localStorage.setItem("kai-chat-mode", m); } catch { /* private mode */ }
}
setChatMode((() => { try { return localStorage.getItem("kai-chat-mode") || "chat"; } catch { return "chat"; } })());
document.getElementById("mode-pick")?.addEventListener("change", () => setChatMode(getChatMode()));

/** One short non-streaming model call — the workhorse of research/agent
 *  phases. Same endpoint, same routing (local or network) as the chat. */
async function askModelOnce(messages, model) {
  const r = await KaiProviders.chatFetch("/core/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: state.abort?.signal,
    body: JSON.stringify({ model, stream: false, max_tokens: KaiProviders.isModel(model) ? 4096 : 900, messages }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error?.message || `Core answered ${r.status}`);
  return j?.choices?.[0]?.message?.content || "";
}

/** Plain-language consent for sensitive tools. The Core enforces this
 *  server-side (HTTP 428) — this dialog is how the user says yes. */
function confirmTool(name, args) {
  const pretty = name.replace(/^mcp:[^:]+:/, "");
  const detail = Object.entries(args || {}).map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`).join("\n");
  return Promise.resolve(window.confirm(`The AI wants to use a tool:\n\n${pretty}\n${detail ? "\n" + detail + "\n" : ""}\nAllow it this once?`));
}

// ---- web search toggle (persisted like other renderer prefs) ----
function setWebSearch(on) {
  state.webSearch = Boolean(on);
  try { localStorage.setItem("kai-web-search", on ? "1" : "0"); } catch { /* private mode */ }
  const b = document.getElementById("btn-web");
  if (b) b.classList.toggle("on", state.webSearch);
}
setWebSearch((() => { try { return localStorage.getItem("kai-web-search") === "1"; } catch { return false; } })());
document.getElementById("btn-web")?.addEventListener("click", () => setWebSearch(!state.webSearch));

/** Multi-step research before answering: search → read the top result →
 *  hand the model a bounded, cited context block. Deterministic on purpose —
 *  reliable with 4k-context local models, no flaky model-driven tool calls.
 *  Returns { context, citations } or null (caller answers from the model). */
async function webResearch(query, statusEl, signal) {
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
  setStatus("🌐 Searching the web…");
  let search;
  try {
    const r = await fetch("/core/search", {
      signal,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: query }),
    });
    if (r.status === 403) { setWebSearch(false); setStatus("🌐 Web search is off in Local-Only mode."); return null; }
    search = await r.json();
  } catch (e) { if (e.name === "AbortError") throw e; search = null; }
  const results = search?.results || [];
  if (!results.length) { setStatus("🌐 No web results — answering from the model."); return null; }

  // Read the best page we can (several independent results on failure) — the
  // "multi-action" part: search, then fetch, then answer.
  let extract = null;
  for (const cand of results.slice(0, 4)) {
    setStatus(`🌐 Reading ${cand.title || cand.url}…`);
    try {
      const r = await fetch("/core/fetch", {
        signal,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: cand.url }),
      });
      const j = await r.json();
      if (j.ok && j.page?.text) { extract = { ...j.page, from: cand }; break; }
    } catch (e) { if (e.name === "AbortError") throw e; /* try the next result */ }
  }

  // Budget hard: every char here competes with history in a 4k context.
  const lines = results.map((x, i) => `${i + 1}. ${x.title} — ${x.url}\n   ${x.snippet || ""}`).join("\n").slice(0, 1100);
  const body = extract ? `\n\nExtract from "${extract.title || extract.from.title}" (${extract.url}):\n${extract.text.slice(0, 1500)}` : "";
  const context =
    `🌐 Live web results for "${query.slice(0, 200)}" (fetched just now — prefer these over older knowledge; cite sources by number):\n${lines}${body}`;
  // The trace PERSISTS (field feedback: on slower network chats the flash of
  // status vanished and the agent looked like it never ran). What it did
  // stays on screen, above the reply, in every mode.
  let readHost = "";
  try { readHost = extract ? new URL(extract.url).hostname.replace(/^www\./, "") : ""; } catch { /* keep empty */ }
  setStatus(`🌐 Searched the web — ${results.length} source${results.length === 1 ? "" : "s"}${readHost ? ` · read ${readHost}` : ""}`);
  return { context, citations: results.map((x) => ({ title: x.title, url: x.url })) };
}

/** API wire format: image-bearing turns become OpenAI content parts (what
 *  llama-server-with-mmproj and Ollama vision models accept); everything else
 *  is plain {role, content} — UI-only fields (citations, images) never leak
 *  into the request body. */
function toWire(messages) {
  return messages.map((m) =>
    Array.isArray(m.images) && m.images.length
      ? {
          role: m.role,
          content: [
            { type: "text", text: String(m.content || "") },
            ...m.images.map((u) => ({ type: "image_url", image_url: { url: u } })),
          ],
        }
      : { role: m.role, content: m.content }
  );
}

/** Thumbnails on an image-bearing user message (data: URIs — CSP-safe). */
function renderMsgImages(el, images) {
  if (!Array.isArray(images) || !images.length) return;
  const row = document.createElement("div");
  row.className = "msg-images";
  for (const u of images.slice(0, 3)) {
    if (!String(u).startsWith("data:image/")) continue;
    const img = document.createElement("img");
    img.src = u;
    img.alt = "attached image";
    img.className = "msg-img";
    row.appendChild(img);
  }
  if (row.children.length) el.appendChild(row);
}

/** Citation chips under an assistant message — plain links, renderer-safe. */
function renderCitations(bubble, citations) {
  if (!Array.isArray(citations) || !citations.length) return;
  const div = document.createElement("div");
  div.className = "citations";
  for (const c of citations.slice(0, 8)) {
    if (!/^https?:\/\//i.test(c.url || "")) continue;
    const a = document.createElement("a");
    a.href = c.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "citation-chip";
    let host = "";
    try { host = new URL(c.url).hostname.replace(/^www\./, ""); } catch { /* keep title only */ }
    a.textContent = c.title ? `${c.title.slice(0, 60)}${host ? ` · ${host}` : ""}` : host || c.url;
    div.appendChild(a);
  }
  if (div.children.length) bubble.appendChild(div);
}

let networkEligible = false;
let pickable = []; // latest [{v,label}] the chat picker offers — reused by Compare/Tasks
async function updateModelPick(aliases) {
  await KaiProviders.refresh().catch(() => {});
  await window.KaiNetwork?.refresh().catch(() => {});
  let netBlockedWhy = "", networkPrivacyAllowed = false;
  try {
    const n = await coreGet("/core/network");
    // Wallet state is part of eligibility: advertising "Koinos Network"
    // while the wallet is locked just defers the failure to send time.
    networkPrivacyAllowed = n.privacyMode !== "local-only";
    networkEligible = networkPrivacyAllowed && !!n.schedulerUrl && n.walletUnlocked !== false;
    // Field finding (owner's Pi): with the Local-Only default, the network
    // source simply didn't EXIST in the picker and looked broken. Name the
    // reason so it's discoverable instead of invisible.
    if (!networkEligible) {
      netBlockedWhy =
        n.privacyMode === "local-only"
          ? "enable in Local API → Privacy"
          : !n.schedulerUrl
            ? "no network configured"
            : "unlock your wallet in Earn";
    }
    updatePrivacyNote(n.privacyMode);
    if (document.getElementById("privacy-pick") && document.activeElement?.id !== "privacy-pick") {
      $("privacy-pick").value = n.privacyMode;
    }
  } catch { networkEligible = false; }
  if (window.KaiNetwork?.info.configured) {
    networkEligible = networkPrivacyAllowed && !KaiNetwork.info.blocked;
    netBlockedWhy = networkPrivacyAllowed ? KaiNetwork.info.blocked || "" : "blocked by Local-Only";
  }
  const pick = $("model-pick");
  // Source + model, two boxes (field request): pick WHERE it runs, then
  // WHICH model. Local lists only models on this machine; Network lists
  // what live providers actually serve right now, plus Auto.
  state.localModels = aliases
    .filter((al) => al.status === "ready" && (!al.dev || al.alias === state.alias))
    .map((al) => ({ v: al.alias, label: al.label.split(" (")[0] }));
  state.aliasLabels = Object.fromEntries(aliases.map((al) => [al.alias, al.label.split(" (")[0]]));
  state.visionAliases = new Set(aliases.filter((al) => al.vision).map((al) => al.alias)); // gates image attach
  const src = $("src-pick");
  const srcSig = `local${networkEligible ? ",network" : `,blocked:${netBlockedWhy}`}` + JSON.stringify(KaiProviders.status);
  if (src.dataset.sig !== srcSig) {
    const prevSrc = src.value || (KaiProviders.desktop ? KaiProviders.read("kai-chat-source", "local") : "local");
    src.innerHTML = "";
    for (const [v, label] of [["local", "This machine"], ...(networkEligible ? [["network", "Koinos Network"]] : [])]) {
      const o = document.createElement("option");
      o.value = v; KaiI18n.setText(o, label);
      src.appendChild(o);
    }
    if (KaiProviders.desktop) for (const p of KaiProviders.status.providers) {
      const o = document.createElement("option"); o.value = p.id;
      const why = !KaiProviders.status.available || KaiProviders.status.locked ? "unlock secure storage" : !p.configured ? "connect in Settings" : KaiProviders.status.blocked ? "blocked by Local-Only" : !p.models.length ? "refresh models in Settings" : "";
      o.textContent = p.label + " · Desktop" + (why ? " — " + why : ""); o.disabled = !!why; src.appendChild(o);
    }
    if (!networkEligible && netBlockedWhy) {
      // Visible but not selectable — the network exists; here's how to get it.
      const o = document.createElement("option");
      o.value = "network"; o.disabled = true;
      KaiI18n.setText(o, KaiI18n.message`Koinos Network — ${netBlockedWhy}`);
      src.appendChild(o);
    }
    if ([...src.options].some((o) => o.value === prevSrc)) src.value = prevSrc;
    src.dataset.sig = srcSig;
  }
  // pickable keeps the flat shape Compare/Tasks/Docs already use.
  const want = [
    ...state.localModels.map((m) => ({ v: m.v, label: "Local · " + m.label })),
    ...(networkEligible ? (window.KaiNetwork?.info.product === "prepaid-usd-v1" && Array.isArray(KaiNetwork.info.models)
      ? KaiNetwork.info.models.filter(m => m.available).map(m => ({ v: "koinos-network:" + m.model, label: "Network · " + (m.label || m.model) }))
      : [{ v: "koinos-network", label: "Koinos Network · Auto" }]) : []),
  ];
  pickable = want;
  window.KaiNetwork?.paint();
  if (["openai", "anthropic"].includes(src.value)) {
    const providerModels = KaiProviders.models().filter(m => m.alias.startsWith("desktop:" + src.value + ":"));
    const sig = JSON.stringify(providerModels);
    if (pick.dataset.sig !== sig) {
      const prev = pick.value.startsWith("desktop:" + src.value + ":") ? pick.value : KaiProviders.read("kai-chat-model-" + src.value);
      pick.replaceChildren(...providerModels.map(m => { const o = document.createElement("option"); o.value = m.alias; o.textContent = m.label; return o; }));
      if (providerModels.some(m => m.alias === prev)) pick.value = prev;
      pick.dataset.sig = sig;
    }
    updateProviderNote();
    return;
  }
  if (src.value === "network") {
    await fillNetworkModelPick();
    return;
  }
  const sig = "local:" + state.localModels.map((w) => w.v).join(",");
  if (pick.dataset.sig !== sig) {
    const prev = pick.value;
    pick.innerHTML = "";
    for (const w of state.localModels) {
      const o = document.createElement("option");
      o.value = w.v;
      // 👁 marks vision-capable models — the ones that accept image attachments.
      o.textContent = state.visionAliases?.has(w.v) ? `${w.label} 👁` : w.label;
      pick.appendChild(o);
    }
    pick.dataset.sig = sig;
    // Keep the user's explicit choice when still offered; otherwise track
    // the READY model — defaulting to the first option regardless caused
    // chats to target a model that wasn't downloaded yet.
    if ([...pick.options].some((o) => o.value === prev)) pick.value = prev;
    else if (state.alias && [...pick.options].some((o) => o.value === state.alias)) pick.value = state.alias;
  }
}

/** Network source: the model box lists what live providers serve NOW. */
async function fillNetworkModelPick() {
  const pick = $("model-pick");
  if (window.KaiNetwork?.info.configured) {
    const current = KaiNetwork.info;
    if (current.product === "prepaid-usd-v1" && Array.isArray(current.models)) {
      const options = current.models.map(m => ({ value: "koinos-network:" + m.model, label: m.label || state.aliasLabels?.[m.model] || m.model, available: m.available === true && KaiNetwork.availabilityFresh() }));
      // Only an explicit model choice is sticky. A new customer starts with a
      // currently available model, even when the packaged default is offline.
      // Keep revisiting an automatic default as the first catalog arrives.
      const previous = localStorage.getItem("kai-credit-model");
      const automatic = pick.dataset.sig?.startsWith("paid-catalog:") ? pick.value : null;
      const defaultModel = "koinos-network:" + current.model;
      const selected = previous || options.find(o => o.value === defaultModel && o.available)?.value || options.find(o => o.available)?.value || automatic || defaultModel;
      // A disappearing/offline explicit choice remains visible; never replace it.
      if (selected && !options.some(o => o.value === selected)) options.push({ value: selected, label: selected.replace(/^koinos-network:/, ""), available: false });
      const sig = "paid-catalog:" + JSON.stringify(options);
      if (pick.dataset.sig !== sig) {
        pick.replaceChildren(...options.map(m => { const o = document.createElement("option"); o.value = m.value; o.textContent = m.label + (m.available ? "" : " · Unavailable"); o.disabled = !m.available; return o; }));
        pick.value = selected;
        pick.dataset.sig = sig;
      }
      KaiNetwork.paintPrice();
      return;
    }
    const model = KaiNetwork.info.model;
    pick.replaceChildren();
    if (model) { const option = document.createElement("option"); option.value = model; option.textContent = model + (["prepaid-v1", "prepaid-usd-v1"].includes(KaiNetwork.info.product) ? " · credits" : " · KOIN"); pick.appendChild(option); }
    pick.dataset.sig = "paid:" + model; return;
  }
  let net = { workersOnline: 0, models: [] };
  try {
    net = await coreGet("/core/network/models");
  } catch { /* offline — Auto only */ }
  const options = [
    { v: "auto", label: `Auto — best online${net.workersOnline ? ` (${net.workersOnline} computer${net.workersOnline === 1 ? "" : "s"})` : ""}` },
    ...net.models.map((m) => ({
      v: m.model,
      label: `${state.aliasLabels?.[m.model] || m.model} · ×${m.providers}`,
    })),
  ];
  const sig = "net:" + options.map((o) => o.v).join(",");
  if (pick.dataset.sig !== sig) {
    const prev = pick.value;
    pick.innerHTML = "";
    for (const w of options) {
      const o = document.createElement("option");
      o.value = w.v; o.textContent = w.label;
      pick.appendChild(o);
    }
    pick.dataset.sig = sig;
    if ([...pick.options].some((o) => o.value === prev)) pick.value = prev;
  }
}

function updateProviderNote() {
  const source = $("src-pick").value, note = $("privacy-note");
  if (["openai", "anthropic"].includes(source)) {
    note.dataset.mode = "desktop:" + source;
    KaiI18n.setText(note, KaiProviders.status.blocked ? "Local-Only blocks this online connection." : `Chat goes directly to ${source === "openai" ? "OpenAI" : "Anthropic"}. Your API account pays for usage.`);
  }
}
window.addEventListener("kai-providers-changed", () => { $("model-pick").dataset.sig = ""; refresh(); });
window.addEventListener("kai-network-models-changed", () => { if ($("src-pick").value === "network") fillNetworkModelPick(); });
window.addEventListener("kai-network-use", async event => {
  await updateModelPick((await coreGet("/core/models")).aliases);
  if (!networkEligible && !KaiNetwork.info.blocked) { activateView("api"); $("privacy-pick")?.focus(); return; }
  if (KaiNetwork.info.blocked) {
    if (KaiNetwork.info.product === "prepaid-usd-v1") { activateView("credits"); window.KaiWalletAccess?.open(); }
    else if (KaiNetwork.info.activation === "signin-required") { activateView("credits"); }
    else activateView("earn");
    return;
  }
  $("src-pick").value = "network"; $("mode-pick").value = "chat";
  $("src-pick").dispatchEvent(new Event("change")); activateView("chat"); $("input").focus();
  if (event.detail?.model) { await fillNetworkModelPick(); const wanted = KaiNetwork.info.product === "prepaid-usd-v1" && Array.isArray(KaiNetwork.info.models) ? "koinos-network:" + event.detail.model.replace(/^koinos-network:/, "") : event.detail.model; if ([...$("model-pick").options].some(o => o.value === wanted)) { $("model-pick").value = wanted; $("model-pick").dispatchEvent(new Event("change")); } }
});
window.addEventListener("kai-network-account", () => activateView("recovery"));
window.addEventListener("kai-network-recover", async () => {
  if (state.chatting) return;
  state.chatting = true; $("btn-send").disabled = true; $("network-recover").disabled = true; $("btn-stop").hidden = false;
  state.abort = new AbortController(); const stop = () => window.kaiKoinTestBridge.run("stop").catch(() => {});
  state.abort.signal.addEventListener("abort", stop, { once: true });
  try {
    const { completion, messages } = await KaiNetwork.recover();
    state.abort.signal.throwIfAborted();
    // Recover into a separate saved conversation, preserving the request's
    // actual turns rather than inserting its answer into an unrelated chat.
    state.chatId = null; state.history = messages.filter(m => m.role !== "system");
    $("messages").replaceChildren();
    for (const m of state.history) addMsg(m.role, m.content);
    const content = completion.choices[0].message.content, bubble = addMsg("assistant", content); attachMsgActions(bubble);
    state.history.push({ role: "assistant", content });
    if (await saveCurrentChat()) await KaiNetwork.acknowledge(completion.id);
    activateView("chat");
  } catch (e) { addMsg("error", String(e.message)); }
  finally { state.chatting = false; state.abort = null; $("btn-send").disabled = false; $("network-recover").disabled = false; $("btn-stop").hidden = true; window.dispatchEvent(new Event("kai-network-account-changed")); }
});
window.addEventListener("kai-provider-use", async event => {
  await updateModelPick((await coreGet("/core/models")).aliases);
  $("src-pick").value = event.detail; $("src-pick").dispatchEvent(new Event("change")); activateView("chat");
});
$("model-pick").addEventListener("change", () => {
  if (["openai", "anthropic"].includes($("src-pick").value)) KaiProviders.write("kai-chat-model-" + $("src-pick").value, $("model-pick").value);
  if ($("src-pick").value === "network" && $("model-pick").value.startsWith("koinos-network:")) localStorage.setItem("kai-credit-model", $("model-pick").value);
});
$("src-pick").addEventListener("change", () => {
  KaiProviders.write("kai-chat-source", $("src-pick").value);
  $("model-pick").dataset.sig = ""; // force refill for the new source
  coreGet("/core/models").then((m) => updateModelPick(m.aliases)).catch(() => {});
});

/** What send() should request, composed from the two boxes. */
function composedChatModel() {
  if (["openai", "anthropic"].includes($("src-pick").value)) return $("model-pick").value.startsWith("desktop:" + $("src-pick").value + ":") ? $("model-pick").value : "";
  if ($("src-pick").value === "network") {
    const m = $("model-pick").value;
    if (window.KaiNetwork?.info.product === "prepaid-usd-v1" && Array.isArray(KaiNetwork.info.models)) return m.startsWith("koinos-network:") ? m : "";
    return m === "auto" || !m ? "koinos-network" : `koinos-network:${m}`;
  }
  return $("model-pick").value || state.alias;
}

function setStatus(kind, text) {
  $("status-dot").className = `dot ${kind}`;
  $("status-pane").dataset.state = kind;
  $("status-pane").removeAttribute("title");
  KaiI18n.setText($("status-text"), text);
  $("status-text").title = $("status-text").textContent;
}

// ---------- onboarding ----------

async function renderOnboarding(entry) {
  $("offer-name").textContent = entry.label;
  KaiI18n.setText($("offer-sub"), KaiI18n.message`alias “${entry.alias}” · verified download`);
  if ($("hw-summary").childElementCount === 0) {
    try {
      const h = await coreGet("/core/health");
      const hw = h.hardware || {};
      const gpu = hw.gpus?.[0];
      const gpuSummary = gpu
        ? `${gpu.name}${gpu.vramMb ? ` · ${(gpu.vramMb / 1024).toFixed(0)} GB VRAM` : ""}`
        : hw.capabilities?.metalEligible
          ? "Apple Silicon · Metal acceleration"
          : "None detected — running on CPU";
      const rows = [
        ["System", `${hw.platform ?? "?"} · ${hw.arch ?? "?"}`],
        ["CPU", `${hw.cpu?.model ?? "?"} (${hw.cpu?.cores ?? "?"} threads)`],
        ["Memory", hw.ramBytes ? `${(hw.ramBytes / 1e9).toFixed(0)} GB` : "?"],
        ["GPU", gpuSummary],
      ];
      $("hw-summary").innerHTML = rows
        .map(([k, v]) => KaiI18n.html`<span class="k">${k}</span><span>${esc(v)}</span>`)
        .join("");
    } catch {
      /* health shows up on the next poll */
    }
  }
}

$("btn-download").addEventListener("click", async () => {
  $("btn-download").disabled = true;
  onboardError(null);
  showProgress(null); // instant feedback; real numbers arrive with the next poll
  const r = await fetch("/core/models/ensure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alias: state.alias }),
  });
  const j = await r.json();
  if (!j.ok) {
    onboardError(j.error);
  }
  refresh();
});

function showProgress(pct, done, total) {
  $("download-progress").hidden = false;
  $("btn-download").disabled = true;
  $("bar-fill").style.width = pct != null ? `${pct}%` : "12%";
  KaiI18n.setText($("bar-label"), pct != null
      ? `${pct}% · ${(done / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`
      : "Preparing…");
}

function onboardError(msg) {
  $("onboard-error").hidden = !msg;
  $("onboard-error").textContent = msg || "";
  if (msg) {
    $("download-progress").hidden = true;
    $("btn-download").disabled = false;
  }
}

// ---------- chat ----------

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send();
});
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$("btn-stop").addEventListener("click", () => state.abort?.abort());

function addMsg(role, text) {
  const empty = $("chat-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  // Assistant text is markdown (rendered through the escape-first
  // renderer); user text stays literal.
  if (role === "assistant") div.innerHTML = mdToHtml(text);
  else div.textContent = text;
  // Attached-file turns render collapsed — the model saw all of it; the
  // human only needs to know it's there.
  if (role === "user" && text.startsWith("📎 ")) {
    div.classList.add("msg-file");
    div.title = "Attached file (sent to the model in full) — click to expand";
    div.addEventListener("click", () => div.classList.toggle("expanded"));
  }
  if (role === "assistant" && text) attachMsgActions(div);
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
  return div;
}

/** Hover actions on an assistant bubble: copy, and (on the last) regenerate. */
function attachMsgActions(bubble) {
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  // Read aloud uses the OS voices Chromium ships (speechSynthesis): offline,
  // free, no downloads — hidden only if the platform has no voices at all.
  const canSpeak = "speechSynthesis" in window;
  bar.innerHTML = KaiI18n.html`<button type="button" class="msg-act" data-act="copy" title="Copy message">Copy</button>
    <button type="button" class="msg-act" data-act="regen" title="Ask again">Regenerate</button>
    <button type="button" class="msg-act" data-act="remember" title="Remember the key fact from this message across all chats">📌 Remember</button>${
      canSpeak ? KaiI18n.html`<button type="button" class="msg-act" data-act="speak" title="Read this reply aloud">🔊 Read</button>` : ""
    }`;
  bubble.appendChild(bar);
}

/** One utterance at a time; clicking again (or another message) stops it. */
function speakText(btn, text) {
  const speaking = window.speechSynthesis.speaking;
  window.speechSynthesis.cancel();
  for (const b of document.querySelectorAll('.msg-act[data-act="speak"]')) KaiI18n.setText(b, "🔊 Read");
  if (speaking && btn.dataset.speaking === "1") {
    delete btn.dataset.speaking;
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.onend = u.onerror = () => {
    KaiI18n.setText(btn, "🔊 Read");
    delete btn.dataset.speaking;
  };
  KaiI18n.setText(btn, "⏹ Stop");
  btn.dataset.speaking = "1";
  window.speechSynthesis.speak(u);
}

$("messages").addEventListener("click", async (e) => {
  const codeBtn = e.target.closest(".code-copy");
  if (codeBtn) {
    const code = codeBtn.closest(".code-block")?.querySelector("code")?.textContent || "";
    await window.kai.call("assistant.copyText", { text: code });
    KaiI18n.setText(codeBtn, "Copied");
    setTimeout(() => (KaiI18n.setText(codeBtn, "Copy")), 1200);
    return;
  }
  const act = e.target.closest(".msg-act");
  if (!act) return;
  const bubble = act.closest(".msg");
  if (act.dataset.act === "copy") {
    // History is the source of truth — the bubble's textContent would
    // include the action labels themselves.
    const idx = [...$("messages").querySelectorAll(".msg.assistant")].indexOf(bubble);
    const assistants = state.history.filter((m) => m.role === "assistant");
    await window.kai.call("assistant.copyText", { text: assistants[idx]?.content ?? "" });
    KaiI18n.setText(act, "Copied");
    setTimeout(() => (KaiI18n.setText(act, "Copy")), 1200);
  }
  if (act.dataset.act === "remember") {
    // Distill the message into ONE short fact worth keeping — the model
    // does the summarizing so the memory stays a note, not a transcript.
    const idx = [...$("messages").querySelectorAll(".msg.assistant")].indexOf(bubble);
    const assistants = state.history.filter((m) => m.role === "assistant");
    const src = assistants[idx]?.content ?? "";
    if (!src) return;
    act.textContent = "…";
    try {
      let fact = src.length <= 200 ? src : await askModelOnce([
        { role: "user", content: `Condense this into ONE short fact worth remembering long-term (max 25 words, no preamble):\n\n${src.slice(0, 2000)}` },
      ], state.alias);
      fact = String(fact || "").trim().slice(0, 300) || src.slice(0, 200);
      if (!window.kaiCompanionBridge) throw new Error("Open the desktop app to save memories in Brain.");
      const saved = await window.kaiCompanionBridge.manage("note", { text: fact, pinned: true });
      if (!saved?.ok) throw new Error(saved?.error || "Brain could not save this memory.");
      KaiI18n.setText(act, "📌 Remembered");
      setTimeout(() => (KaiI18n.setText(act, "📌 Remember")), 1600);
    } catch (error) {
      alert(error.message || "Brain could not save this memory.");
      KaiI18n.setText(act, "📌 Remember");
    }
  }
  if (act.dataset.act === "regen" && !state.chatting) {
    // Drop the answer being redone and replay the question.
    const lastUser = [...state.history].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    while (state.history.length && state.history[state.history.length - 1].role !== "user") state.history.pop();
    state.history.pop();
    rebuildMessages();
    send(lastUser.content);
  }
  if (act.dataset.act === "speak") {
    const idx = [...$("messages").querySelectorAll(".msg.assistant")].indexOf(bubble);
    const assistants = state.history.filter((m) => m.role === "assistant");
    speakText(act, assistants[idx]?.content ?? bubble.textContent ?? "");
  }
});

async function send(replayText) {
  const text = replayText ?? $("input").value.trim();
  if (!text || state.chatting) return;
  const chatModel = composedChatModel();
  if (!chatModel) { addMsg("error", "Choose an available model. For OpenAI or Anthropic, connect and refresh models in Settings; Local-Only blocks online connections."); return; }
  if (KaiProviders.isModel(chatModel) && getChatMode().startsWith("team:")) {
    addMsg("error", "Desktop providers work in Chat, Research and Agent. Choose one of those modes, or use a local/network model for Teams."); return;
  }
  const creditRun = !replayText && chatModel.startsWith("koinos-network") && getChatMode() !== "chat";
  if (creditRun) {
    if (state.attachment?.kind === "image") { addMsg("error", "The current network model does not support images. Choose a local vision model."); return; }
    try { if (!await window.KaiCreditRuns.begin(getChatMode().startsWith("team:") ? "team" : getChatMode())) return; }
    catch (e) { addMsg("error", e.message); return; }
  }
  if (!replayText) $("input").value = "";
  // An attached IMAGE rides on the question turn itself (vision input) —
  // gated to models that can actually see (the gateway enforces this too;
  // client-side is just the instant, friendlier refusal).
  let pendingImages = null;
  if (!replayText && state.attachment?.kind === "image") {
    if (chatModel.startsWith("koinos-network") || (!KaiProviders.isModel(chatModel) && !state.visionAliases?.has(chatModel))) {
      addMsg("error", "That model can't see images — pick a vision-capable model (👁 in the picker), then send again.");
      $("input").value = text;
      return;
    }
    pendingImages = [state.attachment.dataUri];
    clearAttachment();
  } else if (!replayText && state.attachment) {
    // An attached text file becomes its own user turn right before the
    // question, so it round-trips through history and re-renders faithfully.
    const a = state.attachment;
    const fileMsg = `📎 ${a.name}${a.trimmed ? " (trimmed)" : ""}\n\n\`\`\`\n${a.text}\n\`\`\``;
    state.history.push({ role: "user", content: fileMsg });
    addMsg("user", fileMsg);
    clearAttachment();
  }
  state.history.push({ role: "user", content: text, ...(pendingImages ? { images: pendingImages } : {}) });
  const userEl = addMsg("user", text);
  if (pendingImages) renderMsgImages(userEl, pendingImages);

  const bubble = addMsg("assistant", "");
  let verifiedPartial = "";
  bubble.classList.add("streaming");
  // Three swelling dots until the first token lands — a blank bubble read as
  // "stuck" during model load / network dispatch (field feedback).
  bubble.innerHTML = KaiI18n.html('<span class="typing-dots" aria-label="thinking"><i></i><i></i><i></i></span>');
  state.chatting = true;
  $("btn-send").disabled = true;
  $("btn-stop").hidden = false;
  state.abort = new AbortController();
  const t0 = performance.now(); // include routing, tools, memory and model load

  // 🌐 research first (search → read → answer). The web context is a
  // TRANSIENT turn: it shapes THIS request but never enters state.history —
  // persisting kilobytes of snippets would bloat every later request's
  // 4k-token context. The citations persist on the assistant message.
  let webCitations = null;
  let reqHistory = state.history;
  const answerMode = replayText ? "chat" : getChatMode();

  // 👥 AI Teams (task #58): the team produces the FINAL answer itself —
  // plan, tool-using workers, writer, critic — streamed as a live trace.
  // No second completion pass happens; this branch owns the whole turn.
  if (answerMode.startsWith("team:")) {
    const template = answerMode.slice(5);
    const trace = document.createElement("div");
    trace.className = "web-status";
    bubble.before(trace);
    try {
      // Code-running teams get ONE upfront, explicit consent for the run —
      // the same trust boundary as confirming a sensitive tool, stated in
      // plain words before anything executes.
      let allowSensitive = false;
      if (template === "analyst") {
        allowSensitive = confirm(
          "The Analyst team writes and runs code in the sandbox (its own scratch folder, no network, no other programs). Allow for this run?"
        );
      }
      const teamBody = { template, question: text, model: chatModel, allowSensitive };
      const resp = creditRun ? await KaiCreditRuns.execute("team", teamBody, { signal: state.abort.signal }) : await fetch("/core/teams/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: state.abort.signal,
        body: JSON.stringify(teamBody),
      });
      if (!resp.ok || !resp.body) throw new Error(`teams endpoint answered ${resp.status}`);
      const decoder = new TextDecoder();
      let buf = "";
      let done = null;
      for await (const chunk of resp.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (!line.startsWith("data: ")) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.trace) KaiI18n.setText(trace, KaiI18n.message`👥 ${ev.trace.stage}: ${String(ev.trace.detail).slice(0, 140)}`);
          if (ev.done) done = ev;
        }
      }
      if (!done) throw new Error("the team stream ended without an answer");
      if (done.error) throw new Error(done.error);
      KaiI18n.setText(trace, KaiI18n.message`👥 team finished in ${done.modelCalls} model calls`);
      bubble.innerHTML = mdToHtml(done.answer);
      attachMsgActions(bubble);
      state.history.push({ role: "assistant", content: done.answer });
      saveCurrentChat();
    } catch (e) {
      if (e.name === "AbortError") {
        trace.remove();
        state.history.push({ role: "assistant", content: "(team run stopped)" });
        KaiI18n.setText(bubble, "(team run stopped)");
        saveCurrentChat();
      } else {
        trace.remove();
        bubble.remove();
        state.history.pop();
        addMsg("error", String(e.message));
        $("input").value = text;
      }
    } finally {
      if (creditRun) await KaiCreditRuns.finish();
      bubble.classList.remove("streaming");
      state.chatting = false;
      $("btn-send").disabled = false;
      $("btn-stop").hidden = true;
      state.abort = null;
    }
    return;
  }

  try {
    const turnHistory = state.history.slice(-5, -1).map(m => m.role + ": " + m.content).join("\n");
    const paidChat = chatModel.startsWith("koinos-network") && window.KaiNetwork?.info.configured;
    const route = paidChat && !creditRun ? { lane: "chat", needsTools: false } : KaiAgents.routeTurn(text, { mode: answerMode, history: turnHistory });
    if (!route.needsTools) {
      reqHistory = [{ role: "system", content: KaiAgents.fastContext(route) }, ...state.history];
    }
    if (!replayText && (answerMode === "research" || route.needsTools && (route.lane !== "web" || answerMode === "agent"))) {
      // Research / Agent phase: gather first (multi-round, tool calls), then
      // the final answer streams through the normal path below. The gathered
      // context is a TRANSIENT turn — same rule as the 🌐 flow.
      const status = document.createElement("div");
      status.className = "web-status";
      bubble.before(status);
      try {
        if (!state.chatId) await saveCurrentChat();
        const actionHost = document.createElement("div"); bubble.before(actionHost);
        const connectedJSON = window.KaiCompanionClient?.toolJSON(chatModel, async (url, options) => {
          const response = await fetch(url, { ...options, signal: state.abort.signal }); return response.json();
        }, state.abort.signal, { question: text, conversationId: state.chatId || "main-new", host: actionHost });
        const rt = KaiAgents.makeRuntime({
          askModelOnce,
          confirmTool,
          json: connectedJSON,
          signal: state.abort.signal,
          route,
          setStatus: (t) => { status.textContent = t; },
        });
        const phase = answerMode === "research" ? await rt.deepResearch(text, chatModel) : await rt.runAgent(text, chatModel, turnHistory);
        if (phase) {
          webCitations = phase.citations?.length ? phase.citations : null;
          status.textContent = phase.trace || "";
          reqHistory = [...state.history.slice(0, -1), { role: "user", content: phase.context }, state.history[state.history.length - 1]];
        }
      } catch (e) {
        if (e.name === "AbortError" || creditRun) throw e;
        KaiI18n.setText(status, KaiI18n.message`⚠ ${String(e.message || e).slice(0, 140)} — answering without tools.`);
      } finally {
        if (!status.textContent) status.remove();
      }
    } else if (!replayText && route.lane === "web" && state.webSearch) {
      const status = document.createElement("div");
      status.className = "web-status";
      bubble.before(status);
      try {
        const research = await webResearch(text, status, state.abort.signal);
        if (research) {
          webCitations = research.citations;
          reqHistory = [...state.history.slice(0, -1), { role: "user", content: research.context }, state.history[state.history.length - 1]];
        }
      } finally {
        if (!status.textContent) status.remove();
      }
    } else if (!replayText && route.lane === "web") {
      reqHistory = [{ role: "system", content: "No live lookup ran: the web toggle is off. Do not invent current results. Explain that enabling the globe allows this lookup, or answer only the parts supported by existing knowledge." }, ...state.history];
    }

    // Shared provider enrichment retrieves local memory once, on the final
    // answer only. Both main Chat and desktop KAI use that same path.
    state.abort.signal.throwIfAborted();
    const resp = await KaiProviders.chatFetch("/core/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: state.abort.signal,
      body: JSON.stringify({
        model: chatModel,
        stream: true,
        // Persona + remembered facts ride as ONE system turn; history itself
        // stays user/assistant. toWire converts image-bearing turns to OpenAI
        // content parts and strips UI-only fields (citations) off the rest.
        messages: toWire(
          (() => {
            const sys = personaText();
            return sys ? [{ role: "system", content: sys }, ...reqHistory] : reqHistory;
          })()
        ),
      }),
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => null);
      throw new Error(j?.error?.message || `Core answered ${resp.status}`);
    }
    let acc = "";
    let servedBy = null;
    let servedModel = null;
    let lastPaint = 0;
    let tFirst = null;
    let replyWarning = "";
    for await (const { content, model, served, warning } of sseDeltas(resp.body)) {
      if (warning) replyWarning = warning;
      if (model) servedBy = model;
      if (served) servedModel = served;
      if (content) {
        if (tFirst == null) tFirst = performance.now();
        acc += content;
        verifiedPartial = acc;
        // Markdown live during the stream, throttled so re-rendering
        // doesn't chew CPU the model needs.
        const now = performance.now();
        if (now - lastPaint > 80) {
          bubble.innerHTML = mdToHtml(acc);
          lastPaint = now;
          $("messages").scrollTop = $("messages").scrollHeight;
        }
      }
    }
    bubble.innerHTML = mdToHtml(acc);
    if (replyWarning) {
      const note = document.createElement("div"); note.className = "route-tag"; note.setAttribute("role", "status");
      note.textContent = replyWarning; bubble.appendChild(note);
    }
    if (acc) attachMsgActions(bubble);
    $("messages").scrollTop = $("messages").scrollHeight;
    // §29 transparency: a Local-First answer that overflowed to the network
    // says so on the message itself — silence would hide that the prompt
    // left the machine.
    if (servedBy === "koinos-network") {
      // §29 both directions: overflow discloses leaving the machine, and an
      // explicit network chat names which class actually answered.
      const cls = servedModel ? state.aliasLabels?.[servedModel] || servedModel : null;
      const tag = document.createElement("div");
      tag.className = "route-tag";
      KaiI18n.setText(tag, !chatModel.startsWith("koinos-network")
        ? `answered via Koinos Network${cls ? ` (${cls})` : ""} — local model was unavailable`
        : cls
          ? `served by the network's ${cls}`
          : "");
      if (tag.textContent) bubble.appendChild(tag);
    }
    if (KaiProviders.isModel(chatModel)) {
      const tag = document.createElement("div"); tag.className = "route-tag";
      tag.textContent = "Answered by " + KaiProviders.label(chatModel) + " · private desktop connection"; bubble.appendChild(tag);
    }
    if (webCitations) renderCitations(bubble, webCitations);
    // Speed transparency (field request): show how long the wait actually
    // was and the delivered rate, so "slow" becomes a number we can chase.
    if (acc && tFirst != null) {
      const firstS = (tFirst - t0) / 1000;
      const genS = Math.max(0.001, (performance.now() - tFirst) / 1000);
      const tokPerSec = acc.length / 4 / genS; // ~4 chars/token estimate
      const meta = document.createElement("div");
      meta.className = "msg-meta";
      KaiI18n.setText(meta, resp.headers.get("x-kai-buffered") === "true" ? `Verified answer in ${firstS.toFixed(1)}s` : KaiI18n.message`first reply in ${firstS.toFixed(1)}s · ~${tokPerSec.toFixed(0)} tok/s`);
      bubble.appendChild(meta);
    }
    state.history.push({ role: "assistant", content: acc, ...(webCitations ? { citations: webCitations } : {}) });
    const saved = await saveCurrentChat();
    const paidRequest = resp.headers.get("x-kai-paid-request");
    if (paidRequest && saved) await KaiNetwork.acknowledge(paidRequest).catch(() => {});
  } catch (e) {
    if (verifiedPartial) {
      const partial = verifiedPartial;
      bubble.innerHTML = mdToHtml(partial); attachMsgActions(bubble);
      state.history.push({ role: "assistant", content: partial, interrupted: true });
      await saveCurrentChat();
      addMsg("error", "Reply interrupted. The received text is saved; recover the original request to check its verified usage.");
    } else if (e.name === "AbortError" && !(chatModel.startsWith("koinos-network") && window.KaiNetwork?.info.configured)) {
      state.history.push({ role: "assistant", content: bubble.textContent });
      if (bubble.textContent) attachMsgActions(bubble);
      saveCurrentChat();
    } else {
      bubble.remove();
      state.history.pop(); // drop the failed user turn so retry is clean
      addMsg("error", e.name === "AbortError" ? "Stopped. Send the same message again to check or recover the original request." : String(e.message));
      $("input").value = text;
    }
  } finally {
    if (creditRun) await KaiCreditRuns.finish();
    bubble.classList.remove("streaming");
    state.chatting = false;
    $("btn-send").disabled = false;
    $("btn-stop").hidden = true;
    state.abort = null;
  }
}

/** Parse an OpenAI SSE stream into {content, model} chunk views. */
async function* sseDeltas(body) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        try {
          const j = JSON.parse(data);
          yield { content: j.choices?.[0]?.delta?.content || "", model: j.model || null, served: j.servedModel || null, warning: j.warning };
        } catch {
          /* keep-alive or non-JSON frame */
        }
      }
    }
  }
}

// ---------- personas (how the AI should answer) ----------

const PERSONAS = {
  concise: "Be concise. Prefer short, direct answers; skip preamble and filler.",
  explainer: "Explain clearly for a smart beginner. Use plain language and short, concrete examples.",
  code: "You are a precise programming assistant. Prefer working code with a brief explanation, in markdown code blocks.",
};

function personaText() {
  const v = $("persona-pick").value;
  if (v === "custom") return $("persona-custom").value.trim();
  return PERSONAS[v] || "";
}

$("persona-pick").addEventListener("change", () => {
  $("persona-custom-row").hidden = $("persona-pick").value !== "custom";
  if ($("persona-pick").value === "custom") $("persona-custom").focus();
});

function setPersonaUi(persona, system) {
  if (persona && PERSONAS[persona]) $("persona-pick").value = persona;
  else if (system) {
    $("persona-pick").value = "custom";
    $("persona-custom").value = system;
  } else $("persona-pick").value = "";
  $("persona-custom-row").hidden = $("persona-pick").value !== "custom";
}

// ---------- chat history (local-first, stored by Core) ----------

function esc2(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }

async function saveCurrentChat() {
  if (!state.history.length) return;
  try {
    const v = $("persona-pick").value;
    const r = await fetch("/core/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: state.chatId,
        messages: state.history,
        system: personaText() || undefined,
        persona: v && v !== "custom" ? v : undefined,
      }),
    });
    const j = await r.json();
    if (j.ok) state.chatId = j.id;
    refreshChatList();
    return !!j.ok;
  } catch (error) { addMsg("error", "Your reply is still visible, but this conversation could not be saved: " + error.message); return false; }
}

async function refreshChatList() {
  try {
    const j = await coreGet("/core/chats");
    state.chatIndex = j.chats || [];
  } catch { state.chatIndex = []; }
  renderChatList();
}

function renderChatList() {
  const host = $("chat-list");
  if (!host) return;
  const q = ($("chat-search").value || "").trim().toLowerCase();
  const rows = state.chatIndex.filter(
    (c) => !q || c.title.toLowerCase().includes(q) || (c.searchText || "").toLowerCase().includes(q)
  );
  if (!rows.length) {
    host.innerHTML = KaiI18n.html`<div class="chat-list-empty">${q ? "No chats match." : "Chats you start appear here."}</div>`;
    return;
  }
  host.innerHTML = rows
    .map(
      (c) => KaiI18n.html`<div class="chat-row${c.id === state.chatId ? " active" : ""}${c.pinned ? " pinned" : ""}" data-id="${esc2(c.id)}" title="Double-click to rename">
        <button class="chat-pin${c.pinned ? " on" : ""}" data-id="${esc2(c.id)}" title="${c.pinned ? "Unfavorite" : "Favorite"}" aria-label="${c.pinned ? "Unfavorite chat" : "Favorite chat"}">${c.pinned ? "★" : "☆"}</button>
        <span class="chat-row-title">${esc2(c.title)}</span>
        <button class="chat-edit" data-id="${esc2(c.id)}" title="Rename chat" aria-label="Rename chat">✎</button>
        <button class="chat-del" data-id="${esc2(c.id)}" title="Delete chat" aria-label="Delete chat">×</button>
      </div>`
    )
    .join("");
}

// Rename: the ✎ button or double-click swaps the title for an inline input;
// Enter commits, Escape cancels.
function startRename(row) {
  if (!row || row.querySelector("input")) return;
  const span = row.querySelector(".chat-row-title");
  const input = document.createElement("input");
  input.className = "chat-rename";
  input.value = span.textContent;
  input.maxLength = 80;
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (commit && title && title !== span.textContent) {
      try {
        await fetch(`/core/chats/${row.dataset.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title }),
        });
      } catch { /* keep old title */ }
    }
    refreshChatList();
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") finish(true);
    if (ev.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

$("chat-list").addEventListener("dblclick", (e) => startRename(e.target.closest(".chat-row")));

function rebuildMessages() {
  const box = $("messages");
  box.innerHTML = "";
  for (const m of state.history) {
    const el = addMsg(m.role === "user" ? "user" : "assistant", m.content);
    if (m.role === "assistant" && m.citations) renderCitations(el, m.citations);
    if (m.role === "user" && m.images) renderMsgImages(el, m.images);
  }
  if (!state.history.length) {
    box.replaceChildren($("chat-welcome-template").content.cloneNode(true));
    window.kaiBrand?.mountCharacters(box);
  }
}

function newChat() {
  state.chatId = null;
  state.history = [];
  setPersonaUi(null, null);
  rebuildMessages();
  renderChatList();
  state.view = "chat";
  showView("chat");
  $("input").focus();
}

$("btn-new-chat").addEventListener("click", newChat);
$("chat-search").addEventListener("input", renderChatList);

$("chat-list").addEventListener("click", async (e) => {
  const pin = e.target.closest(".chat-pin");
  if (pin) {
    e.stopPropagation();
    const wasOn = pin.classList.contains("on");
    try {
      await fetch(`/core/chats/${pin.dataset.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: !wasOn }),
      });
    } catch { /* toggle lost — list refresh shows truth */ }
    refreshChatList();
    return;
  }
  const edit = e.target.closest(".chat-edit");
  if (edit) {
    e.stopPropagation();
    startRename(edit.closest(".chat-row"));
    return;
  }
  const del = e.target.closest(".chat-del");
  if (del) {
    e.stopPropagation();
    await fetch(`/core/chats/${del.dataset.id}`, { method: "DELETE" });
    if (state.chatId === del.dataset.id) newChat();
    refreshChatList();
    return;
  }
  const row = e.target.closest(".chat-row");
  if (!row) return;
  // Clicking the chat that's ALREADY open must not refetch + rebuild the
  // list — the rebuild destroyed the row mid-double-click, which is why
  // dblclick-rename never fired on the active chat (field finding).
  if (row.dataset.id === state.chatId) {
    state.view = "chat";
    showView("chat");
    return;
  }
  try {
    const j = await coreGet(`/core/chats/${row.dataset.id}`);
    state.chatId = j.chat.id;
    state.history = j.chat.messages || [];
    setPersonaUi(j.chat.persona, j.chat.system);
    rebuildMessages();
    renderChatList();
    state.view = "chat";
    showView("chat");
  } catch { /* deleted underneath us — list refresh will reconcile */ }
});

refreshChatList();


function esc(s) { return String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`); }
function showView(name) { for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== 'view-' + name; $('workspace-title').textContent = name === 'settings' ? 'Settings' : name === 'recovery' ? 'Saved results' : 'Chat with KAI'; }
function activateView(name) { if (!['chat','onboarding','settings','recovery'].includes(name)) { void window.kai.call('assistant.navigate',{view:name}); return; } state.view=name;state.routed=true;showView(name);if(name==='settings')void KaiProviders.renderSettings(); }
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click',()=>activateView(b.dataset.view));
refresh();
