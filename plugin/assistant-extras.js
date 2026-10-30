"use strict";

/* Compare, attachments, and scheduled tasks — loaded after app.js and
 * sharing its top-level scope ($, state, pickable, mdToHtml, sseDeltas,
 * addMsg, esc2, showView, …). */

// ---------- attachments (a text file as chat context) ----------

const ATTACH_CHAR_CAP = 24000; // ~6k tokens — leaves room in a 4k–8k ctx

function setAttachment(name, text) {
  let trimmed = false;
  if (text.length > ATTACH_CHAR_CAP) {
    text = text.slice(0, ATTACH_CHAR_CAP);
    trimmed = true;
  }
  state.attachment = { name, text, trimmed };
  KaiI18n.setText($("attach-name"), KaiI18n.message`📎 ${name}${trimmed ? " (trimmed to fit the model's context)" : ""}`);
  $("attach-chip-row").hidden = false;
}

function clearAttachment() {
  state.attachment = null;
  $("attach-chip-row").hidden = true;
}

// Images attach as vision input: downscaled client-side (≤1024px JPEG) so a
// phone photo doesn't become a 12 MB base64 blob in a 4k-token request.
function setImageAttachment(name, dataUri) {
  state.attachment = { kind: "image", name, dataUri };
  KaiI18n.setText($("attach-name"), KaiI18n.message`🖼️ ${name}`);
  $("attach-chip-row").hidden = false;
}

function readImageFile(file) {
  if (file.size > 20_000_000) {
    addMsg("error", "That image is over 20 MB — attach something smaller.");
    return;
  }
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);
    const MAX = 1024;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    setImageAttachment(file.name, canvas.toDataURL("image/jpeg", 0.85));
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    addMsg("error", `“${file.name}” doesn't look like an image this app can read.`);
  };
  img.src = url;
}

function readAttachFile(file) {
  if (!file) return;
  if (/^image\//.test(file.type || "")) return readImageFile(file);
  if (file.size > 1_000_000) {
    addMsg("error", "That file is over 1 MB — attach something smaller (text only).");
    return;
  }
  const r = new FileReader();
  r.onload = () => {
    const text = String(r.result || "");
    if (text.includes("\u0000")) {
      addMsg("error", `“${file.name}” looks binary — attachments are for text files (.txt, .md, code, .csv…).`);
      return;
    }
    setAttachment(file.name, text);
  };
  r.readAsText(file);
}

$("btn-attach").addEventListener("click", () => $("attach-input").click());
$("attach-input").addEventListener("change", () => {
  readAttachFile($("attach-input").files[0]);
  $("attach-input").value = "";
});
$("attach-remove").addEventListener("click", clearAttachment);

// Drag a file anywhere onto the window while in Chat.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (state.view !== "chat") return;
  readAttachFile(e.dataTransfer?.files?.[0]);
});

// ---- voice input: push-to-talk → local whisper → text in the composer ----
// Audio is recorded here, downsampled to 16 kHz WAV in this process, and
// POSTed to 127.0.0.1 only — it never leaves the machine (works the same in
// Local-Only mode). The mic button appears only when Core says voice can
// work here (already set up, or a pinned engine+model can be fetched).
(function voiceInput() {
  const btn = document.getElementById("btn-mic");
  const input = document.getElementById("input");
  if (!btn || !input || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return;

  let rec = null; // { recorder, chunks, stream, timer }
  let busy = false;
  let flashTimer = null;
  const basePlaceholder = input.placeholder;

  function flash(msg, sticky) {
    input.placeholder = msg;
    clearTimeout(flashTimer);
    if (!sticky) flashTimer = setTimeout(() => (input.placeholder = basePlaceholder), 5000);
  }

  async function voiceStatus() {
    try {
      const r = await fetch("/core/voice");
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  (async () => {
    const s = await voiceStatus();
    if (s && (s.available || s.installable)) btn.hidden = false;
  })();

  async function ensureSetup() {
    let s = await voiceStatus();
    if (!s) return false;
    if (s.available) return true;
    if (!s.installable) {
      flash("Voice input isn't available on this machine yet.");
      return false;
    }
    const mb = Math.max(1, Math.round((s.downloadBytes || 0) / 1e6));
    if (!confirm(`Set up voice input?\n\nOne-time download (~${mb} MB). After that, speech is transcribed entirely on this machine — audio never leaves it.`)) return false;
    await fetch("/core/voice/setup", { method: "POST" });
    btn.classList.add("busy");
    flash("Setting up voice input — downloading the speech engine…", true);
    try {
      for (let i = 0; i < 900; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        s = await voiceStatus();
        if (s?.available) {
          flash("Voice input ready — click the mic and speak.");
          return true;
        }
        if (s?.setup?.state === "error") {
          flash(`Voice setup failed: ${s.setup.error}`);
          return false;
        }
      }
      flash("Voice setup is taking unusually long — check your connection and try again.");
      return false;
    } finally {
      btn.classList.remove("busy");
    }
  }

  async function startRecording() {
    if (!(await ensureSetup())) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      flash("Microphone access was blocked — allow it in your system settings.");
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
    recorder.start();
    rec = { recorder, chunks, stream, timer: setTimeout(stopRecording, 180000) }; // 3 min cap
    btn.classList.add("recording");
    flash("Listening… click the mic again to stop.", true);
  }

  async function stopRecording() {
    if (!rec) return;
    const { recorder, chunks, stream, timer } = rec;
    rec = null;
    clearTimeout(timer);
    btn.classList.remove("recording");
    btn.classList.add("busy");
    busy = true;
    flash("Transcribing on this machine…", true);
    try {
      await new Promise((resolve) => {
        recorder.onstop = resolve;
        recorder.stop();
      });
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      const raw = await blob.arrayBuffer();
      // Decode via an offline context pinned at 16 kHz; browsers that ignore
      // the rate still get resampled by the encoder (inRate passthrough).
      const ctx = new OfflineAudioContext(1, 1, 16000);
      const audio = await ctx.decodeAudioData(raw);
      const wav = KaiWav.encodeWav16kMono(audio.getChannelData(0), audio.sampleRate);
      const r = await fetch("/core/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || `transcribe failed (${r.status})`);
      const text = (j.text || "").trim();
      if (!text) {
        flash("Didn't catch anything — try speaking closer to the mic.");
        return;
      }
      input.value = input.value ? `${input.value.replace(/\s+$/, "")} ${text}` : text;
      input.dispatchEvent(new Event("input", { bubbles: true })); // auto-grow hook
      input.focus();
      input.selectionStart = input.selectionEnd = input.value.length;
      flash(basePlaceholder);
    } catch (e) {
      flash(`Voice input failed: ${String(e.message || e).slice(0, 120)}`);
    } finally {
      busy = false;
      btn.classList.remove("busy");
    }
  }

  btn.addEventListener("click", () => {
    if (busy) return;
    if (rec) stopRecording();
    else startRecording();
  });
})();
