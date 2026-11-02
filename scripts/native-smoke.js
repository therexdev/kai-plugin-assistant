"use strict";
const { app, BrowserWindow, ipcMain, protocol } = require("electron"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { snapshotRuntime, assertRuntimeUnchanged, readonlyRuntime } = require("./runtime-snapshot");
const root = path.resolve(process.env.KAI_ASSISTANT_SMOKE_ROOT || path.join(__dirname, "../.build/plugin")), profile = process.env.KAI_ASSISTANT_SMOKE_PROFILE;
assert.ok(profile && fs.statSync(profile).isDirectory(), "Run this fixture through scripts/run-native-smoke.js");
app.setPath("userData", profile); app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: "kai-plugin", privileges: { standard: true, secure: true } }]);
let service, win, originalRuntime, restoreModes; const lifetime = new AbortController(), settings = new Map(), state = new Map(), localeListeners = new Set();
let language = "en";
const locale = { get: () => ({ language, selected: true, direction: "ltr" }), onChange(callback) { localeListeners.add(callback); return () => localeListeners.delete(callback); } };
function changeLanguage(value) { language = value; win.webContents.send("kai:locale-changed", locale.get()); for (const callback of localeListeners) callback(locale.get()); }
app.whenReady().then(async () => {
  originalRuntime = snapshotRuntime(root); restoreModes = readonlyRuntime(root, originalRuntime);
  protocol.handle("kai-plugin", request => { const url = new URL(request.url), name = decodeURIComponent(url.pathname.slice(1)); if (url.hostname !== "kai.assistant" || name.includes("..")) return new Response("Not found", { status: 404 }); const file = path.join(root, name); if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response("Not found", { status: 404 }); const ext = path.extname(file), types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png" }; return new Response(fs.readFileSync(file), { headers: { "content-type": types[ext] || "text/plain" } }); });
  win = new BrowserWindow({ width: 1100, height: 780, show: false, webPreferences: { preload: path.join(__dirname, "native-smoke-preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const api = { version: 1, plugin: { id: "kai.assistant", version: JSON.parse(fs.readFileSync(path.join(root, "manifest.json"))).version, root, dataDir: path.join(profile, "assistant") }, signal: lifetime.signal, locale,
    models: { list: () => [{ alias: "smoke-local", label: "Smoke local model", status: "ready" }], status: () => ({ state: "idle" }), ensure: async () => ({ loaded: true }), request: async () => new Response('data: {"choices":[{"delta":{"content":"Fixture reply"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }) },
    network: { status: () => ({ privacyMode: "local-only" }), models: async () => ({ models: [] }), configure: async input => input, fetch: async () => { throw Error("Fixture egress blocked"); } },
    settings: { get: (key, fallback) => settings.has(key) ? settings.get(key) : fallback, set: (key, value) => settings.set(key, value) },
    secrets: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: buffer => buffer.toString() },
    desktop: { hostWindowId: () => win.id, rendererId: () => win.webContents.id, isVisible: () => win.isVisible(), send: (channel, input) => win.webContents.send(channel, input), openPlugin: async () => win.show(), openCore: async () => win.show(), confirm: async () => false },
    wallet: { authorize: async () => { throw Error("Fixture payments blocked"); } },
    services: { provide: () => () => {}, call: async name => { throw Object.assign(Error("Install and enable a plugin providing " + name), { code: "SERVICE_UNAVAILABLE" }); } }, log: (level, message) => console.log(level + ": " + message) };
  fs.mkdirSync(api.plugin.dataDir, { recursive: true }); service = require(path.join(root, "service/index.js")).create(api);
  ipcMain.handle("assistant-smoke:call", async (event, method, input) => { if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw Error("Invalid fixture caller"); if (method === "locale.get") return locale.get(); if (method === "storage.get") return state.get(input.key) ?? null; if (method === "storage.set") { state.set(input.key, input.value); return true; } if (method === "models.list") return api.models.list(); return service.call(method, input, lifetime.signal); });
  // Simulate Core's asynchronous dialog bridge without granting any action.
  ipcMain.handle("assistant-smoke:dialog", async (event, kind, message) => { if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw Error("Invalid fixture caller"); assert.ok(["confirm", "alert"].includes(kind)); assert.equal(typeof message, "string"); return kind === "confirm" ? false : undefined; });
  await win.loadURL("kai-plugin://kai.assistant/index.html"); win.show(); win.setContentSize(1100, 780); await service.startBackground();
  await win.webContents.executeJavaScript("window.kaiLanguageReady");
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('language-dialog') === null"), true, "Only Core owns language onboarding");
  await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await new Promise(resolve => setTimeout(resolve, 300));
  const launcher = await win.webContents.executeJavaScript(`(() => {
    const button = document.getElementById('launch-kai'), nav = document.querySelector('.assistant-nav');
    const rect = button.getBoundingClientRect(), navRect = nav.getBoundingClientRect();
    return { text: button.innerText.trim(), robot: !!button.querySelector('.kai-avatar svg'),
      visible: !button.hidden && rect.width > 0 && rect.height >= 40,
      rightAligned: rect.left > navRect.right && innerWidth - rect.right < 50,
      gradient: getComputedStyle(button).backgroundImage.includes('linear-gradient'), rect: rect.toJSON(), navRect: navRect.toJSON(), width: innerWidth };
  })()`);
  const output = process.env.KAI_ASSISTANT_SMOKE_OUTPUT || path.join(os.tmpdir(), "kai-assistant-foundation-smoke"); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "assistant.png"), (await win.webContents.capturePage()).toPNG());
  assert.equal(launcher.text, "Open KAI"); assert.ok(launcher.robot && launcher.visible && launcher.rightAligned && launcher.gradient, "Robot launcher is visible at the upper right with app styling: " + JSON.stringify(launcher));
  await win.webContents.executeJavaScript("document.querySelector('.assistant-nav [data-view=settings]').click(); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await new Promise(resolve => setTimeout(resolve, 300));
  fs.writeFileSync(path.join(output, "assistant-settings.png"), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("document.querySelector('.assistant-nav [data-view=chat]').click()");
  assert.equal(await win.webContents.executeJavaScript('window.kai.dialogs.confirm("Fixture approval").then(value => value === false)'), true, "Renderer cancellation crosses the asynchronous dialog bridge");
  await win.webContents.executeJavaScript('window.kai.dialogs.alert("Fixture notice")');
  await win.webContents.executeJavaScript("document.getElementById('launch-kai').click()");
  let mascot; const launchDeadline = Date.now() + 30000;
  while (!mascot && Date.now() < launchDeadline) {
    mascot = BrowserWindow.getAllWindows().find(w => w !== win && /\/mascot.html$/.test(w.webContents.getURL()));
    if (!mascot) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(mascot, "Open KAI launches the desktop companion through the rendered button");
  await mascot.webContents.executeJavaScript("window.kaiLanguageReady");
  // Check the served companion catalog, not only the HTML language attribute.
  const catalog = await mascot.webContents.executeJavaScript("fetch('/locales/ui.js').then(async r=>({ok:r.ok,type:r.headers.get('content-type'),body:await r.text()}))");
  assert.equal(catalog.ok, true); assert.match(catalog.type, /javascript/); assert.match(catalog.body, /KaiLocaleCatalogs/);
  await mascot.webContents.executeJavaScript("document.getElementById('question').value='Settings <script> & {0}'");
  for (const language of ["es", "pt-BR", "fr", "de", "en"]) {
    changeLanguage(language); await new Promise(resolve => setTimeout(resolve, 100));
    for (const window of [win, mascot]) assert.equal(await window.webContents.executeJavaScript("document.documentElement.lang"), language, "Launcher and companion follow Core");
    const live = await mascot.webContents.executeJavaScript("({menu:document.getElementById('menu-computer').textContent,expected:KaiI18n.t('Desktop control'),draft:document.getElementById('question').value,tryVoice:KaiI18n.t(KaiI18n.message(['Try ', ''], 'Settings'))})");
    assert.equal(live.menu, live.expected); assert.equal(live.draft, "Settings <script> & {0}");
    if (language !== "en") { assert.notEqual(live.menu, "Desktop control"); assert.notEqual(live.tryVoice, "Try Settings"); }
  }

  await new Promise(resolve => setTimeout(resolve, 750));
  const status = await mascot.webContents.executeJavaScript(`({ runtime:performance.getEntriesByType('resource').some(r=>r.name.endsWith('/mascot.js')), model:document.querySelector('#model')?.value, body:document.body.innerText.slice(0,300), errors:document.querySelector('#connection')?.textContent })`);
  assert.equal(status.runtime, true, "Desktop companion main script is loaded");
  assert.ok((await mascot.webContents.executeJavaScript("document.querySelectorAll('script').length")) > 5);
  const response = await mascot.webContents.executeJavaScript("fetch('/core/models').then(r=>r.json())"); assert.equal(response.aliases[0].alias, "smoke-local");
  // Exercise the production Electron utility process, including its real OS
  // environment, then verify the complete signed code tree before reopening.
  const warmed = await service.call("assistant.request", { path: "/core/turn/warm", method: "POST" }, lifetime.signal);
  assert.equal(warmed.ok, true); assertRuntimeUnchanged(originalRuntime, snapshotRuntime(root));
  const canvas = await mascot.webContents.capturePage(); fs.writeFileSync(path.join(output, "companion.png"), canvas.toPNG());
  await service.dispose({ reason: "quit" }); assertRuntimeUnchanged(originalRuntime, snapshotRuntime(root));
  service = require(path.join(root, "service/index.js")).create(api); await service.startBackground();
  await service.call("assistant.native", { action: "mascot:launch", args: [{ model: "smoke-local" }] }, lifetime.signal);
  assert.equal((await service.call("assistant.request", { path: "/core/turn/warm", method: "POST" }, lifetime.signal)).ok, true);
  await service.dispose({ reason: "quit" }); assertRuntimeUnchanged(originalRuntime, snapshotRuntime(root));
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ passed: true, status, launcher, launcherClicked: true, root, nativeTurnLaunches: 2, signedRuntimeUnchanged: true }, null, 2));
  restoreModes(); lifetime.abort(); win.destroy(); app.quit();
}).catch(async error => { console.error(error.stack); try { await service?.dispose({ reason: "quit" }); } catch {} try { if (originalRuntime) assertRuntimeUnchanged(originalRuntime, snapshotRuntime(root)); } catch (integrityError) { console.error(integrityError.stack); } try { restoreModes?.(); } catch (restoreError) { console.error(restoreError.stack); } app.exit(1); });
