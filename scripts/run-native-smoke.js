"use strict";
// Electron keeps Chromium profile handles open until its process exits on
// Windows. The parent owns the temporary profile and removes it after exit.
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), { spawn } = require("node:child_process");
async function runNativeSmoke({ electronBinary = process.env.KAI_ASSISTANT_ELECTRON || require("electron"), electronArgs = [], entry = path.join(__dirname, "native-smoke.js"), timeoutMs = 180000 } = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "kai-assistant-native-"));
  const env = { ...process.env, KAI_ASSISTANT_SMOKE_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  let childError, result, cleanupError;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(electronBinary, [...electronArgs, entry], { env, stdio: "inherit", windowsHide: true, shell: false });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs); timer.unref?.();
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut }); });
    });
  } catch (error) { childError = error; }
  finally {
    try { await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
    catch (error) { cleanupError = new Error(`Native smoke profile cleanup failed after Electron exited: ${profile}`, { cause: error }); }
  }
  if (childError && cleanupError) throw new AggregateError([childError, cleanupError], "Native smoke launch and cleanup failed");
  if (childError) throw childError;
  if (cleanupError) throw cleanupError;
  if (result.timedOut) throw Error("Native smoke timed out; Electron was terminated and its temporary profile removed");
  if (result.signal) throw Error(`Native smoke exited with signal ${result.signal}`);
  return result.code ?? 1;
}
if (require.main === module) runNativeSmoke({ electronArgs: process.argv.slice(2) }).then(code => { process.exitCode = code; }, error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { runNativeSmoke };
