"use strict";
const fs = require("fs"), path = require("path"), { spawn } = require("child_process");
class NativeComputer {
  constructor({ executable = path.join(__dirname, "../build/bin/kai-computer.exe"), spawnImpl = spawn, exists = fs.existsSync, platform = process.platform } = {}) {
    Object.assign(this, { executable, spawn: spawnImpl, exists, platform }); this.serial = 0;
  }
  available() { return this.platform === "win32" && this.exists(this.executable); }
  request(value) {
    if (!this.available()) return Promise.reject(new Error("Desktop control requires the installed Windows app."));
    if (this.pending) return Promise.reject(new Error("A desktop action is already running."));
    return new Promise((resolve, reject) => {
      const id = ++this.serial, timer = setTimeout(() => this.cancel(Object.assign(new Error("That window did not respond. No further desktop action will run."), { code: "NATIVE_TIMEOUT" })), 12000);
      this.pending = { id, resolve, reject, timer };
      if (!this.worker) {
        let worker;
        try { worker = this.worker = this.spawn(this.executable, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }); }
        catch { this.cancel(new Error("KAI's desktop helper could not start.")); return; }
        let buffer = ""; worker.stdout.setEncoding("utf8");
        worker.stdout.on("data", chunk => {
          if (worker !== this.worker) return;
          buffer += chunk; if (buffer.length > 8 * 1024 * 1024) return this.cancel(new Error("The desktop view was too large."));
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); let response;
            try { response = JSON.parse(line); } catch { this.cancel(new Error("The desktop helper returned an invalid response.")); return; }
            if (response.id !== this.pending?.id) continue;
            const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
            response.error ? pending.reject(new Error(String(response.error).slice(0, 350))) : pending.resolve(response.result);
          }
        });
        const failed = () => { if (worker === this.worker) this.cancel(new Error("The desktop helper stopped. Ask KAI again to start a new task.")); };
        worker.on("error", failed); worker.on("exit", failed); worker.stdin.on("error", failed);
      }
      this.worker.stdin.write(JSON.stringify({ ...value, id, ignorePid: process.pid }) + "\n");
    });
  }
  cancel(error = Object.assign(new Error("Desktop control stopped."), { name: "AbortError" })) {
    const pending = this.pending; this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    const worker = this.worker; this.worker = null; worker?.kill();
  }
}
module.exports = { NativeComputer };
