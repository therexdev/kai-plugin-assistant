"use strict";

const path = require("path");
const { SIZE, fitBounds, dragPlacement } = require("./mascot-layout");

function trustedFrame(event, window, origin) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
}

// A second view of the same running Core. Hiding either window never stops the
// node, changes the wallet, or creates another model/runtime process.
function createMascotController({ BrowserWindow, screen, desktopCapturer, ipcMain, shell, app, dialog, prefs, origin, getMainWindow, getMainWebContents, hasTray = () => true, globalShortcut, describeModel = () => null, pocketVoice: suppliedPocketVoice }) {
  const actions = app && dialog ? require("./desktop-actions").createFolderActions({ app, dialog, shell }) : null;
  const approval = dialog ? require("./tool-approval").createToolApproval({ dialog }) : null;
  const navigation = require("../ui/app-navigation");
  const windowsVoice = new (require("./windows-voice").WindowsVoice)();
  let window = null, loading = null, expanded = false, dragging = null, timer = null;
  let regions = [], ignored = false, disposed = false, shaped = false;
  let perched = false;
  const handles = [], listeners = [];
  const send = (type, value) => {
    if (window && !window.isDestroyed()) window.webContents.send("mascot:event", { type, value });
  };
  const pocketVoice = suppliedPocketVoice || new (require("./pocket-voice").PocketVoice)({ dir: path.join(app?.getPath?.("userData") || require("os").tmpdir(), "speech", "pocket") });
  const computer = new (require("./computer-control").ComputerControl)({ dialog, shell, globalShortcut,
    getWindow: () => window, describeModel, onEvent: value => send("computer", value),
    highlight: (view, args) => require("./computer-highlight").highlight({ BrowserWindow, screen }, view, args) });
  const eyes = new (require("./mascot-eyes").MascotEyes)({ desktopCapturer, screen, dialog,
    getWindow: () => window, describeModel });
  function savePosition() {
    if (!window || window.isDestroyed()) return;
    const b = window.getBounds();
    prefs.set("mascot.position", { x: b.x + b.width, y: b.y + b.height, perched });
  }
  const pose = (value = {}) => send("placement", { pose: perched ? "perched" : "free", ...value });
  function unshape() {
    if (shaped) { window.setShape([]); shaped = false; }
  }
  function ignore(value) {
    if (!window || window.isDestroyed() || ignored === value) return;
    ignored = value;
    window.setIgnoreMouseEvents(value, { forward: true });
  }
  function tick() {
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    if (shaped && !dragging) return;
    const cursor = screen.getCursorScreenPoint();
    if (dragging) {
      const dx = cursor.x - dragging.cursor.x, dy = cursor.y - dragging.cursor.y;
      if (!dragging.moved && Math.hypot(dx, dy) <= 5) return;
      dragging.moved = true;
      const area = screen.getDisplayNearestPoint(cursor).workArea;
      const placement = dragPlacement(dragging, cursor, expanded, area);
      dragging.lifted = placement.lifted; dragging.placement = placement; dragging.area = area;
      const now = Date.now(), dt = Math.max(16, now - dragging.time);
      const target = Math.max(-16, Math.min(16, (cursor.x - dragging.previous.x) / dt * 12));
      dragging.sway = dragging.sway * .65 + target * .35;
      dragging.previous = cursor; dragging.time = now;
      // Use the intended cursor anchor, never an OS-adjusted off-screen
      // rectangle. Choose the monitor under the hand, not the large chat pane.
      const previousBounds = window.getBounds();
      if (["x", "y", "width", "height"].some(k => previousBounds[k] !== placement.bounds[k])) window.setBounds(placement.bounds);
      pose({ pose: placement.lifted ? "carried" : "perched", moving: true,
        nearFloor: placement.perched, sway: dragging.sway, offsetY: placement.offsetY });
      ignore(false);
      return;
    }
    const b = window.getBounds();
    // Polling also restores hit testing on Linux, where forwarded mouse events
    // are unavailable, and on Windows when another app swallows mouse moves.
    const x = cursor.x - b.x, y = cursor.y - b.y;
    ignore(regions.length > 0 && !regions.some(r => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height));
  }
  function resize(open) {
    if (!window || window.isDestroyed()) return;
    const b = window.getBounds();
    const anchor = { x: b.x + b.width, y: b.y + b.height };
    const area = screen.getDisplayNearestPoint({ x: anchor.x - Math.min(b.width, SIZE.compact.width) / 2, y: anchor.y - 1 }).workArea;
    if (perched) anchor.y = area.y + area.height;
    expanded = !!open;
    regions = [];
    ignore(false);
    unshape();
    window.setBounds(fitBounds(anchor, expanded, area));
    send("expanded", expanded);
    pose();
    savePosition();
  }
  async function launch(options = {}) {
    if (disposed) throw new Error("KAI is shutting down");
    if (!window || window.isDestroyed()) {
      const saved = prefs.get("mascot.position");
      const valid = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y);
      const point = valid ? { x: saved.x - 1, y: saved.y - 1 } : screen.getCursorScreenPoint();
      const area = screen.getDisplayNearestPoint(point).workArea;
      const anchor = valid ? saved : { x: area.x + area.width - 24, y: area.y + area.height - 16 };
      perched = !!valid && saved.perched === true;
      if (perched) anchor.y = area.y + area.height;
      expanded = false;
      window = new BrowserWindow({
        ...fitBounds(anchor, false, area), title: "KAI · Desktop companion",
        frame: false, transparent: true, backgroundColor: "#00000000",
        hasShadow: false, alwaysOnTop: true, skipTaskbar: true, show: false,
        resizable: false, maximizable: false, fullscreenable: false,
        autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, "mascot-preload.js"),
          contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true },
      });
      const created = window;
      created.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: "deny" };
      });
      created.webContents.on("will-navigate", (event, url) => {
        if (url !== origin + "/mascot.html") {
          event.preventDefault();
          if (/^https?:\/\//i.test(url) && new URL(url).origin !== origin) shell.openExternal(url);
        }
      });
      created.on("hide", () => { eyes.stop(); computer.cancel(); actions?.cancel(); approval?.cancel(); windowsVoice.cancel(); pocketVoice.close(); finishDrag(true); pose(); send("suspend", true); });
      created.on("blur", () => { if (dragging) finishDrag(true); });
      created.on("show", () => send("suspend", false));
      created.webContents.on("render-process-gone", () => { eyes.stop(); computer.cancel(); windowsVoice.cancel(); pocketVoice.close(); showMain(); });
      created.on("closed", () => {
        eyes.stop(); computer.cancel();
        windowsVoice.cancel(); pocketVoice.close(); clearInterval(timer); timer = null;
        window = null; loading = null; dragging = null; regions = []; ignored = false; shaped = false;
      });
      loading = created.loadURL(origin + "/mascot.html").catch(error => {
        if (!created.isDestroyed()) created.destroy();
        throw error;
      });
      timer = setInterval(tick, 33);
      timer.unref?.();
    }
    await loading;
    if (disposed || !window || window.isDestroyed()) return { ok: false };
    ignore(false);
    window.show();
    resize(false); // Every launch starts with just KAI; chat is opened explicitly.
    send("launch", { model: typeof options.model === "string" ? options.model.slice(0, 160) : null, expanded });
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.hide();
    return { ok: true };
  }
  function showMain(view = "chat", keepCompanion = false) {
    if (!keepCompanion && window && !window.isDestroyed()) { savePosition(); window.hide(); }
    const main = getMainWindow();
    if (!main || main.isDestroyed()) return { ok: false, error: "The main app window is unavailable." };
    if (main.isMinimized()) main.restore();
    main.show(); main.focus();
    const contents = getMainWebContents ? getMainWebContents() : main.webContents;
    if (contents && !contents.isDestroyed?.()) contents.send("mascot:open-view", navigation.valid(view) ? view : "chat");
    return { ok: true, view: navigation.valid(view) ? view : "chat", note: "Main window opened. Disabled feature screens show their Settings switch first." };
  }
  function on(channel, fn) {
    const listener = (event, ...args) => {
      if (trustedFrame(event, window, origin)) fn(...args);
    };
    ipcMain.on(channel, listener); listeners.push([channel, listener]);
  }
  function handle(channel, getWindow, fn, exactDocument = false) {
    ipcMain.handle(channel, (event, ...args) => {
      if (disposed || !trustedFrame(event, getWindow(), origin)) throw new Error("Untrusted KAI window");
      if (exactDocument && new URL(event.senderFrame.url).pathname !== "/mascot.html") throw new Error("Desktop control access denied.");
      return fn(...args);
    });
    handles.push(channel);
  }
  handle("mascot:launch", getMainWindow, options => launch(options || {}));
  handle("mascot:computer-status", () => window, () => computer.status(), true);
  handle("mascot:computer-begin", () => window, request => computer.begin(request), true);
  handle("mascot:computer-call", () => window, (token, name, args) => computer.call(token, name, args), true);
  handle("mascot:computer-end", () => window, () => computer.cancel("Desktop task finished."), true);
  handle("mascot:open-website", () => window, text => computer.openWebsite(text), true);
  handle("mascot:eyes-model", () => window, model => eyes.modelInfo(model), true);
  handle("mascot:eyes-enable", () => window, (source, model) => eyes.enable(source, model), true);
  handle("mascot:eyes-validate", () => window, (source, model) => eyes.validate(source, model), true);
  handle("mascot:eyes-capture", () => window, (model, detail) => eyes.capture(model, detail), true);
  handle("mascot:eyes-stop", () => window, source => eyes.stop(source), true);
  handle("mascot:expand", () => window, open => { resize(open); return { expanded }; });
  handle("mascot:open-folder", () => window, folder => {
    if (!actions) throw new Error("Desktop actions are unavailable in this window.");
    return actions.open(window, folder);
  });
  handle("mascot:confirm-tool", () => window, (name, args) => approval?.confirm(window, name, args) ?? false);
  handle("mascot:navigate", () => window, view => {
    if (!navigation.valid(view)) throw new Error("Unknown app screen");
    return showMain(view, true);
  });
  handle("mascot:pocket-status", () => window, () => pocketVoice.status(), true);
  handle("mascot:pocket-setup", () => window, () => {
    if (!window.isVisible()) throw new Error("KAI is hidden.");
    pocketVoice.ensure().catch(() => {}); return pocketVoice.status();
  }, true);
  handle("mascot:pocket-warm", () => window, voice => {
    if (!window.isVisible()) throw new Error("KAI is hidden.");
    return pocketVoice.warm(voice);
  }, true);
  handle("mascot:pocket-speech", () => window, request => {
    if (!window.isVisible()) throw new Error("KAI is hidden.");
    if (!request || typeof request.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(request.id)) throw new Error("Invalid voice request.");
    return pocketVoice.generate(request, chunk => send("pocket-audio", { ...chunk, id: request.id }));
  }, true);
  handle("mascot:pocket-cancel", () => window, () => pocketVoice.cancel(), true);
  handle("mascot:pocket-release", () => window, () => pocketVoice.close(), true);
  // Local voice audio is a private desktop capability, never a Core/network tool.
  handle("mascot:windows-voices", () => window, refresh => windowsVoice.status(refresh === true));
  handle("mascot:windows-speech", () => window, request => {
    if (!window.isVisible()) throw new Error("KAI is hidden.");
    return windowsVoice.generate(request);
  });
  handle("mascot:windows-voice-settings", () => window, () => {
    if (process.platform !== "win32" || !window.isVisible()) return false;
    return shell.openExternal("ms-settings:speech").then(() => true);
  });
  on("mascot:windows-speech-cancel", () => windowsVoice.cancel());
  on("mascot:cancel-action", () => { computer.cancel(); actions?.cancel(); approval?.cancel(); });
  on("mascot:main", showMain);
  on("mascot:regions", value => {
    if (!Array.isArray(value)) return;
    regions = value.slice(0, 12).filter(r => r && ["x", "y", "width", "height"].every(k => Number.isFinite(r[k])) &&
      r.width > 0 && r.height > 0 && r.width <= 2000 && r.height <= 2000);
    if (dragging) return; // Keep pointer capture over the entire moving window.
    if (process.platform !== "darwin" && typeof window.setShape === "function" && regions.length) {
      try {
        // Native hit regions avoid a polling delay on the first click and let
        // the desktop receive clicks through the large empty part of chat mode.
        window.setShape(regions.map(r => ({
          x: Math.floor(r.x), y: Math.floor(r.y),
          width: Math.ceil(r.x + r.width) - Math.floor(r.x),
          height: Math.ceil(r.y + r.height) - Math.floor(r.y),
        })));
        shaped = true; ignore(false);
      } catch { shaped = false; }
    }
    tick();
  });
  on("mascot:drag-start", () => {
    if (dragging || !window.isVisible()) return;
    const bounds = window.getBounds(), cursor = screen.getCursorScreenPoint();
    dragging = { anchor: { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, cursor, perched,
      previous: cursor, time: Date.now(), sway: 0, moved: false, lifted: false };
    unshape();
    pose({ pose: perched ? "perched" : "carried", moving: false });
    ignore(false);
  });
  function finishDrag(cancelled = false) {
    if (!dragging) return;
    if (!cancelled) tick(); // Include the final cursor movement before release.
    const drag = dragging;
    dragging = null;
    if (drag.moved && drag.placement) {
      perched = drag.placement.perched;
      const anchor = { ...drag.placement.anchor };
      if (perched) anchor.y = drag.area.y + drag.area.height;
      window.setBounds(fitBounds(anchor, expanded, drag.area));
    }
    pose({ landed: drag.moved && !cancelled, cancelled });
    savePosition();
  }
  on("mascot:drag-end", cancelled => finishDrag(cancelled === true));
  on("mascot:hide", () => { if (!hasTray()) return showMain(); savePosition(); window.hide(); });
  const onDisplayChange = () => {
    if (window && !window.isDestroyed()) { finishDrag(true); resize(expanded); }
  };
  screen.on("display-removed", onDisplayChange);
  screen.on("display-metrics-changed", onDisplayChange);
  return {
    launch, showMain, getWindow: () => window,
    hide() { if (window && !window.isDestroyed()) { savePosition(); window.hide(); } },
    dispose() {
      if (disposed) return;
      disposed = true; eyes.stop(); computer.cancel(); actions?.cancel(); approval?.cancel(); windowsVoice.close(); pocketVoice.close(); clearInterval(timer);
      screen.removeListener("display-removed", onDisplayChange);
      screen.removeListener("display-metrics-changed", onDisplayChange);
      if (window && !window.isDestroyed()) { try { savePosition(); } finally { window.destroy(); } }
      for (const channel of handles) ipcMain.removeHandler(channel);
      for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
    },
  };
}

module.exports = { createMascotController, fitBounds, trustedFrame, SIZE };
