"use strict";
const fs = require("node:fs"), path = require("node:path");
const smartTurn = require("../runtimes/smart-turn.json");
const ROUTES = Object.freeze({
  "/live-senses/vad/ort.min.js": "ort.wasm.min.js",
  "/live-senses/vad/ort-wasm-simd-threaded.mjs": "ort-wasm-simd-threaded.mjs",
  "/live-senses/vad/ort-wasm-simd-threaded.wasm": "ort-wasm-simd-threaded.wasm",
  "/live-senses/vad/bundle.min.js": "bundle.min.js",
  "/live-senses/vad/vad.worklet.bundle.min.js": "vad.worklet.bundle.min.js",
  "/live-senses/vad/silero_vad_v5.onnx": "silero_vad_v5.onnx",
});
const root = path.join(__dirname, "../../resources/live-senses");
function liveSensesAssets() { return new Map(Object.entries(ROUTES).map(([route, file]) => [route, path.join(root, "vad", file)]).filter(([,file]) => fs.existsSync(file))); }
function smartTurnModelPath() { return path.join(root, "turn", smartTurn.file.path); }
module.exports = { ROUTES, liveSensesAssets, smartTurnModelPath };
