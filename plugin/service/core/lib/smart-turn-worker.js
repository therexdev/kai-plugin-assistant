"use strict";

const path = require("path");
const { parentPort, workerData } = require("worker_threads");

const port = parentPort || process.parentPort;
const modelPath = workerData?.modelPath || process.env.KAI_SMART_TURN_MODEL;
const SAMPLE_RATE = 16000;
const WINDOW_SAMPLES = SAMPLE_RATE * 8;
const FEATURE_CONFIG = {
  chunk_length: 8,
  feature_size: 80,
  hop_length: 160,
  n_fft: 400,
  n_samples: WINDOW_SAMPLES,
  nb_max_frames: 800,
  padding_side: "right",
  padding_value: 0,
  return_attention_mask: false,
  sampling_rate: SAMPLE_RATE,
};

let ready = null;

async function engine() {
  if (!ready) ready = (async () => {
    if (!modelPath) throw new Error("Smart-Turn model path is missing.");
    if (process.platform === "win32") {
      const runtime = path.join(path.dirname(require.resolve("onnxruntime-node")), "../bin/napi-v3/win32", process.arch, "onnxruntime_binding.node");
      require("./runtimes/llamacpp").ensureCrtBeside(runtime.replace(/app\.asar([/\\])/, "app.asar.unpacked$1"));
    }
    require("./speech-wasm").installWasmRuntime({ wasm: false });
    const ort = require("onnxruntime-node");
    const { WhisperFeatureExtractor, env } = await import("@huggingface/transformers");
    env.allowRemoteModels = false;
    env.useBrowserCache = false;
    const extractor = new WhisperFeatureExtractor(FEATURE_CONFIG);
    const session = await ort.InferenceSession.create(modelPath, {
      executionMode: "sequential",
      graphOptimizationLevel: "all",
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    });
    return { ort, extractor, session };
  })();
  return ready;
}

function normalizeWindow(value) {
  const source = value instanceof Float32Array ? value : Float32Array.from(value || []);
  const audio = new Float32Array(WINDOW_SAMPLES);
  if (source.length >= WINDOW_SAMPLES) audio.set(source.subarray(source.length - WINDOW_SAMPLES));
  else audio.set(source, WINDOW_SAMPLES - source.length);

  let mean = 0;
  for (let i = 0; i < audio.length; i++) mean += audio[i];
  mean /= audio.length;
  let variance = 0;
  for (let i = 0; i < audio.length; i++) {
    const delta = audio[i] - mean;
    variance += delta * delta;
  }
  const scale = 1 / Math.sqrt(variance / audio.length + 1e-7);
  for (let i = 0; i < audio.length; i++) audio[i] = (audio[i] - mean) * scale;
  return audio;
}

async function analyze(value) {
  const startedAt = performance.now();
  const { ort, extractor, session } = await engine();
  const audio = normalizeWindow(value);
  const features = await extractor(audio, { max_length: WINDOW_SAMPLES });
  const data = features.input_features.data;
  if (data.length !== 80 * 800) throw new Error(`Smart-Turn feature shape was ${features.input_features.dims.join("x")}, expected 1x80x800.`);
  const result = await session.run({ input_features: new ort.Tensor("float32", data, [1, 80, 800]) });
  const probability = Number(result.logits?.data?.[0]);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("Smart-Turn returned an invalid completion probability.");
  return { probability, ms: performance.now() - startedAt };
}

port.on("message", async event => {
  const message = parentPort ? event : event.data;
  try {
    if (message.type === "warm") {
      await analyze(new Float32Array(SAMPLE_RATE));
      port.postMessage({ id: message.id, ready: true });
    } else if (message.type === "analyze") {
      const result = await analyze(message.audio);
      port.postMessage({ id: message.id, ...result });
    } else if (message.type === "dispose") {
      const current = await ready?.catch(() => null);
      await current?.session?.release?.().catch(() => {});
      ready = null;
      port.close?.();
    }
  } catch (error) {
    port.postMessage({ id: message?.id, error: String(error.message || error) });
  }
});

module.exports = { normalizeWindow, FEATURE_CONFIG, WINDOW_SAMPLES };
