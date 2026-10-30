"use strict";
(() => {
  const $ = id => document.getElementById(id), call = (method, input) => window.kai.call(method, input), logic = window.AssistantLogic;
  const state = { chats: [], current: null, messages: [], busy: false, unsaved: false, models: [], lastError: false };
  const welcome = $("messages").firstElementChild;
  const banner = window.KaiPluginNotice.attach($("notice"), { focusTarget: () => $("prompt") });
  function notice(message, error = false) { banner.show(message || "", { error, force: true }); }
  function closeHistory() { $("chat-shell").classList.remove("history-open"); $("history-toggle").setAttribute("aria-expanded", "false"); }
  $("history-toggle").addEventListener("click", () => { const open = $("chat-shell").classList.toggle("history-open"); $("history-toggle").setAttribute("aria-expanded", String(open)); });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && $("chat-shell").classList.contains("history-open")) { closeHistory(); $("history-toggle").focus(); } });
  function controls() {
    for (const id of ["new-chat", "refresh-models", "model", "tokens", "prompt"]) $(id).disabled = state.busy;
    for (const id of ["rename", "pin", "delete"]) $(id).disabled = state.busy || !state.current || state.unsaved;
    $("send").disabled = state.busy || state.unsaved || !$("model").value;
    $("retry").hidden = !state.lastError || state.unsaved; $("retry").disabled = state.busy || !$("model").value;
    $("save-again").hidden = !state.unsaved; $("save-again").disabled = state.busy; $("save-copy").hidden = !state.unsaved || !state.current; $("save-copy").disabled = state.busy;
    for (const button of $("history").querySelectorAll("button")) button.disabled = state.busy || state.unsaved;
    $("new-chat").disabled = state.busy || state.unsaved;
  }
  function renderHistory() {
    $("history").replaceChildren();
    for (const chat of logic.filterChats(state.chats, $("search").value)) {
      const button = document.createElement("button"); button.className = "history-item"; button.classList.toggle("selected", chat.id === state.current?.id);
      const title = document.createElement("span"); title.textContent = (chat.pinned ? "★ " : "") + chat.title;
      const details = document.createElement("small"); const date = chat.updatedAt ? new Date(chat.updatedAt) : null;
      details.textContent = `${chat.messages} messages${date && !Number.isNaN(date.getTime()) ? " · " + date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}`;
      button.append(title, details); button.addEventListener("click", () => guarded(() => openChat(chat.id))); $("history").append(button);
    }
    if (!$("history").children.length) { const text = document.createElement("p"); text.className = "empty-history"; text.textContent = state.chats.length ? "No matching conversations." : "Your conversations will appear here."; $("history").append(text); }
    controls();
  }
  function renderMessages() {
    $("messages").replaceChildren(); if (!state.messages.length) $("messages").append(welcome);
    for (const message of state.messages) {
      const article = document.createElement("article"); article.className = `message ${message.role === "user" ? "user" : "assistant"}`;
      const label = document.createElement("div"); label.className = "message-label"; label.textContent = message.role === "user" ? "YOU" : message.role === "assistant" ? "KAI ASSISTANT" : "SAVED CONTEXT";
      const content = document.createElement("div"); content.className = "message-content"; content.textContent = message.content;
      article.append(label, content);
      if (message.attachments) { const note = document.createElement("small"); note.className = "attachment-note"; note.textContent = `${message.attachments} saved attachment(s) preserved. This text conversation does not send images to the model.`; article.append(note); }
      $("messages").append(article);
    }
    $("chat-title").textContent = state.current?.title || "New chat";
    $("chat-subtitle").textContent = state.current ? "Saved conversation" : "Your saved conversations";
    $("pin").textContent = state.current?.pinned ? "★" : "☆"; $("pin").setAttribute("aria-label", state.current?.pinned ? "Remove from favorites" : "Add to favorites");
    $("messages").scrollTop = $("messages").scrollHeight; controls();
  }
  async function listChats() { const result = await call("assistant.list", {}); state.chats = result.chats; renderHistory(); if (result.warnings?.length) notice(result.warnings.join(" "), true); }
  async function openChat(id) { if (state.unsaved) return; state.current = await call("assistant.get", { id }); state.messages = state.current.messages; state.lastError = state.messages.at(-1)?.role === "user"; notice(""); $("rename-form").hidden = true; renderMessages(); renderHistory(); closeHistory(); }
  async function loadModels() {
    const previous = $("model").value; state.models = logic.readyModels(await call("models.list", {})); $("model").replaceChildren();
    if (!state.models.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "No local model installed"; $("model").append(option); }
    for (const model of state.models) { const option = document.createElement("option"); option.value = model.alias; option.textContent = model.label; $("model").append(option); }
    if (state.models.some(m => m.alias === previous)) $("model").value = previous;
    $("model-status").textContent = state.models.length ? "On-device inference" : "Install a model in Core → Models, then refresh."; controls();
  }
  async function save() {
    try { const saved = await call("assistant.save", { ...(state.current ? { id: state.current.id, revision: state.current.revision } : {}), messages: state.messages.map(({ role, content }) => ({ role, content })) });
      state.current = { ...(state.current || { title: state.messages.find(m => m.role === "user")?.content.slice(0, 80) || "Untitled chat", pinned: false, system: "" }), ...saved, messages: state.messages }; state.unsaved = false; await listChats(); renderMessages();
    } catch (error) { state.unsaved = true; controls(); throw error; }
  }
  async function reply() {
    const context = logic.buildPrompt(state.messages, state.current?.system || "");
    if (context.omitted || context.systemTrimmed) notice(`Using the most recent conversation context${context.omitted ? `; ${context.omitted} earlier message(s) remain saved` : ""}${context.systemTrimmed ? "; the saved instructions were shortened for this request" : ""}.`);
    const started = performance.now(); $("working").textContent = "Thinking locally…";
    const result = await call("inference.local", { model: $("model").value, prompt: context.prompt, maxTokens: Number($("tokens").value) });
    if (typeof result?.text !== "string" || !result.text.trim()) throw Error("The local model returned an empty reply. You can retry.");
    state.messages.push({ role: "assistant", content: result.text }); state.lastError = false; renderMessages();
    $("working").textContent = `Replied in ${((performance.now() - started) / 1000).toFixed(1)}s`; await save();
  }
  async function guarded(action) { if (state.busy) return; state.busy = true; controls(); try { await action(); } catch (error) { notice(error.message || String(error), true); } finally { state.busy = false; controls(); } }
  async function runReply(addMessage) {
    if (state.busy || state.unsaved || !$("model").value) return; const content = $("prompt").value.trim(); if (addMessage && !content) return;
    state.busy = true; state.lastError = false; notice(""); controls();
    try { if (addMessage) { state.messages.push({ role: "user", content }); $("prompt").value = ""; renderMessages(); await save(); } await reply(); }
    catch (error) { state.lastError = state.messages.at(-1)?.role === "user"; $("working").textContent = ""; notice((state.unsaved ? "Conversation not saved. Your text is still visible here. " : "") + (error.message || String(error)), true); }
    finally { state.busy = false; controls(); $("prompt").focus(); }
  }
  $("composer").addEventListener("submit", event => { event.preventDefault(); void runReply(true); });
  $("prompt").addEventListener("keydown", event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void runReply(true); } });
  $("retry").addEventListener("click", () => void runReply(false));
  $("save-again").addEventListener("click", () => guarded(async () => { state.busy = true; controls(); try { await save(); notice("Conversation saved."); } finally { state.busy = false; } }));
  $("save-copy").addEventListener("click", () => guarded(async () => {
    const messages = state.messages.map(({ role, content }) => ({ role, content }));
    const saved = await call("assistant.save", { messages });
    state.current = { ...saved, title: messages.find(m => m.role === "user")?.content.slice(0, 80) || "Untitled chat", pinned: false, system: "", messages };
    state.messages = messages; state.unsaved = false; await listChats(); renderMessages(); notice("Saved as a new text conversation. The original conversation and its attachments remain unchanged.");
  }));
  function resetChat() { closeHistory(); state.current = null; state.messages = []; state.lastError = false; $("prompt").value = ""; $("working").textContent = ""; $("rename-form").hidden = true; notice(""); renderMessages(); renderHistory(); $("prompt").focus(); }
  $("new-chat").addEventListener("click", () => { if (!state.busy && !state.unsaved) resetChat(); });
  $("search").addEventListener("input", renderHistory); $("refresh-models").addEventListener("click", () => guarded(loadModels));
  $("rename").addEventListener("click", () => { $("rename-form").hidden = false; $("rename-title").value = state.current.title; $("rename-title").focus(); });
  $("cancel-rename").addEventListener("click", () => { $("rename-form").hidden = true; });
  $("rename-form").addEventListener("submit", event => { event.preventDefault(); void guarded(async () => { const result = await call("assistant.rename", { id: state.current.id, revision: state.current.revision, title: $("rename-title").value.trim() }); Object.assign(state.current, result, { title: $("rename-title").value.trim() }); $("rename-form").hidden = true; await listChats(); renderMessages(); }); });
  $("pin").addEventListener("click", () => guarded(async () => { const pinned = !state.current.pinned; const result = await call("assistant.pin", { id: state.current.id, revision: state.current.revision, pinned }); Object.assign(state.current, result, { pinned }); await listChats(); renderMessages(); }));
  $("delete").addEventListener("click", () => guarded(async () => { const result = await call("assistant.delete", { id: state.current.id, revision: state.current.revision }); if (result.deleted) { resetChat(); await listChats(); } }));
  for (const button of document.querySelectorAll("[data-prompt]")) button.addEventListener("click", () => { $("prompt").value = button.dataset.prompt; $("prompt").focus(); });
  async function preferences() { await call("storage.set", { key: "preferences", value: { model: $("model").value, maxTokens: Number($("tokens").value) } }); }
  for (const id of ["model", "tokens"]) $(id).addEventListener("change", () => { controls(); void guarded(preferences); });
  void guarded(async () => {
    if (!window.kai?.call || window.kai.apiVersion < 2) throw Error("Open this plugin in KAI Core 0.2.0 or later.");
    await Promise.all([listChats(), loadModels()]); const saved = await call("storage.get", { key: "preferences" });
    if (saved && state.models.some(m => m.alias === saved.model)) $("model").value = saved.model;
    if ([512, 1024, 2048, 4096].includes(saved?.maxTokens)) $("tokens").value = String(saved.maxTokens); controls();
  });
})();
