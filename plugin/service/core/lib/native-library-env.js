"use strict";
const fs = require("node:fs"), path = require("node:path");
const CRT_DLLS = Object.freeze(["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"]);

// Pass this environment to the isolated native worker before it starts. Node's
// Windows addon loader uses LOAD_WITH_ALTERED_SEARCH_PATH, which includes PATH
// after the system directories. Keep Electron's existing CRT available when the
// system redist is absent, without copying anything into signed plugin code.
// This returns a copy; the Core process's environment is never changed.
function nativeLibraryEnv({ env = process.env, platform = process.platform, execPath = process.execPath,
  exists = file => { try { return fs.statSync(file).isFile(); } catch { return false; } } } = {}) {
  const result = { ...env };
  if (platform !== "win32") return result;
  const keys = Object.keys(env), value = name => env[keys.find(key => key.toLowerCase() === name.toLowerCase())];
  const systemRoot = value("SystemRoot") || "C:\\Windows", paths = [];
  const add = directory => {
    if (!path.win32.isAbsolute(directory) || /[;\0\r\n]/.test(directory) || !CRT_DLLS.some(dll => exists(path.win32.join(directory, dll)))) return;
    if (!paths.some(previous => previous.toLowerCase() === directory.toLowerCase())) paths.push(directory);
  };
  add(path.win32.join(systemRoot, "System32"));
  add(path.win32.dirname(execPath));
  if (!paths.length) return result; // Let the native loader report unavailable dependencies.
  const pathKeys = keys.filter(key => key.toLowerCase() === "path"), pathKey = pathKeys[0] || "PATH";
  for (const key of pathKeys) delete result[key];
  const previous = value("PATH");
  result[pathKey] = [...paths, ...(previous ? [previous] : [])].join(";");
  return result;
}
module.exports = { CRT_DLLS, nativeLibraryEnv };
