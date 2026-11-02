"use strict";
const fs = require("node:fs"), path = require("node:path");
const { DesktopProviders, registerProviderIPC } = require("../providers");
const { registerCompanionIPC } = require("../companion-ipc");
const { createMascotController } = require("../mascot");
const ENTRY = "kai-plugin://kai.assistant/index.html";
const ACTIONS = new Set(["providers:status", "providers:save", "providers:remove", "providers:refresh", "providers:chat", "providers:cancel", "companion:manage", "companion:context", "companion:tools", "companion:tool", "companion:activity", "companion:session", "companion:cancel", "mascot:launch", "language:get", "language:save"]);
function trusted(event, window, entry, contents = window?.webContents) {
  return !!window && !window.isDestroyed() && !!contents && !contents.isDestroyed?.() && event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame.url === entry;
}
function installMascotMediaConsent({ window, origin, isActive, dialog }) {
  const granted = new Set(), entry = origin + "/mascot.html";
  const exact = wc => isActive() && !window.isDestroyed() && wc === window.webContents && wc.mainFrame.url === entry;
  window.webContents.session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => permission === "media" && [origin, origin + "/"].includes(requestingOrigin) && details?.isMainFrame === true && details.requestingUrl === entry && exact(wc) && granted.has(details.mediaType));
  window.webContents.session.setPermissionRequestHandler(async (wc, permission, callback, details = {}) => {
    const types = details.mediaTypes || [];
    if (permission !== "media" || !exact(wc) || details.isMainFrame !== true || details.requestingUrl !== entry || !types.length || types.some(type => !["audio", "video"].includes(type))) return callback(false);
    if (types.every(type => granted.has(type))) return callback(true);
    try {
      const answer = await dialog.showMessageBox(window, { type: "question", title: "KAI companion media access", message: `Allow KAI to use your ${types.map(type => type === "audio" ? "microphone" : "camera").join(" and ")}?`, detail: "Used only for the voice or camera feature you start. Access lasts until this companion window closes.", buttons: ["Cancel", "Allow"], defaultId: 0, cancelId: 0 });
      const accepted = answer.response === 1 && exact(wc); if (accepted) for (const type of types) granted.add(type); callback(accepted);
    } catch { callback(false); }
  });
}
function create(ctx) {
  const origin = ctx.origin;
  let providers, providerIPC, companionIPC, mascot, hub, starting, originalCanUse, installedCanUse, voicePolicy, unsubscribeLocale, disposed = false;
  const handles = new Map(), assets = new Map(), listeners = new Map();
  const getMainWindow = () => ctx.getPluginWindow ? ctx.getPluginWindow("kai.assistant") || null : ctx.getWindow();
  const getMainWebContents = () => disposed ? null : ctx.getWebContents ? ctx.getWebContents() : ctx.getPluginWebContents ? ctx.getPluginWebContents("kai.assistant") : getMainWindow()?.webContents;
  const getMascotWindow = () => mascot?.getWindow();
  const getTrustedWindow = (event, { management = false } = {}) => {
    if (disposed) return null;
    const main = getMainWindow();
    if (trusted(event, main, ENTRY, getMainWebContents())) return main;
    const floating = getMascotWindow();
    if (!management && trusted(event, floating, origin + "/mascot.html")) return floating;
    return null;
  };
  // The shared original IPC implementations retain their approval logic. Only
  // this exact signed plugin entry and its dedicated mascot are accepted.
  const reopen = async event => {
    if (!trusted(event, getMascotWindow(), origin + "/mascot.html")) throw Error("Untrusted companion window");
    // Selecting an already-running app also restores its embedded page.
    await ctx.openPlugin("kai.assistant");
  };
  const ipc = {
    handle(channel, handler) {
      const bound = channel === "mascot:navigate" ? async (event, ...args) => { await reopen(event); return handler(event, ...args); } : handler;
      handles.set(channel, bound); ctx.electron.ipcMain.handle(channel, bound);
    },
    removeHandler(channel) { handles.delete(channel); ctx.electron.ipcMain.removeHandler(channel); },
    on(channel, listener) { const bound = channel === "mascot:main" ? (event, ...args) => { void reopen(event).then(() => listener(event, ...args)).catch(() => {}); } : listener; listeners.set(listener, bound); ctx.electron.ipcMain.on(channel, bound); },
    removeListener(channel, listener) { ctx.electron.ipcMain.removeListener(channel, listeners.get(listener) || listener); listeners.delete(listener); },
  };
  function NativeMascotWindow(options) {
    options.webPreferences.session = ctx.mascotSession;
    const floating = new ctx.electron.BrowserWindow(options);
    installMascotMediaConsent({ window: floating, origin, isActive: () => !disposed, dialog: ctx.electron.dialog });
    return floating;
  }
  function mountAssets() {
    const root = path.join(__dirname, "../../ui");
    // The base runtime has no suffix: the mascot-* asset scan below does not
    // match mascot.js. Core serves ui-core, so it cannot fall back to legacy UI.
    const selected = new Set(["mascot.html", "mascot.js", "pocket-credits.html", "mascot.css", "kai-character.css", "kai-robot.svg", "brand-mark.svg", "markdown.js", "audio-wav.js", "agents.js", "connection-profiles.js", "companion-client.js", "desktop-providers.js", "app-navigation.js", "computer-tools.js", "i18n.js", "language-settings.js", "locales/catalogs.js", "locales/core.js", "locales/ui.js"]);
    for (const file of fs.readdirSync(root)) if (/^mascot[.-].*\.(js|css|html)$/.test(file)) selected.add(file);
    const walk = folder => { if (!fs.existsSync(path.join(root, folder))) return; for (const row of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) { const relative = folder + "/" + row.name; if (row.isDirectory()) walk(relative); else if (row.isFile()) selected.add(relative); } };
    walk("assets");
    for (const file of selected) {
      const key = "/" + file, value = path.join(root, file); if (!fs.existsSync(value)) continue;
      assets.set(key, ctx.core.gateway.staticAssets.get(key)); ctx.core.gateway.staticAssets.set(key, value);
    }
    for (const [key, value] of require("../../core/lib/live-senses-assets").liveSensesAssets()) {
      assets.set(key, ctx.core.gateway.staticAssets.get(key)); ctx.core.gateway.staticAssets.set(key, value);
    }
  }
  const describeModel = model => {
    if (typeof model !== "string") return null;
    if (model.startsWith("desktop:")) {
      const selected = require("../provider-http").parseModel(model), status = providers.status();
      const provider = status.providers.find(p => p.id === selected.provider);
      if (status.blocked || !status.available || status.locked || !provider?.configured || !provider.models.some(m => m.id === selected.model)) throw Error("Connect this private model in Settings first, and allow online requests in Privacy.");
      return { kind: "private", label: provider.label, vision: selected.provider === "anthropic" ? /^claude-/.test(selected.model) : /^(?:gpt-(?:4o|4\.1|5)|chatgpt-|o[134](?:-|$))/.test(selected.model) };
    }
    const local = ctx.core.models.aliases().find(a => a.alias === model && a.status === "ready");
    return local ? { kind: "local", label: local.label, vision: !!local.vision } : null;
  };
  const start = () => starting ||= initialize();
  async function initialize() {
    if (disposed) throw Error("Assistant is closing");
    await ctx.runtimeEnsure();
    if (disposed) throw Error("Assistant is closing");
    const preferences = require("./assistant-preferences").createWindowPreferences(ctx.dataDir);
    const pocketVoice = new (require("../pocket-voice").PocketVoice)({ dir: path.join(ctx.dataDir, "speech", "pocket") });
    voicePolicy = require("./assistant-voice-policy").createVoiceDownloadPolicy({ isLocalOnly: () => ctx.core.gateway.network.status().privacyMode === "local-only", services: [pocketVoice, ctx.core.gateway.voice, ctx.core.gateway.speech] });
    providers = new DesktopProviders({ dataDir: ctx.dataDir, safeStorage: ctx.electron.safeStorage, privacyMode: () => ctx.core.gateway.network.status().privacyMode });
    mountAssets();
    mascot = createMascotController({ ...ctx.electron, BrowserWindow: NativeMascotWindow, ipcMain: ipc, prefs: preferences, origin, getMainWindow, getMainWebContents,
      hasTray: () => true, describeModel, pocketVoice });
    providerIPC = registerProviderIPC({ ipcMain: ipc, service: providers, origin, getMainWindow, getMainWebContents, getMascotWindow, getTrustedWindow });
    const resolveHub = () => {
      if (hub) return hub;
      hub = ctx.getCompanion();
      originalCanUse = hub.canUseModel;
      hub.canUseModel = installedCanUse = model => {
        if (originalCanUse?.(model)) return true;
        try { return describeModel(model)?.kind === "private"; } catch { return false; }
      };
      return hub;
    };
    const privateService = new Proxy({}, { get(_target, key) {
      let service;
      try { service = resolveHub(); }
      catch (error) { if (key === "canUseModel") return () => false; if (key === "toolList") return () => []; throw error; }
      const value = service[key]; return typeof value === "function" ? value.bind(service) : value;
    } });
    companionIPC = registerCompanionIPC({ ipcMain: ipc, service: privateService, origin, getMainWindow, getMascotWindow, getTrustedWindow, ownsService: false, dialog: ctx.electron.dialog });
    // The floating renderer retains its exact sender checks, while Core owns
    // both the saved preference and the change subscription.
    const language = () => ctx.locale.get();
    ipc.handle("shell:language", event => { if (!getTrustedWindow(event)) throw Error("Assistant language access denied"); return language(); });
    handles.set("language:get", () => language());
    const denySave = () => { throw Error("Change the shared language in Core Settings"); };
    ipc.handle("shell:set-language", event => { if (!getTrustedWindow(event)) throw Error("Assistant language access denied"); return denySave(); });
    handles.set("language:save", denySave);
    unsubscribeLocale = ctx.locale.onChange(value => {
      if (disposed) return;
      const floating = getMascotWindow(), contents = floating?.webContents;
      if (contents && !contents.isDestroyed() && contents.mainFrame.url === origin + "/mascot.html") contents.send("shell:language-changed", value);
    });
  }
  return {
    startBackground: () => start(),
    async call(input, signal) {
      signal?.throwIfAborted();
      if (!input || typeof input !== "object" || !ACTIONS.has(input.action) || !Array.isArray(input.args) || input.args.length > 5 || Object.keys(input).some(k => !["action", "args"].includes(k))) throw Error("Unsupported Assistant native action");
      await start(); signal?.throwIfAborted(); if (disposed) throw Error("Assistant is closing");
      const window = getMainWindow(), contents = getMainWebContents();
      if (!window || window.isDestroyed() || !contents || contents.isDestroyed?.() || contents.mainFrame.url !== ENTRY) throw Error("Assistant window is unavailable");
      if (input.action === "mascot:launch") return mascot.launch(input.args[0] || {});
      const handler = handles.get(input.action); if (!handler) throw Error("Assistant action is unavailable");
      const event = { sender: contents, senderFrame: contents.mainFrame };
      return handler(event, ...input.args);
    },
    async privacyChanged(mode) { if (mode === "local-only") { providers?.cancel(); await voicePolicy?.pause(); } },
    async dispose() {
      disposed = true; unsubscribeLocale?.(); companionIPC?.dispose(); providerIPC?.dispose();
      try { mascot?.dispose(); await starting?.catch(() => {}); await voicePolicy?.dispose(); if (hub && hub.canUseModel === installedCanUse) hub.canUseModel = originalCanUse; }
      finally {
        for (const channel of ["shell:language", "shell:set-language"]) if (handles.has(channel)) ipc.removeHandler(channel);
        for (const [key, old] of assets) { if (old === undefined) ctx.core.gateway.staticAssets.delete(key); else ctx.core.gateway.staticAssets.set(key, old); }
        assets.clear();
      }
    },
  };
}
module.exports = { create, trusted, ACTIONS, installMascotMediaConsent };
