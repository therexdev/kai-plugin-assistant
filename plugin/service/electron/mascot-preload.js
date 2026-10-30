"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kaiLanguageBridge", {
  get: () => ipcRenderer.invoke("shell:language"),
  save: language => ipcRenderer.invoke("shell:set-language", language),
  onChanged: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("shell:language-changed", listener);
    return () => ipcRenderer.removeListener("shell:language-changed", listener);
  },
});

contextBridge.exposeInMainWorld("kaiCompanionBridge", {
  context: (model, query) => ipcRenderer.invoke("companion:context", model, query),
  tools: model => ipcRenderer.invoke("companion:tools", model),
  tool: (name, args, model, sessionId) => ipcRenderer.invoke("companion:tool", name, args, model, sessionId),
  activity: (model, conversationId) => ipcRenderer.invoke("companion:activity", model, conversationId),
  session: (operation, input) => ipcRenderer.invoke("companion:session", operation, input),
  cancel: () => ipcRenderer.invoke("companion:cancel"),
});
async function computerInvoke(channel, ...args) {
  try { return await ipcRenderer.invoke(channel, ...args); }
  catch (error) {
    const message = String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: |AbortError: )?/, "");
    const clean = new Error(message); if (/stopped|declined|task ended/i.test(message)) clean.name = "AbortError"; throw clean;
  }
}
contextBridge.exposeInMainWorld("kaiDesktop", {
  pocketStatus: () => computerInvoke("mascot:pocket-status"),
  pocketSetup: () => computerInvoke("mascot:pocket-setup"),
  pocketWarm: voice => computerInvoke("mascot:pocket-warm", voice),
  pocketSpeech: request => computerInvoke("mascot:pocket-speech", request),
  cancelPocketSpeech: () => computerInvoke("mascot:pocket-cancel").catch(() => {}),
  releasePocket: () => computerInvoke("mascot:pocket-release").catch(() => {}),
  computerStatus: () => computerInvoke("mascot:computer-status"),
  computerBegin: request => computerInvoke("mascot:computer-begin", request),
  computerCall: (token, name, args) => computerInvoke("mascot:computer-call", token, name, args),
  computerEnd: () => computerInvoke("mascot:computer-end"),
  openWebsite: text => computerInvoke("mascot:open-website", text),
  eyesModel: model => computerInvoke("mascot:eyes-model", model),
  eyesEnable: (source, model) => computerInvoke("mascot:eyes-enable", source, model),
  eyesValidate: (source, model) => computerInvoke("mascot:eyes-validate", source, model),
  eyesCapture: (model, detail) => computerInvoke("mascot:eyes-capture", model, detail),
  eyesStop: source => computerInvoke("mascot:eyes-stop", source),
  expand: open => ipcRenderer.invoke("mascot:expand", !!open),
  openMain: view => ipcRenderer.send("mascot:main", view),
  navigate: view => ipcRenderer.invoke("mascot:navigate", view),
  confirmTool: (name, args) => ipcRenderer.invoke("mascot:confirm-tool", name, args),
  hide: () => ipcRenderer.send("mascot:hide"),
  openFolder: folder => ipcRenderer.invoke("mascot:open-folder", folder),
  cancelAction: () => ipcRenderer.send("mascot:cancel-action"),
  regions: regions => ipcRenderer.send("mascot:regions", regions),
  windowsVoices: refresh => ipcRenderer.invoke("mascot:windows-voices", refresh === true),
  windowsSpeech: async request => {
    try { return await ipcRenderer.invoke("mascot:windows-speech", request); }
    catch (error) {
      // Electron decorates rejected IPC calls with its internal method name.
      // Preserve the actionable voice message without exposing that wrapper.
      throw new Error(String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
    }
  },
  cancelWindowsSpeech: () => ipcRenderer.send("mascot:windows-speech-cancel"),
  windowsVoiceSettings: () => ipcRenderer.invoke("mascot:windows-voice-settings"),
  startDrag: () => ipcRenderer.send("mascot:drag-start"),
  endDrag: cancelled => ipcRenderer.send("mascot:drag-end", cancelled === true),
  onEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("mascot:event", listener);
    return () => ipcRenderer.removeListener("mascot:event", listener);
  },
});

// Private provider capability: no keys are returned to either renderer.
contextBridge.exposeInMainWorld("kaiProviderBridge", {
  status: () => ipcRenderer.invoke("providers:status"),
  save: (id, options) => ipcRenderer.invoke("providers:save", id, options),
  remove: id => ipcRenderer.invoke("providers:remove", id),
  refresh: id => ipcRenderer.invoke("providers:refresh", id),
  chat: (id, body) => ipcRenderer.invoke("providers:chat", id, body),
  cancel: id => ipcRenderer.invoke("providers:cancel", id),
  onDelta: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("providers:delta", listener);
    return () => ipcRenderer.removeListener("providers:delta", listener);
  },
  onChanged: callback => {
    const listener = () => callback();
    ipcRenderer.on("providers:changed", listener);
    return () => ipcRenderer.removeListener("providers:changed", listener);
  },
});
