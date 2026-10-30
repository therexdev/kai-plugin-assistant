"use strict";
const path = require("path");
const { pathToFileURL } = require("url");

// Transformers 3 imports its native ONNX and image addons eagerly, even for
// speech. Redirect only those imports, only in the isolated compatibility
// worker. Keep the upstream tokenizer, phonemizer and Kokoro implementation.
// Sharing ORT Web's Tensor is essential: tensors from the native package have
// a different identity and can silently lose model inputs.
function installWasmRuntime({ wasm = true } = {}) {
  const adapter = pathToFileURL(path.join(__dirname, "speech-wasm-runtime.mjs")).href;
  const runtime = pathToFileURL(require.resolve("onnxruntime-web").replace(/app\.asar([/\\])/, "app.asar.unpacked$1")).href;
  require("module").registerHooks({
    resolve(specifier, context, nextResolve) {
      if (/\/transformers\.node\.mjs$/.test(context.parentURL || "")) {
        if (wasm && specifier === "onnxruntime-node") return { url: adapter, shortCircuit: true };
        if (wasm && specifier === "onnxruntime-common") return { url: runtime, shortCircuit: true };
        if (specifier === "sharp") return { url: "data:text/javascript,export default function(){throw new Error('Images are unavailable in the speech worker')}", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}
module.exports = { installWasmRuntime };
