"use strict";
const { parentPort, workerData } = require("worker_threads");
const port = parentPort || process.parentPort;
const modelDir = workerData?.modelDir || process.env.KAI_SPEECH_MODEL_DIR;
const runtime = workerData?.runtime || process.env.KAI_SPEECH_RUNTIME || "native";
let ready, primed = false;
async function engine() {
  if (!ready) ready = (async () => {
    require("./speech-wasm").installWasmRuntime({ wasm: runtime === "wasm" });
    const { KokoroTTS } = await import("kokoro-js");
    const { StyleTextToSpeech2Model, AutoTokenizer, env } = await import("@huggingface/transformers");
    env.allowRemoteModels = false;
    env.useBrowserCache = false;
    env.useFSCache = false;
    const [model, tokenizer] = await Promise.all([
      StyleTextToSpeech2Model.from_pretrained(modelDir, {
        dtype: "q8", device: "cpu", local_files_only: true,
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
      }),
      AutoTokenizer.from_pretrained(modelDir, { local_files_only: true }),
    ]);
    return new KokoroTTS(model, tokenizer);
  })();
  return ready;
}
port.on("message", async event => {
  const { id, text, voice } = parentPort ? event : event.data;
  try {
    const tts = await engine();
    if (!text) {
      // Loading weights alone leaves the phonemizer and first-run kernels cold.
      // Prime them on explicit setup/warm-up, never add work before real speech.
      // This audio is discarded, never played.
      if (!primed) await tts.generate("Hello, I'm Kai.", { voice: "af_bella", speed: 1.0 });
      primed = true;
      return port.postMessage({ id, ready: true });
    }
    const audio = await tts.generate(text, { voice, speed: 1.0 });
    primed = true;
    const samples = audio.audio;
    const wav = Buffer.alloc(44 + samples.length * 2);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(audio.sampling_rate, 24); wav.writeUInt32LE(audio.sampling_rate * 2, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
    wav.writeUInt32LE(samples.length * 2, 40);
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      wav.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), 44 + i * 2);
    }
    port.postMessage({ id, wav });
  } catch (error) { port.postMessage({ id, error: String(error.message || error) }); }
});
