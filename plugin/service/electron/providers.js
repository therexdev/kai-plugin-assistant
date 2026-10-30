"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { trustedFrame } = require("./mascot");
const http = require("./provider-http");

class DesktopProviders {
  constructor({ dataDir, safeStorage, privacyMode, fetchImpl = fetch }) {
    this.file = path.join(dataDir, "desktop-providers.json");
    this.storage = safeStorage; this.privacyMode = privacyMode; this.fetch = fetchImpl;
    this.entries = {}; this.active = new Set(); this.revision = 0; this.loadError = false;
    try {
      if (fs.existsSync(this.file)) {
        this.requireStorage();
        const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
        this.entries = JSON.parse(safeStorage.decryptString(Buffer.from(saved.encrypted, "base64")));
      }
    } catch { this.loadError = true; }
  }
  storageAvailable() {
    return this.storage.isEncryptionAvailable() && this.storage.getSelectedStorageBackend?.() !== "basic_text";
  }
  requireStorage() { if (!this.storageAvailable()) throw new http.ProviderError("Secure OS storage is unavailable. Unlock your system keychain and restart the app."); }
  online() { if (this.privacyMode() === "local-only") throw new http.ProviderError("Local-Only blocks online providers. Open Local API → Privacy and choose Local-First to allow online requests."); }
  status() {
    return { available: this.storageAvailable(), locked: this.loadError, blocked: this.privacyMode() === "local-only",
      providers: Object.entries(http.PROVIDERS).map(([id, p]) => ({ id, label: p.label, configured: !!this.entries[id]?.key,
        models: this.entries[id]?.models || [] })) };
  }
  persist(next) {
    this.requireStorage();
    if (this.loadError) throw new http.ProviderError("Saved provider keys could not be unlocked. Restart with your original OS account and keychain.");
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + crypto.randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, encrypted: this.storage.encryptString(JSON.stringify(next)).toString("base64") }) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.file);
      this.entries = next; this.revision++;
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  save(id, options) {
    http.provider(id);
    const key = options?.key?.trim() || this.entries[id]?.key;
    if (typeof key !== "string" || !/^[\x21-\x7e]{12,4096}$/.test(key)) throw new http.ProviderError("Enter a valid API key.");
    const custom = options?.model?.trim();
    if (custom) http.modelId(custom);
    const models = key === this.entries[id]?.key ? [...this.entries[id].models] : [];
    if (custom && !models.some(m => m.id === custom)) models.unshift({ id: custom, label: custom });
    this.persist({ ...this.entries, [id]: { key, models } }); this.cancel(id);
    return this.status();
  }
  remove(id) {
    http.provider(id); const next = { ...this.entries }; delete next[id];
    this.persist(next); this.cancel(id); return this.status();
  }
  cancel(id) { for (const job of this.active) if (!id || job.provider === id) job.controller.abort(); }
  async run(id, operation, signal) {
    this.online(); this.requireStorage();
    const key = this.entries[id]?.key;
    if (!key) throw new http.ProviderError("Connect this provider in Settings first.");
    const controller = new AbortController(), job = { provider: id, controller };
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(180000), ...(signal ? [signal] : [])]);
    const privacyTimer = setInterval(() => { if (this.privacyMode() === "local-only") controller.abort(); }, 250);
    privacyTimer.unref?.(); this.active.add(job);
    try { return await operation(key, combined); }
    catch (e) {
      if (this.privacyMode() === "local-only") this.online();
      if (signal?.aborted || controller.signal.aborted) throw new DOMException("Stopped", "AbortError");
      if (e instanceof http.ProviderError) throw e;
      if (combined.aborted) throw new http.ProviderError("The provider timed out. Try again.");
      // Never forward upstream bodies, request headers or raw errors to IPC/logs.
      throw new http.ProviderError("Could not connect to " + http.provider(id).label + ". Check your internet connection and try again.");
    } finally { clearInterval(privacyTimer); this.active.delete(job); }
  }
  async refresh(id) {
    http.provider(id); const revision = this.revision;
    return this.run(id, async (key, signal) => {
      const models = await http.listModels(this.fetch, id, key, signal); signal.throwIfAborted();
      if (revision !== this.revision) throw new http.ProviderError("Settings changed during the check. Try again.");
      if (!models.length) throw new http.ProviderError("The key connected, but no chat models were listed. Enter a model ID from your provider account.");
      const merged = [...new Map([...models, ...(this.entries[id]?.models || [])].map(m => [m.id, m])).values()];
      this.persist({ ...this.entries, [id]: { key, models: merged } }); return this.status();
    });
  }
  async chat(body, onDelta, signal) {
    const selection = http.parseModel(body?.model);
    if (!this.entries[selection.provider]?.models.some(m => m.id === selection.model)) throw new http.ProviderError("That model is no longer configured. Choose a model in Settings.");
    return this.run(selection.provider, async (key, combined) => {
      let result;
      const guardedFetch = (url, init) => { this.online(); combined.throwIfAborted(); return this.fetch(url, init); };
      for await (const text of http.complete(guardedFetch, selection.provider, key, { ...body, providerModel: selection.model }, combined, value => { result = value; })) {
        this.online(); combined.throwIfAborted(); onDelta(text);
      }
      this.online(); combined.throwIfAborted(); return result;
    }, signal);
  }
}

function registerProviderIPC({ ipcMain, service, origin, getMainWindow, getMainWebContents, getMascotWindow, getTrustedWindow }) {
  const handles = [], jobs = new Map();
  function allowed(event, settings = false) {
    if (getTrustedWindow) return !!getTrustedWindow(event, { management: settings });
    // Exact document path as well as main frame: an embedded same-origin node
    // screen or a window navigated to another Core resource has no capability.
    const check = (window, pathname) => trustedFrame(event, window, origin) && new URL(event.senderFrame.url).pathname === pathname;
    return check(getMainWindow(), "/") || (!settings && check(getMascotWindow(), "/mascot.html"));
  }
  function changed() {
    const main = getMainWindow(), mascot = getMascotWindow();
    const mainContents = getMainWebContents ? getMainWebContents() : main?.webContents;
    for (const contents of [main && !main.isDestroyed() ? mainContents : null, mascot && !mascot.isDestroyed() ? mascot.webContents : null])
      if (contents && !contents.isDestroyed?.()) contents.send("providers:changed");
  }
  function handle(channel, settings, fn) {
    handles.push(channel); ipcMain.handle(channel, async (event, ...args) => {
      if (!allowed(event, settings)) throw new Error("Desktop provider access denied.");
      try { return await fn(event, ...args); }
      catch (e) { return { ok: false, error: e instanceof http.ProviderError ? e.message : "The provider operation could not be completed.", aborted: e.name === "AbortError" }; }
    });
  }
  handle("providers:status", false, () => ({ ok: true, ...service.status() }));
  for (const action of ["save", "remove", "refresh"]) handle("providers:" + action, true, async (_event, id, options) => {
    const result = await service[action](id, options); changed(); return { ok: true, ...result };
  });
  handle("providers:chat", false, (event, id, body) => {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new http.ProviderError("Invalid request ID.");
    const key = event.sender.id + ":" + id;
    if (jobs.has(key) || [...jobs.keys()].filter(k => k.startsWith(event.sender.id + ":")).length >= 3) throw new http.ProviderError("Finish or stop the current provider request first.");
    const controller = new AbortController(), frame = event.senderFrame, sender = event.sender;
    const stop = () => controller.abort();
    const navigate = (_e, _url, _inPlace, isMainFrame) => { if (isMainFrame) stop(); };
    sender.on("destroyed", stop); sender.on("render-process-gone", stop); sender.on("did-start-navigation", navigate);
    jobs.set(key, controller);
    const emit = payload => { if (!sender.isDestroyed() && allowed(event) && event.senderFrame === frame) frame.send("providers:delta", { id, ...payload }); };
    service.chat(body, content => emit({ content }), controller.signal).then(result => emit({ done: true, ...result }), error => emit({
      error: error instanceof http.ProviderError ? error.message : error.name === "AbortError" ? "Stopped" : "The provider request failed.", aborted: error.name === "AbortError",
    })).finally(() => {
      jobs.delete(key); sender.removeListener("destroyed", stop); sender.removeListener("render-process-gone", stop); sender.removeListener("did-start-navigation", navigate);
    });
    return { ok: true };
  });
  handle("providers:cancel", false, (event, id) => { jobs.get(event.sender.id + ":" + id)?.abort(); return { ok: true }; });
  return { dispose() { service.cancel(); for (const c of jobs.values()) c.abort(); for (const c of handles) ipcMain.removeHandler(c); } };
}
module.exports = { DesktopProviders, registerProviderIPC };
