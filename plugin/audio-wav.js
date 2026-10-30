/*
 * Float32 PCM → 16 kHz mono 16-bit WAV, in plain JS. The renderer records
 * with whatever sample rate the OS gives (44.1k/48k), decodes to Float32,
 * and this produces the exact container whisper.cpp wants — no ffmpeg, no
 * native deps, audio never leaves the process until the local POST.
 *
 * Dual-mode file (same pattern as ui/markdown.js): browser script exposing
 * window.KaiWav, node module for the test suite.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KaiWav = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TARGET_RATE = 16000;

  /** Linear-interpolation resample. Good enough for speech→STT (whisper
   *  itself is robust to far worse); avoids shipping a DSP library. */
  function resample(float32, fromRate, toRate) {
    if (fromRate === toRate) return float32;
    var outLen = Math.max(1, Math.round((float32.length * toRate) / fromRate));
    var out = new Float32Array(outLen);
    var step = (float32.length - 1) / Math.max(1, outLen - 1);
    for (var i = 0; i < outLen; i++) {
      var pos = i * step;
      var lo = Math.floor(pos);
      var hi = Math.min(lo + 1, float32.length - 1);
      var frac = pos - lo;
      out[i] = float32[lo] * (1 - frac) + float32[hi] * frac;
    }
    return out;
  }

  /** Encode mono Float32 samples at inRate into a 16 kHz 16-bit WAV. */
  function encodeWav16kMono(float32, inRate) {
    var pcm = resample(float32, inRate || TARGET_RATE, TARGET_RATE);
    var buf = new ArrayBuffer(44 + pcm.length * 2);
    var v = new DataView(buf);
    function str(off, s) {
      for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    }
    str(0, "RIFF");
    v.setUint32(4, 36 + pcm.length * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true); // fmt chunk size
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, TARGET_RATE, true);
    v.setUint32(28, TARGET_RATE * 2, true); // byte rate
    v.setUint16(32, 2, true); // block align
    v.setUint16(34, 16, true); // bits/sample
    str(36, "data");
    v.setUint32(40, pcm.length * 2, true);
    for (var j = 0; j < pcm.length; j++) {
      var s = Math.max(-1, Math.min(1, pcm[j]));
      v.setInt16(44 + j * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  return { encodeWav16kMono: encodeWav16kMono, resample: resample, TARGET_RATE: TARGET_RATE };
});
