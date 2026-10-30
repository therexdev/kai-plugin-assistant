"use strict";
const { randomUUID } = require("crypto");
const { NativeComputer } = require("./native-computer");
const catalog = require("../ui/computer-tools");
const stopError = message => Object.assign(new Error(message || "Desktop control stopped."), { name: "AbortError" });
const RISK = /\b(buy|rent|purchase|pay|payment|checkout|subscribe|subscription|send|post|publish|delete|remove|erase|transfer|withdraw|password|credential|permission|allow|grant|install|download|security|admin|terminal|console|execute|run command|confirm|accept|agree|order|bid|book|sign in|log in)\b/i;
const SAFE_CLICK = /^(play|play movie|play video|watch|watch now|watch movie|watch video|resume|resume playback|continue watching|pause|back|forward|next page|previous page|search|close search|full screen|fullscreen|exit full screen|exit fullscreen|mute|unmute)(?:\s+button)?$/i;
const SEARCH = /\b(search|find)\b/i;
const fields = { look: ["window"], open: ["url"], click: ["frame", "element"], type: ["frame", "element", "text"], key: ["frame", "key"], scroll: ["frame", "direction", "amount"], window: ["window"], point: ["frame", "x", "y", "reason"], drag: ["frame", "x", "y", "toX", "toY", "reason"] };
const KEYS = new Set("ENTER TAB SHIFT+TAB ESCAPE SPACE UP DOWN LEFT RIGHT PAGEUP PAGEDOWN HOME END CTRL+L CTRL+A ALT+LEFT ALT+RIGHT ALT+F4".split(" "));

class ComputerControl {
  constructor({ native = new NativeComputer(), dialog, shell, globalShortcut, getWindow, describeModel, highlight = () => () => {}, onEvent = () => {}, now = Date.now, settle = () => new Promise(resolve => setTimeout(resolve, 250)) }) {
    Object.assign(this, { native, dialog, shell, globalShortcut, getWindow, describeModel, highlight, onEvent, now, settle });
    this.generation = 0;
  }
  status() { return { available: this.native.available(), active: !!this.session, shortcut: this.shortcut || "Ctrl+Alt+Backspace" }; }
  visible() { const w = this.getWindow(); return w && !w.isDestroyed() && w.isVisible(); }
  emit(extra = {}) { this.onEvent({ ...this.status(), pending: !!this.prompt, ...extra }); }
  cancel(reason = "Desktop control stopped.") {
    this.generation++; this.session = null; this.snapshot = null; this.inFlight = false;
    clearTimeout(this.timer); this.prompt?.abort(); this.prompt = null;
    this.clearHighlight?.(); this.clearHighlight = null;
    if (this.shortcut) this.globalShortcut.unregister(this.shortcut);
    this.shortcut = null; this.native.cancel(); this.emit({ reason });
  }
  async approve(message, detail, generation) {
    if (!this.visible() || this.prompt) throw stopError();
    const controller = this.prompt = new AbortController(); this.emit();
    try {
      const result = await this.dialog.showMessageBox(this.getWindow(), { type: "question", title: "KAI · Desktop control", message, detail,
        buttons: ["Cancel", "Allow"], defaultId: 0, cancelId: 0, noLink: true, signal: controller.signal });
      if (controller.signal.aborted || generation !== this.generation || !this.visible()) throw stopError();
      if (result.response !== 1) { this.cancel("Desktop action declined."); throw stopError("Desktop action declined. Nothing further will run."); }
    } finally { if (this.prompt === controller) this.prompt = null; this.emit(); }
  }
  async modelInfo(model) {
    if (typeof model !== "string" || model.length > 180 || /^koinos-network(?:$|:)/.test(model)) throw new Error("Choose an installed local model or your private OpenAI/Anthropic connection for desktop control.");
    const info = await this.describeModel(model);
    if (!info || !["local", "private"].includes(info.kind)) throw new Error("That model cannot receive your desktop. Choose a local model or private API connection.");
    return info;
  }
  async begin({ task, model } = {}) {
    if (this.session || this.prompt) throw new Error("A desktop task is already active.");
    if (!this.native.available()) throw new Error("Desktop control is available in the Windows desktop app.");
    if (typeof task !== "string" || !task.trim() || task.length > 4000 || !this.visible()) throw new Error("Ask KAI for one desktop task while the companion is visible.");
    const generation = ++this.generation, info = await this.modelInfo(model);
    if (generation !== this.generation) throw stopError();
    for (const shortcut of ["CommandOrControl+Alt+Backspace", "F8"]) {
      if (this.globalShortcut?.register(shortcut, () => { this.cancel("Stopped with the keyboard shortcut."); this.onEvent({ stopped: true }); })) { this.shortcut = shortcut; break; }
    }
    if (!this.shortcut) throw new Error("KAI couldn't reserve its stop shortcut. Another app is using Ctrl+Alt+Backspace and F8; free one of those shortcuts and try again.");
    try {
      await this.approve("Let KAI work on this desktop task?", `Your request: ${task}\n\nKAI can read visible window text${info.vision ? " and screenshots" : ""}, switch windows, click, type and scroll until this request ends. ${info.kind === "local" ? "Screen information stays with your installed local model." : `Screen information will be sent to your private ${info.label} API connection.`}\n\nPurchases, messages, destructive actions and visual clicks need another confirmation. Enter passwords yourself. Stop any time with ${this.shortcut.replace("CommandOrControl", "Ctrl")} or KAI's Stop button.`, generation);
      const session = this.session = { id: randomUUID(), task, model, info, started: this.now(), steps: 0, generation };
      this.lease(); this.emit(); return { id: session.id, vision: !!info.vision, shortcut: this.shortcut };
    } catch (error) { if (generation === this.generation) this.cancel(); throw error; }
  }
  lease() { clearTimeout(this.timer); this.timer = setTimeout(() => { this.cancel("Desktop permission expired. Ask KAI again."); this.onEvent({ stopped: true }); }, 120000); this.timer.unref?.(); }
  async check(token) {
    const s = this.session;
    if (!s || token !== s.id || !this.visible() || this.now() - s.started > 600000 || s.steps >= 32) throw stopError("This desktop task ended. Ask KAI again to continue.");
    const info = await this.modelInfo(s.model);
    if (this.session !== s || info.kind !== s.info.kind || !!info.vision !== !!s.info.vision) throw stopError();
    return s;
  }
  async look(s, window) {
    let view;
    try { view = await this.native.request({ op: "look", ...(window ? { window } : {}), image: !!s.info.vision }); }
    catch (error) {
      // A hung accessibility provider is isolated in our disposable process.
      if (error.code !== "NATIVE_TIMEOUT" || !s.info.vision || this.session !== s) throw error;
      view = await this.native.request({ op: "look", ...(window ? { window } : {}), image: true, accessibility: false });
    }
    if (this.session !== s) throw stopError();
    this.snapshot = { view, at: this.now() }; return view;
  }
  async call(token, name, args = {}) {
    if (this.inFlight) throw new Error("Wait for the current desktop action to finish.");
    const marker = this.inFlight = {}, generation = this.generation;
    try {
      const s = await this.check(token), action = typeof name === "string" ? name.replace(/^computer_/, "") : "";
      if (typeof name !== "string" || !name.startsWith("computer_") || !Object.hasOwn(fields, action) || !args || Array.isArray(args) || typeof args !== "object" || Object.keys(args).some(k => !fields[action].includes(k))) throw new Error("Invalid desktop action.");
      s.steps++; this.lease();
      const previous = this.snapshot?.view;
      if (["window", "look"].includes(action) && args.window !== undefined && !previous?.windows?.some(w => w.id === args.window)) throw new Error("Choose a window from the latest desktop view.");
      if (action === "look") return { summary: "Inspected the visible window.", screen: await this.look(s, args.window) };
      if (action === "open") {
        const url = catalog.validURL(args.url);
        // Navigation from a model is reviewed; direct user website commands use
        // openWebsite, which derives its URL independently in the main process.
        await this.approve("Open this website?", `${url}\n\nFor: ${s.task}`, s.generation);
        await this.check(token); await this.shell.openExternal(url); await this.settle();
        return { summary: `Opened ${new URL(url).hostname} in your default browser. Playback is not yet verified.`, screen: await this.look(s) };
      }
      if (!previous || this.now() - this.snapshot.at > 90000) throw new Error("The desktop view expired. Look again before acting.");
      if (action === "window") {
        if (!args.window) throw new Error("Choose an observed window.");
        const out = await this.native.request({ op: "focus", window: args.window });
        if (!out.ok) throw new Error("Click that window to bring it forward, then ask KAI again.");
        await this.settle(); return { summary: "Brought the selected window forward.", screen: await this.look(s, args.window) };
      }
      if (args.frame !== previous.frame) throw new Error("That desktop view is stale. Look again before acting.");
      const target = previous.elements?.find(e => e.id === args.element);
      if (["click", "type"].includes(action) && (!target || target.password || !target.enabled)) throw new Error("Choose an enabled non-password control from the latest view.");
      if (action === "type" && (typeof args.text !== "string" || !args.text.length || args.text.length > 500 || /[\u0000-\u001f\u007f]/.test(args.text) || !["Edit", "Document"].includes(target.role))) throw new Error("Choose a text field and type at most 500 plain-text characters.");
      if (action === "key" && !KEYS.has(args.key)) throw new Error("That key combination is not supported.");
      if (action === "scroll" && (!["up", "down"].includes(args.direction) || args.amount !== undefined && (!Number.isInteger(args.amount) || args.amount < 1 || args.amount > 5))) throw new Error("Scroll up or down by 1 to 5 steps.");
      const visual = ["point", "drag"].includes(action);
      if (visual && (!s.info.vision || !previous.image || typeof args.reason !== "string" || !args.reason.trim() || args.reason.length > 350 || (action === "point" ? ["x", "y"] : ["x", "y", "toX", "toY"]).some(k => !Number.isInteger(args[k]) || args[k] < 0 || args[k] > 1000))) throw new Error("Visual actions require a screenshot-capable model, a visible target description and coordinates from 0 to 1000.");
      const focused = previous.elements?.find(e => e.focused), risk = RISK.test(`${target?.name || ""} ${target?.context || ""}`);
      const query = action === "type" && SEARCH.test(target.name) && s.task.toLowerCase().includes(args.text.toLowerCase()) && !risk;
      const searchEnter = action === "key" && args.key === "ENTER" && focused && SEARCH.test(focused.name) && focused.value && focused.value === s.searchText && !RISK.test(focused.name + " " + focused.context);
      const ordinary = action === "scroll" || action === "click" && !risk && (SAFE_CLICK.test(target.name) || target.role === "Hyperlink" && target.name.length > 3 && s.task.toLowerCase().includes(target.name.toLowerCase())) || query || searchEnter || action === "key" && ["ESCAPE", "TAB", "SHIFT+TAB", "ALT+LEFT", "ALT+RIGHT"].includes(args.key);
      if (!ordinary || visual) {
        const detail = visual ? `${args.reason}\nPosition: ${args.x}, ${args.y}${action === "drag" ? ` → ${args.toX}, ${args.toY}` : ""} (0–1000 within the visible window)` : `${target ? `${target.role}: ${target.name}\nContext: ${target.context || ""}` : `Key: ${args.key}`} ${action === "type" ? `\nText: ${args.text}` : ""}`;
        if (visual) this.clearHighlight = this.highlight(previous, args);
        try { await this.approve(`Allow KAI to ${action === "point" ? "click the marked position" : action}?`, `${detail}\n\nWindow: ${previous.window.title}\nFor: ${s.task}\n\nCancel if this would buy, rent, send or change something you don't intend.`, s.generation); }
        finally { this.clearHighlight?.(); this.clearHighlight = null; }
      }
      await this.check(token);
      // Invalidate before input: failures can be partial, never retry a write.
      this.snapshot = null;
      await this.native.request({ op: "act", action, ...args, ...(action === "key" && focused ? { focus: focused.id } : {}) });
      if (this.session !== s) throw stopError();
      s.searchText = query ? args.text : searchEnter ? null : s.searchText;
      await this.settle();
      return { summary: `${action === "click" ? `Clicked ${target.name}` : action === "type" ? `Entered text in ${target.name || "the selected field"}` : `Completed ${action}`}. Verify the updated view before reporting the task finished.`, screen: await this.look(s, previous.window.id) };
    } catch (error) {
      if (generation === this.generation) this.cancel(error.message); throw error;
    } finally { if (this.inFlight === marker) this.inFlight = false; }
  }
  async openWebsite(text) {
    if (!this.visible()) throw new Error("Open KAI first.");
    const request = catalog.websiteRequest(text);
    if (!request) throw new Error("Ask directly to open a known website or a complete http/https address.");
    await this.shell.openExternal(catalog.validURL(request.url));
    return { ok: true, url: request.url, message: `Opened ${request.label} in your default browser.` };
  }
}
module.exports = { ComputerControl };
