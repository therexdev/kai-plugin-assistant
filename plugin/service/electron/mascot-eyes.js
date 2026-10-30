"use strict";

const SOURCES = new Set(["screen", "camera"]);
const DETAIL = Object.freeze({
  context: Object.freeze({ dimension: 640, quality: 58, maxBytes: 1_200_000 }),
  look: Object.freeze({ dimension: 1600, quality: 82, maxBytes: 4_000_000 }),
});

function fitSize(width, height, dimension) {
  const scale = dimension / Math.max(1, width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function stopped(message = "KAI Eyes stopped.") {
  return Object.assign(new Error(message), { name: "AbortError" });
}

/**
 * Main-process privacy boundary for passive screen/camera sensing.
 *
 * Camera pixels stay in the sandboxed companion renderer, but its grant is
 * still created and validated here. Screen pixels are captured here because
 * Electron's desktopCapturer is intentionally unavailable to the renderer.
 * Grants are session-only, bound to one source and one exact model, and are
 * cleared whenever the companion hides.
 */
class MascotEyes {
  constructor({ desktopCapturer, screen, dialog, getWindow, describeModel, now = Date.now } = {}) {
    Object.assign(this, { desktopCapturer, screen, dialog, getWindow, describeModel, now });
    this.grants = new Map();
    this.generation = 0;
    this.prompt = null;
  }

  visible() {
    const window = this.getWindow?.();
    return !!window && !window.isDestroyed() && window.isVisible();
  }

  async modelInfo(model) {
    if (typeof model !== "string" || !model || model.length > 180 || /^koinos-network(?:$|:)/.test(model)) {
      throw new Error("KAI Eyes needs an installed local vision model or your private OpenAI/Anthropic vision model.");
    }
    const info = await this.describeModel?.(model);
    if (!info || !["local", "private"].includes(info.kind)) {
      throw new Error("That model cannot receive camera or screen context. Choose a local or private vision model.");
    }
    if (!info.vision) throw new Error("That brain cannot see images. Choose a vision-capable model first.");
    return { kind: info.kind, label: String(info.label || model).slice(0, 180), vision: true };
  }

  async enable(source, model) {
    if (!SOURCES.has(source)) throw new Error("Unknown KAI Eyes source.");
    if (!this.visible()) throw stopped("Open KAI before turning on vision.");
    const current = this.grants.get(source);
    if (current?.model === model) return { enabled: true, source, model, destination: current.info.kind, label: current.info.label };
    if (this.prompt) throw new Error("Finish the current KAI Eyes choice first.");
    const generation = ++this.generation;
    const info = await this.modelInfo(model);
    if (generation !== this.generation || !this.visible()) throw stopped();
    const controller = this.prompt = new AbortController();
    const label = source === "screen" ? "screen" : "camera";
    const destination = info.kind === "local"
      ? `Frames stay on this computer and go only to ${info.label}.`
      : `Frames will be sent directly to your private ${info.label} API connection for the turns you ask KAI.`;
    try {
      const result = await this.dialog.showMessageBox(this.getWindow(), {
        type: "question",
        title: "KAI Eyes",
        message: `Turn on ${label} vision?`,
        detail: `KAI will keep a small, in-memory rolling view and attach only the freshest frame when you ask something. A higher-detail look happens only when needed. ${destination}\n\nA visible indicator stays on while capture is active. Turning this off, hiding KAI, changing brains or quitting discards the frames and stops capture.`,
        buttons: ["Not now", "Turn on"], defaultId: 0, cancelId: 0, noLink: true, signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== this.generation || !this.visible()) throw stopped();
      if (result.response !== 1) return { enabled: false, source, reason: "declined" };
      this.grants.set(source, { model, info, grantedAt: this.now() });
      return { enabled: true, source, model, destination: info.kind, label: info.label };
    } finally {
      if (this.prompt === controller) this.prompt = null;
    }
  }

  stop(source) {
    this.generation++;
    this.prompt?.abort();
    this.prompt = null;
    if (source === undefined) this.grants.clear();
    else if (SOURCES.has(source)) this.grants.delete(source);
    return { ok: true, active: [...this.grants.keys()] };
  }

  async validate(source, model) {
    if (!SOURCES.has(source)) throw new Error("Unknown KAI Eyes source.");
    if (!this.visible()) { this.stop(); throw stopped("KAI Eyes stopped because the companion is hidden."); }
    const grant = this.grants.get(source);
    if (!grant || grant.model !== model) throw stopped("That KAI Eyes permission ended. Turn the source on again.");
    let info;
    try { info = await this.modelInfo(model); }
    catch (error) { this.stop(source); throw error; }
    if (info.kind !== grant.info.kind || info.label !== grant.info.label) {
      this.stop(source);
      throw stopped("The selected brain changed. Turn KAI Eyes on again for the new destination.");
    }
    return { enabled: true, source, model, destination: info.kind, label: info.label };
  }

  async capture(model, detail = "context") {
    if (!Object.hasOwn(DETAIL, detail)) throw new Error("Unknown KAI Eyes capture detail.");
    await this.validate("screen", model);
    if (!this.desktopCapturer?.getSources) throw new Error("Screen vision is unavailable in this desktop build.");
    const window = this.getWindow(), bounds = window.getBounds();
    const point = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
    const display = this.screen.getDisplayNearestPoint(point);
    const preset = DETAIL[detail], thumbnailSize = fitSize(display.bounds.width, display.bounds.height, preset.dimension);
    const sources = await this.desktopCapturer.getSources({ types: ["screen"], thumbnailSize, fetchWindowIcons: false });
    const source = sources.find(item => String(item.display_id) === String(display.id));
    if (!source) throw new Error("KAI could not identify the screen he is sitting on. Move KAI to another display or allow screen recording, then try again.");
    if (!source?.thumbnail || source.thumbnail.isEmpty?.()) {
      throw new Error("KAI could not capture that screen. Allow screen recording in system settings, then try again.");
    }
    const bytes = source.thumbnail.toJPEG(preset.quality);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > preset.maxBytes) {
      throw new Error("The screen frame was too large to use safely. Try a lower display resolution.");
    }
    const size = source.thumbnail.getSize();
    return {
      source: "screen", detail, capturedAt: this.now(), width: size.width, height: size.height,
      dataUrl: "data:image/jpeg;base64," + bytes.toString("base64"),
    };
  }
}

module.exports = { MascotEyes, DETAIL, SOURCES, fitSize, stopped };
