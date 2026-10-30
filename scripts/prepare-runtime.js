"use strict";
// Author/CI build step only. The installed plugin never runs npm or this script.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib");
const root = path.resolve(__dirname, ".."), args = process.argv.slice(2), option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const source = path.resolve(option("--deps", root)), output = path.resolve(option("--output", path.join(root, ".build/plugin"))), offline = args.includes("--offline"), universal = !args.includes("--current-platform");
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"))), manifest = require("../plugin/manifest.json");
const hashes = {}, visited = new Set(), cache = path.join(root, ".build/dependency-cache");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function put(relative, bytes) { const target = path.join(output, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); hashes[relative.replaceAll(path.sep, "/")] = digest(bytes); }
function copyTree(directory, prefix, filter = () => true) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { if (entry.isSymbolicLink()) throw Error("Build sources cannot contain symbolic links"); const absolute = path.join(directory, entry.name), relative = prefix ? prefix + "/" + entry.name : entry.name; if (entry.isDirectory()) { if (filter(relative, true)) copyTree(absolute, relative, filter); } else if (entry.isFile() && filter(relative, false)) { const name = /(?:^|\/)(?:LICENSE|LICENCE|COPYING|NOTICE)$/i.test(relative) ? relative + ".txt" : relative; put(name, fs.readFileSync(absolute)); } } }
function runtimeFile(relative, directory) {
  if (/(?:^|\/)(?:test|tests|__tests__|examples|docs|types|\.github|\.bin|script|scripts)(?:\/|$)/.test(relative)) return false;
  const native = /node_modules\/onnxruntime-node\/bin\/napi-v3\/([^/]+)\/([^/]+)/.exec(relative);
  if (native && !(universal ? ["linux-x64", "win32-x64", "darwin-x64", "darwin-arm64"] : [process.platform + "-" + process.arch]).includes(native[1] + "-" + native[2])) return false;
  if (directory) return true;
  if (/\.(?:map|d\.ts|ts|tsx)$/.test(relative) || /(?:^|\/)(?:package-lock|yarn-lock)\./.test(relative)) return false;
  if (/node_modules\/sharp\//.test(relative) || /node_modules\/@img\//.test(relative)) return false;
  if (/node_modules\/@huggingface\/transformers\/(?:src|types)\//.test(relative)) return false;
  if (/node_modules\/@huggingface\/transformers\/dist\//.test(relative) && !/transformers\.node\.(?:mjs|cjs)$/.test(relative)) return false;
  if (/node_modules\/onnxruntime-web\/dist\//.test(relative) && !/(?:ort\.node\.min\.(?:js|mjs)|ort\.wasm(?:\.min)?\.(?:js|mjs)|ort\.min\.(?:js|mjs)|ort-wasm-simd-threaded\.(?:mjs|wasm))$/.test(relative)) return false;
  return /\.(?:js|cjs|mjs|json|txt|wasm|node|onnx|bin|exe|dll|so(?:\.\d+)*|dylib|dat)$/i.test(relative) || /(?:^|\/)(?:LICENSE|LICENCE|COPYING|NOTICE)$/i.test(relative);
}
function dependencyPath(name, parent = source) {
  let current = parent;
  while (true) { const probe = path.join(current, "node_modules", ...name.split("/")); if (fs.existsSync(path.join(probe, "package.json"))) return probe; const next = path.dirname(current); if (next === current) break; current = next; }
  throw Error("Missing build dependency: " + name + ". Run npm ci --ignore-scripts first.");
}
function copyDependency(name, parent = source, destination = "service/node_modules/" + name) {
  if (name === "sharp" || name.startsWith("@img/")) return;
  const directory = dependencyPath(name, parent), key = directory + "|" + destination; if (visited.has(key)) return; visited.add(key);
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "package.json"))), rootEntry = lock.packages["node_modules/" + name];
  const relative = path.relative(source, directory).replaceAll(path.sep, "/"), expected = lock.packages[relative] || rootEntry;
  if (!expected || expected.version !== metadata.version) throw Error("Dependency differs from lockfile: " + name + "@" + metadata.version);
  copyTree(directory, destination, runtimeFile);
  for (const dep of Object.keys(metadata.dependencies || {})) {
    if (name === "onnxruntime-node" && ["tar", "global-agent"].includes(dep)) continue; // installation utilities are never shipped or run.
    const resolved = dependencyPath(dep, directory), top = (() => { try { return dependencyPath(dep); } catch { return null; } })();
    const nested = resolved === top ? "service/node_modules/" + dep : destination + "/node_modules/" + dep;
    copyDependency(dep, directory, nested);
  }
}
async function pinned(url, integrity, target) {
  const [algorithm, encoded] = integrity.split("-"), check = bytes => crypto.createHash(algorithm).update(bytes).digest("base64") === encoded;
  if (fs.existsSync(target)) { const bytes = fs.readFileSync(target); if (check(bytes)) return bytes; throw Error("Cached dependency failed its integrity check: " + target); }
  if (offline) throw Error("Missing offline build asset: " + target);
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) }); if (!response.ok) throw Error("Build download failed: " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer()); if (!check(bytes)) throw Error("Build dependency integrity mismatch: " + url);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: "wx" }); return bytes;
}
function unpackTarGz(bytes, prefix) {
  const tar = zlib.gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }); let at = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512); if (header.every(x => x === 0)) break;
    const str = (start, size) => header.subarray(start, start + size).toString().split("\0")[0];
    const longPrefix = str(345, 155), name = (longPrefix ? longPrefix + "/" : "") + str(0, 100), type = str(156, 1) || "0", size = parseInt(str(124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || at + 512 + size > tar.length || !name.startsWith("package/") || name.split("/").some(p => p === ".." || p.includes("\\"))) throw Error("Unsafe npm archive");
    const relative = name.slice(8); if (!["0", "5"].includes(type)) throw Error("Unsupported npm archive entry (links and scripts are never executed)");
    if (type === "0" && relative && runtimeFile(prefix + "/" + relative, false)) put(prefix + "/" + (/^(LICENSE|LICENCE|COPYING|NOTICE)$/i.test(relative) ? relative + ".txt" : relative), tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
}
async function main() {
  if (output === root || output === path.join(root, "plugin") || !output.includes(path.sep)) throw Error("Use a separate build output directory");
  fs.rmSync(output, { recursive: true, force: true }); copyTree(path.join(root, "plugin"), "");
  for (const name of ["@huggingface/transformers", "kokoro-js", "phonemizer", "onnxruntime-node", "onnxruntime-web", "sherpa-onnx-node"]) copyDependency(name);
  const native = universal ? ["sherpa-onnx-linux-x64", "sherpa-onnx-win-x64", "sherpa-onnx-darwin-x64", "sherpa-onnx-darwin-arm64"] : ["sherpa-onnx-" + (process.platform === "win32" ? "win" : process.platform) + "-" + process.arch];
  for (const name of native) {
    let local; try { local = dependencyPath(name); } catch {}
    if (local) copyDependency(name);
    else { const entry = lock.packages["node_modules/" + name]; if (!entry?.integrity || !entry.resolved?.startsWith("https://registry.npmjs.org/")) throw Error("Missing locked native payload " + name); unpackTarGz(await pinned(entry.resolved, entry.integrity, path.join(cache, name + ".tgz")), "service/node_modules/" + name); }
  }
  const vad = path.join(dependencyPath("@ricky0123/vad-web"), "dist"), ort = path.join(dependencyPath("onnxruntime-web"), "dist");
  for (const name of ["bundle.min.js", "vad.worklet.bundle.min.js", "silero_vad_v5.onnx"]) put("service/resources/live-senses/vad/" + name, fs.readFileSync(path.join(vad, name)));
  for (const name of ["ort.wasm.min.js", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) put("service/resources/live-senses/vad/" + name, fs.readFileSync(path.join(ort, name)));
  const turn = require("../plugin/service/core/runtimes/smart-turn.json").file;
  const previous = path.join(source, "node_modules/.cache/kai-live-senses/turn", turn.path), target = fs.existsSync(previous) ? previous : path.join(cache, turn.path);
  const turnBytes = await pinned(turn.url, "sha256-" + Buffer.from(turn.sha256, "hex").toString("base64"), target);
  if (turnBytes.length !== turn.sizeBytes) throw Error("Unexpected turn model size"); put("service/resources/live-senses/turn/" + turn.path, turnBytes);
  const helpers = option("--windows-helpers", path.join(root, ".build/windows-helpers"));
  for (const name of ["kai-windows-voice.exe", "kai-computer.exe"]) { const file = path.join(helpers, name); if (!fs.existsSync(file)) { if (universal) throw Error("Build the Windows helpers before assembling the universal package: " + name); } else put("service/build/bin/" + name, fs.readFileSync(file)); }
  const record = { schema: 1, plugin: manifest.id, version: manifest.version, universal, sourceCommit: process.env.GITHUB_SHA || null, lockDigest: digest(fs.readFileSync(path.join(root, "package-lock.json"))), files: Object.fromEntries(Object.entries(hashes).sort(([a],[b]) => a.localeCompare(b))) };
  fs.writeFileSync(path.join(path.dirname(output), "runtime-build.json"), JSON.stringify(record, null, 2) + "\n");
  const bytes = Object.keys(hashes).reduce((n, name) => n + fs.statSync(path.join(output, name)).size, 0); console.log(`Built ${manifest.id}@${manifest.version}: ${Object.keys(hashes).length} files, ${(bytes / 1048576).toFixed(1)} MiB (${universal ? "universal" : process.platform + "-" + process.arch}).`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { runtimeFile, unpackTarGz };
