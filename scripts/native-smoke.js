"use strict";
const { app, BrowserWindow, ipcMain, protocol } = require("electron"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const root = path.resolve(process.env.KAI_ASSISTANT_SMOKE_ROOT || path.join(__dirname, "../.build/plugin")), profile = fs.mkdtempSync(path.join(os.tmpdir(), "kai-assistant-native-"));
app.setPath("userData", profile); app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: "kai-plugin", privileges: { standard: true, secure: true } }]);
let service, win; const lifetime = new AbortController(), settings = new Map(), state = new Map();
app.whenReady().then(async () => {
  protocol.handle("kai-plugin", request => { const url = new URL(request.url), name = decodeURIComponent(url.pathname.slice(1)); if (url.hostname !== "kai.assistant" || name.includes("..")) return new Response("Not found", { status: 404 }); const file = path.join(root, name); if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response("Not found", { status: 404 }); const ext = path.extname(file), types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png" }; return new Response(fs.readFileSync(file), { headers: { "content-type": types[ext] || "text/plain" } }); });
  win = new BrowserWindow({ width: 1100, height: 780, show: false, webPreferences: { preload: path.join(__dirname, "native-smoke-preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const api = { version: 1, plugin: { id: "kai.assistant", version: "0.3.0", root, dataDir: path.join(profile, "assistant") }, signal: lifetime.signal,
    models: { list: () => [{ alias: "smoke-local", label: "Smoke local model", status: "ready" }], status: () => ({ state: "idle" }), ensure: async () => ({ loaded: true }), request: async () => new Response('data: {"choices":[{"delta":{"content":"Fixture reply"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) },
    network: { status: () => ({ privacyMode: "local-only" }), models: async () => ({ models: [] }), configure: async input => input, fetch: async () => { throw Error("Fixture egress blocked"); } },
    settings: { get: (key, fallback) => settings.has(key) ? settings.get(key) : fallback, set: (key, value) => settings.set(key, value) },
    secrets: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: buffer => buffer.toString() },
    desktop: { hostWindowId: () => win.id, rendererId: () => win.webContents.id, isVisible: () => win.isVisible(), send: (channel, input) => win.webContents.send(channel, input), openPlugin: async () => win.show(), openCore: async () => win.show(), confirm: async () => false },
    wallet: { authorize: async () => { throw Error("Fixture payments blocked"); } },
    services: { provide: () => () => {}, call: async name => { throw Object.assign(Error("Install and enable a plugin providing " + name), { code: "SERVICE_UNAVAILABLE" }); } }, log: (level, message) => console.log(level + ": " + message) };
  fs.mkdirSync(api.plugin.dataDir, { recursive: true }); service = require(path.join(root, "service/index.js")).create(api);
  ipcMain.handle("assistant-smoke:call", async (event, method, input) => { if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw Error("Invalid fixture caller"); if (method === "storage.get") return state.get(input.key) ?? null; if (method === "storage.set") { state.set(input.key, input.value); return true; } if (method === "models.list") return api.models.list(); return service.call(method, input, lifetime.signal); });
  await win.loadURL("kai-plugin://kai.assistant/index.html"); win.show(); await service.startBackground();
  await service.call("assistant.native", { action: "mascot:launch", args: [{ model: "smoke-local" }] }, lifetime.signal);
  const mascot = BrowserWindow.getAllWindows().find(w => w !== win && /\/mascot.html$/.test(w.webContents.getURL())); assert.ok(mascot, "Desktop companion opens");
  await new Promise(resolve => setTimeout(resolve, 750));
  const status = await mascot.webContents.executeJavaScript(`({ runtime:performance.getEntriesByType('resource').some(r=>r.name.endsWith('/mascot.js')), model:document.querySelector('#model')?.value, body:document.body.innerText.slice(0,300), errors:document.querySelector('#connection')?.textContent })`);
  assert.equal(status.runtime, true, "Desktop companion main script is loaded");
  assert.ok((await mascot.webContents.executeJavaScript("document.querySelectorAll('script').length")) > 5);
  const response = await mascot.webContents.executeJavaScript("fetch('/core/models').then(r=>r.json())"); assert.equal(response.aliases[0].alias, "smoke-local");
  const canvas = await mascot.webContents.capturePage(); const output = process.env.KAI_ASSISTANT_SMOKE_OUTPUT || path.join(os.tmpdir(), "kai-assistant-foundation-smoke"); fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, "companion.png"), canvas.toPNG()); fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ passed: true, status, root }, null, 2));
  await service.dispose({ reason: "quit" }); lifetime.abort(); win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.quit();
}).catch(async error => { console.error(error.stack); try { await service?.dispose({ reason: "quit" }); } catch {} app.exit(1); });
