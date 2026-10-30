import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
// Resolve outside ASAR: Emscripten reads the adjacent WASM binary directly.
const entry = require.resolve("onnxruntime-web").replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
const ort = await import(pathToFileURL(entry).href);
export const Tensor = ort.Tensor;
export const env = ort.env;
env.wasm.numThreads = 1;
env.wasm.proxy = false;
env.wasm.wasmPaths = pathToFileURL(path.dirname(entry) + path.sep).href;
export const InferenceSession = {
  create(model, options) {
    // Transformers uses its Node file loader and CPU device. The compatible
    // implementation runs that same quantized model on the WASM CPU backend.
    return ort.InferenceSession.create(model, { ...options, executionProviders: ["wasm"] });
  },
};
