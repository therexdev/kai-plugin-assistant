"use strict";
const path = require("path"), fs = require("fs"), { spawn } = require("child_process");
// Windows emits RIFF with extra fmt/LIST chunks. Normalize it before KAI's
// existing PCM effects; never assume data starts at byte 44.
function normalizeWav(input) {
  const wav = Buffer.from(input);
  if (wav.length < 44 || wav.length > 8 * 1024 * 1024 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("Windows returned invalid voice audio.");
  if (wav.readUInt32LE(4) + 8 !== wav.length) throw new Error("Windows voice audio was incomplete.");
  let format, data;
  for (let at = 12; at + 8 <= wav.length;) {
    const size = wav.readUInt32LE(at + 4), end = at + 8 + size;
    if (end > wav.length) throw new Error("Windows voice audio was incomplete.");
    const tag = wav.toString("ascii", at, at + 4);
    if (tag === "fmt ") format = wav.subarray(at + 8, end);
    if (tag === "data") data = wav.subarray(at + 8, end);
    at = end + (size % 2);
  }
  if (!format || format.length < 16 || !data) throw new Error("Windows returned an unsupported audio format.");
  if (!data.length) throw Object.assign(new Error("The selected Windows voice could not pronounce this text. Choose a voice for the reply's language in Voice & listening."), { code: "WINDOWS_VOICE_EMPTY" });
  let encoding = format.readUInt16LE(0);
  // WAVE_FORMAT_EXTENSIBLE can describe the same 16-bit PCM with a GUID.
  // Check the complete subtype, not just its first two bytes.
  if (encoding === 0xfffe && format.length >= 40 && format.readUInt16LE(16) >= 22 &&
      format.readUInt16LE(18) === 16 && format.subarray(24, 40).equals(Buffer.from("0100000000001000800000aa00389b71", "hex"))) encoding = 1;
  if (encoding !== 1 || format.readUInt16LE(14) !== 16) throw new Error("Windows returned an unsupported audio format. Choose another installed voice in Voice & listening.");
  const channels = format.readUInt16LE(2), rate = format.readUInt32LE(4);
  if (![1, 2].includes(channels) || rate < 8000 || rate > 48000 || data.length % (2 * channels)) throw new Error("Windows returned an unsupported audio format.");
  const count = data.length / (2 * channels), out = Buffer.alloc(44 + count * 2);
  out.write("RIFF"); out.writeUInt32LE(out.length - 8, 4); out.write("WAVEfmt ", 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) out.writeInt16LE(channels === 1 ? data.readInt16LE(i * 2) : Math.round((data.readInt16LE(i * 4) + data.readInt16LE(i * 4 + 2)) / 2), 44 + i * 2);
  return out;
}
function selectWindowsVoice(text, requested, voices) {
  const selected = voices.find(v => v.id === requested);
  if (!selected) throw new Error("That Windows voice is unavailable. Refresh voices in Voice & listening.");
  // Hangul identifies Korean unambiguously. English Windows voices can return
  // an empty WAV for it; this is a language mismatch, not a broken audio codec.
  // Match only an already installed voice within the user's Windows engine.
  if (/\p{Script=Hangul}/u.test(text) && !/^ko(?:[-_]|$)/i.test(selected.lang)) {
    const korean = voices.find(v => /^ko(?:[-_]|$)/i.test(v.lang));
    if (!korean) throw new Error("Korean speech needs a Korean Windows voice. In Voice & listening, choose Add Windows voices, install Korean speech, then Refresh voices.");
    return korean;
  }
  return selected;
}
class WindowsVoice {
  constructor({ platform = process.platform, spawnImpl = spawn, executable = path.join(__dirname, "../build/bin/kai-windows-voice.exe"), exists = fs.existsSync } = {}) {
    Object.assign(this, { platform, spawn: spawnImpl, executable, exists }); this.serial = 0; this.voices = []; this.closed = false;
  }
  async status(refresh = false) {
    if (this.closed || this.platform !== "win32" || !this.exists(this.executable)) return { supported: this.platform === "win32", available: false, voices: [] };
    if (this.loading) return this.loading;
    if (this.worker && this.voices.length && (!refresh || this.pending)) { this.lease(); return { supported: true, available: true, voices: this.voices }; }
    this.loading = this.request({ op: "status" }).then(value => {
      this.voices = (Array.isArray(value.voices) ? value.voices : []).filter(v => v && ["id", "name", "lang"].every(k => typeof v[k] === "string") && v.id.length <= 2048).slice(0, 100).map(({ id, name, lang }) => ({ id, name: name.slice(0, 200), lang: lang.slice(0, 40) }));
      return { supported: true, available: !!this.voices.length, voices: this.voices };
    }).finally(() => { this.loading = null; });
    return this.loading;
  }
  async generate({ text, voice } = {}) {
    if (typeof text !== "string" || !text.trim() || text.length > 1200) throw new Error("Speak one sentence at a time.");
    const status = await this.status();
    const selected = selectWindowsVoice(text, voice, status.voices);
    const value = await this.request({ op: "speak", text, voice: selected.id });
    if (typeof value.wav !== "string" || value.wav.length > 12 * 1024 * 1024) throw new Error("Windows returned invalid voice audio.");
    return normalizeWav(Buffer.from(value.wav, "base64"));
  }
  lease() { clearTimeout(this.idle); if (!this.pending) { this.idle = setTimeout(() => this.cancel(), 120000); this.idle.unref?.(); } }
  request(value) {
    if (this.closed || this.platform !== "win32") return Promise.reject(new Error("Windows voices are unavailable."));
    if (this.pending) return Promise.reject(new Error("Windows voice is busy. Please try again."));
    clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => this.cancel(new Error("Windows voice took too long. Try another voice or refresh voices.")), 30000);
      this.pending = { id, resolve, reject, timer };
      if (!this.worker) {
        let worker;
        try { worker = this.worker = this.spawn(this.executable, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], shell: false }); }
        catch { this.cancel(new Error("Windows voice could not start. Refresh voices or choose another engine.")); return; }
        let text = ""; worker.stdout.setEncoding("utf8");
        worker.stdout.on("data", chunk => {
          if (worker !== this.worker) return;
          text += chunk;
          if (text.length > 12 * 1024 * 1024) { this.cancel(new Error("Windows voice response is too large.")); return; }
          let end;
          while ((end = text.indexOf("\n")) >= 0) {
            const line = text.slice(0, end).trim(); text = text.slice(end + 1);
            let response; try { response = JSON.parse(line); } catch { this.cancel(new Error("Windows voice returned an invalid response.")); return; }
            if (!this.pending || response.id !== this.pending.id) continue;
            const pending = this.pending; this.pending = null; clearTimeout(pending.timer); this.lease();
            response.error ? pending.reject(new Error(String(response.error).slice(0, 300))) : pending.resolve(response);
          }
        });
        const failed = () => { if (this.worker === worker) this.cancel(new Error("Windows voice stopped unexpectedly. Please try again.")); };
        worker.on("error", failed); worker.on("exit", failed); worker.stdin.on("error", failed);
      }
      this.worker.stdin.write(JSON.stringify({ ...value, id }) + "\n");
    });
  }
  cancel(error = new Error("Windows speech cancelled.")) {
    clearTimeout(this.idle); const pending = this.pending; this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    const worker = this.worker; this.worker = null; worker?.kill();
  }
  close() { this.closed = true; this.cancel(); }
}
module.exports = { WindowsVoice, normalizeWav, selectWindowsVoice };
