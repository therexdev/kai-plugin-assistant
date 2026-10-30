"use strict";
// Native inference lives in a disposable process in Electron, never in Core.
const port = process.parentPort || { postMessage: value => process.send(value), on: (name, fn) => process.on(name, fn) };
const path = require("path");
const dir = process.env.KAI_POCKET_DIR;
let engine, sherpa, primed = new Set();
function send(message) { port.postMessage(message); }
async function load() {
  if (engine) return engine;
  if (process.platform === "win32") {
    const native = path.join(path.dirname(require.resolve("sherpa-onnx-win-x64/package.json")), "sherpa-onnx.node").replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
    require("../core/lib/runtimes/llamacpp").ensureCrtBeside(native);
  }
  sherpa = require("sherpa-onnx-node");
  const file = name => path.join(dir, name);
  engine = await sherpa.OfflineTts.createAsync({ model: {
    pocket: { lmFlow: file("lm_flow.int8.onnx"), lmMain: file("lm_main.int8.onnx"), encoder: file("encoder.onnx"),
      decoder: file("decoder.int8.onnx"), textConditioner: file("text_conditioner.onnx"), vocabJson: file("vocab.json"),
      tokenScoresJson: file("token_scores.json"), voiceEmbeddingCacheCapacity: 4 },
    numThreads: 2, provider: "cpu", debug: false,
  }, maxNumSentences: 1 });
  return engine;
}
port.on("message", async event => {
  const request = process.parentPort ? event.data : event;
  const { id, voice, text } = request;
  const start = performance.now(), cpu = process.cpuUsage();
  try {
    const tts = await load();
    if (!text && primed.has(voice)) return send({ id, done: true });
    const ref = sherpa.readWave(path.join(dir, voice + ".wav"), false);
    let firstMs = null, count = 0, seq = 0;
    const audio = await tts.generateAsync({ text: text || "Hi.", enableExternalBuffer: false,
      generationConfig: new sherpa.GenerationConfig({ speed: 1, referenceAudio: ref.samples, referenceSampleRate: ref.sampleRate,
        numSteps: 5, extra: { max_reference_audio_len: 10, seed: 42, chunk_size: 3 } }),
      onProgress: ({ samples }) => {
        if (!text || !samples.length) return 1;
        if (firstMs === null) firstMs = performance.now() - start;
        count += samples.length;
        if (count > tts.sampleRate * 120) throw new Error("Pocket voice exceeded its audio limit.");
        // Electron forbids external V8 buffers. Request owned buffers, then
        // copy the callback samples before handing them to another process.
        send({ id, seq: seq++, rate: tts.sampleRate, samples: new Float32Array(samples) });
        return 1;
      },
    });
    primed.add(voice);
    const used = process.cpuUsage(cpu);
    send({ id, done: true, stats: { firstMs, totalMs: performance.now() - start,
      audioSeconds: audio.samples.length / audio.sampleRate, chunks: seq, cpuMs: (used.user + used.system) / 1000 } });
  } catch (error) { send({ id, error: "Pocket voice could not speak: " + error.message }); }
});
