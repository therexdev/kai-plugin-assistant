"use strict";
const path = require("node:path"), crypto = require("node:crypto"), fs = require("node:fs"), http = require("node:http");
const { searchWeb, fetchPage } = require("./core/lib/websearch");
const MAX_REQUEST = 16 * 1024 * 1024, MAX_STREAM = 8 * 1024 * 1024;
const REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".wasm": "application/wasm", ".onnx": "application/octet-stream" };
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { "content-type": "application/json" }, body });
function normalize(input) {
  if (!input || typeof input !== "object" || typeof input.path !== "string" || input.path.length > 4000 || !input.path.startsWith("/core/") || /[\\\u0000-\u0020#]/.test(input.path)) throw Error("Invalid Assistant request");
  const url = new URL(input.path, "http://127.0.0.1");
  if (url.origin !== "http://127.0.0.1" || url.pathname !== input.path.split("?")[0] || /%2f|%5c|%2e|%00/i.test(input.path)) throw Error("Invalid Assistant request path");
  const method = String(input.method || "GET").toUpperCase(); if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) throw Error("Unsupported request method");
  if (input.bodyBase64 !== undefined && (input.body !== undefined || method !== "POST" || !["/core/transcribe", "/core/turn", "/core/voice/transcribe"].includes(url.pathname))) throw Error("Unexpected binary request");
  if (input.bodyBase64 !== undefined && (typeof input.bodyBase64 !== "string" || Buffer.from(input.bodyBase64, "base64").toString("base64") !== input.bodyBase64)) throw Error("Invalid encoded audio");
  const bytes = input.bodyBase64 !== undefined ? Buffer.from(input.bodyBase64, "base64") : Buffer.from(typeof input.body === "string" ? input.body : JSON.stringify(input.body ?? {}));
  if (bytes.length > MAX_REQUEST) throw Error("Assistant request is too large");
  let body = {}; if (input.body !== undefined) { body = typeof input.body === "string" ? JSON.parse(input.body) : structuredClone(input.body); if (!body || typeof body !== "object" || Array.isArray(body)) throw Error("Expected a JSON object"); }
  return { url, method, bytes, body };
}
function createRuntime(api, electron) {
  const streams = new Map(), requests = new Map(), cancelled = new Map(), staticAssets = new Map(), controllers = new Set(); let stopped = false, server, port, starting, voice, speech, turn, clientRequest;
  const secret = crypto.randomBytes(32).toString("hex");
  const mascotSession = electron.session.fromPartition("kai-assistant-" + crypto.randomUUID());
  mascotSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false)); mascotSession.setPermissionCheckHandler(() => false);
  mascotSession.on("will-download", event => event.preventDefault());
  mascotSession.webRequest.onBeforeRequest((details, cb) => { let allowed = false; try { const u = new URL(details.url); allowed = u.origin === origin() || u.protocol === "blob:" && u.pathname.startsWith(origin() + "/"); } catch {} cb({ cancel: !allowed }); });
  mascotSession.webRequest.onBeforeSendHeaders((details, cb) => { const headers = { ...details.requestHeaders }; if (details.url.startsWith(origin() + "/")) headers["X-KAI-Assistant-Token"] = secret; cb({ requestHeaders: headers }); });
  const origin = () => `http://127.0.0.1:${port}`;
  function active(signal) { if (stopped || api.signal.aborted) throw Error("Assistant is closing"); signal?.throwIfAborted(); }
  function engines() {
    if (voice) return;
    const catalogPath = path.join(__dirname, "core/runtimes/catalog.json");
    const provisioner = new (require("./core/lib/runtime-provisioner").RuntimeProvisioner)({ catalogPath, runtimesDir: path.join(api.plugin.dataDir, "runtimes"), hardware: { platform: process.platform, arch: process.arch, gpu: null }, onEvent: e => api.log("info", e.message || e.type) });
    voice = new (require("./core/lib/whisper").VoiceManager)({ provisioner, catalogPath, voiceDir: path.join(api.plugin.dataDir, "voice") });
    speech = new (require("./core/lib/speech").SpeechManager)({ speechDir: path.join(api.plugin.dataDir, "voice/kokoro") });
    turn = new (require("./core/lib/smart-turn").SmartTurnManager)({ modelPath: require("./core/lib/live-senses-assets").smartTurnModelPath() });
  }
  async function streamResponse(response, controller) {
    const headers = Object.fromEntries(response.headers.entries());
    if (!/text\/event-stream/.test(headers["content-type"] || "")) {
      const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > MAX_STREAM) throw Error("Model response is too large");
      if (/(?:audio|image|octet-stream)/.test(headers["content-type"] || "")) return { ok: response.ok, status: response.status, headers, bodyBase64: bytes.toString("base64") };
      let body = bytes.toString("utf8"); try { body = JSON.parse(body); } catch {} return { ok: response.ok, status: response.status, headers, body };
    }
    if (streams.size >= 16) { controller.abort(); throw Error("Finish an active response first"); }
    const id = crypto.randomUUID(), reader = response.body.getReader(), decoder = new TextDecoder(), record = { controller, reader, chunks: [], bytes: 0, done: false, lastPoll: Date.now() };
    streams.set(id, record);
    record.task = (async () => { try { while (true) { const next = await reader.read(); if (next.done) break; const text = decoder.decode(next.value, { stream: true }); record.bytes += Buffer.byteLength(text); if (record.bytes > MAX_STREAM) throw Error("Response buffer is full"); record.chunks.push(text); } const tail = decoder.decode(); if (tail) record.chunks.push(tail); } catch (error) { record.error = error.message; controller.abort(); } finally { record.done = true; reader.releaseLock(); } })();
    return { ok: response.ok, status: response.status, headers, streamId: id };
  }
  function expireCancelled() { for (const [id, at] of cancelled) if (Date.now() - at > 120000) cancelled.delete(id); }
  const expiry = setInterval(() => { expireCancelled(); for (const [id, record] of streams) if (Date.now() - record.lastPoll > 120000) void cancel(id).catch(() => {}); }, 30000); expiry.unref?.();
  async function request(input, signal) {
    active(signal);
    const id = input?.requestId;
    if (id === undefined) return performRequest(input, signal);
    if (typeof id !== "string" || !REQUEST_ID.test(id)) throw Error("Invalid Assistant request id");
    expireCancelled();
    if (cancelled.has(id)) throw new DOMException("The request was stopped.", "AbortError");
    if (requests.has(id)) throw Error("Assistant request is already active");
    if (requests.size >= 32) throw Error("Finish an active Assistant request first");
    const controller = new AbortController(), record = { controller, streamId: null };
    requests.set(id, record);
    const combined = AbortSignal.any([api.signal, controller.signal, ...(signal ? [signal] : [])]);
    try {
      const result = await performRequest(input, combined);
      if (combined.aborted) { if (result.streamId) await cancel(result.streamId); combined.throwIfAborted(); }
      if (result.streamId) {
        record.streamId = result.streamId;
        const stream = streams.get(result.streamId); if (stream) stream.requestId = id;
      }
      return result;
    } finally { if (!record.streamId) requests.delete(id); }
  }
  async function performRequest(input, signal) {
    active(signal); signal = AbortSignal.any([api.signal, ...(signal ? [signal] : [])]); const { url, method, bytes, body } = normalize(input), route = url.pathname;
    if (route === "/core/models" && method === "GET") return json({ ok: true, aliases: api.models.list(), runtime: api.runtime?.status?.() || { state: "idle" }, download: null, importStatus: null });
    if (["/core/health", "/core/status"].includes(route) && method === "GET") return json({ ok: true, version: api.plugin.version, runtime: api.runtime?.status?.() || { state: "idle" } });
    if (["/core/network", "/core/network/status"].includes(route) && method === "GET") return json({ ok: true, ...api.network.status() });
    if (route === "/core/network/models" && method === "GET") { const result = await api.network.models(); return json({ ok: true, ...(Array.isArray(result) ? { models: result, workersOnline: result.reduce((n, m) => n + (Number(m.providers) || 0), 0) } : result) }); }
    if (route === "/core/models/ensure" && method === "POST") return json({ ok: true, ...await api.models.ensure(body, signal) });
    if (route === "/core/chat/completions" && method === "POST") {
      const controller = new AbortController(); controllers.add(controller);
      const combined = AbortSignal.any([api.signal, controller.signal, ...(signal ? [signal] : [])]);
      try {
        let response = await api.models.request(body, combined);
        if (combined.aborted) { await response.body?.cancel().catch(() => {}); combined.throwIfAborted(); }
        if (body.stream !== false && response.ok && /application\/json/.test(response.headers.get("content-type") || "")) {
          const completed = await response.json();
          const answer = completed.choices?.[0]?.message;
          if (!answer) throw Error("Model completion did not contain a message");
          // A completed paid response can be delivered as one genuine SSE event;
          // no synthetic progress or token-by-token generation is invented.
          response = new Response(`data: ${JSON.stringify({ ...completed, choices: [{ index: 0, delta: answer, finish_reason: completed.choices[0].finish_reason || "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        }
        const result = await streamResponse(response, controller); if (!result.streamId) controllers.delete(controller); return result; }
      catch (error) { controllers.delete(controller); controller.abort(); throw error; }
    }
    if (/^\/core\/(?:tools(?:\/call)?|teams(?:\/run)?|agents\/[^?]+|dev|bench(?:\/run)?)$/.test(route)) {
      const result = await api.services.call("kai.tools", "request", input, { signal });
      if (result?.streamId) { const id = crypto.randomUUID(); streams.set(id, { remote: result.streamId, requestId: input.requestId, lastPoll: Date.now() }); return { ...result, streamId: id }; } return result;
    }
    if (["/core/search", "/core/fetch"].includes(route) && method === "POST") {
      if (api.network.status().privacyMode === "local-only") throw Error("Local-Only blocks public research");
      const fetchImpl = (url, init) => api.network.fetch(url, { method: init?.method, headers: init?.headers, ...(init?.body === undefined ? {} : { body: init.body }), signal: AbortSignal.any([api.signal, ...(signal ? [signal] : []), ...(init?.signal ? [init.signal] : [])]) });
      return json(route.endsWith("search") ? { ok: true, ...await searchWeb(body.q, { fetchImpl }) } : { ok: true, page: await fetchPage(body.url, { fetchImpl }) });
    }
    if (!/^\/core\/(?:voice(?:\/(?:setup|transcribe))?|speech(?:\/(?:setup|warm))?|turn(?:\/warm)?|transcribe)$/.test(route)) throw Error("Unsupported Assistant operation");
    engines();
    if (route === "/core/voice" && method === "GET") return json({ ok: true, ...voice.status() });
    if (route === "/core/speech" && method === "GET") return json({ ok: true, ...speech.status() });
    if (route === "/core/turn" && method === "GET") return json({ ok: true, ...turn.status() });
    if (["/core/voice/setup", "/core/speech/setup"].includes(route) && method === "POST") {
      if (api.network.status().privacyMode === "local-only") throw Error("Allow downloads in Network settings to set up speech");
      const engine = route.includes("/voice/") ? voice : speech; engine.ensure().catch(error => api.log("error", error.message)); return json({ ok: true, ...engine.status() });
    }
    if (route === "/core/speech/warm" && method === "POST") { await speech.warm(); return json({ ok: true }); }
    if (route === "/core/speech" && method === "POST") return { ok: true, status: 200, headers: { "content-type": "audio/wav" }, bodyBase64: Buffer.from(await speech.generate({ text: body.text, voice: body.voice, signal })).toString("base64") };
    if (["/core/transcribe", "/core/voice/transcribe"].includes(route) && method === "POST") return json({ ok: true, ...await voice.transcribe(bytes, { signal }) });
    if (route === "/core/turn/warm" && method === "POST") return json({ ok: true, ...await turn.warm({ signal }) });
    if (route === "/core/turn" && method === "POST") return json({ ok: true, ...await turn.analyze(bytes, { signal }) });
    throw Error("Unsupported Assistant operation");
  }
  async function poll(id, signal) {
    active(signal); const record = streams.get(id); if (!record) throw Error("Unknown Assistant response"); record.lastPoll = Date.now();
    if (record.remote) { const out = await api.services.call("kai.tools", "poll", { streamId: record.remote }, { signal }); if (out.done) { streams.delete(id); requests.delete(record.requestId); } return out; }
    const chunks = []; let count = 0; while (record.chunks.length && count < 256 * 1024) { const chunk = record.chunks.shift(), size = Buffer.byteLength(chunk); chunks.push(chunk); count += size; record.bytes -= size; }
    const done = record.done && !record.chunks.length; if (done) { streams.delete(id); controllers.delete(record.controller); requests.delete(record.requestId); }
    return { chunks, done, ...(record.error ? { error: record.error } : {}) };
  }
  async function cancel(value) {
    const requestId = typeof value === "object" && value ? value.requestId : undefined;
    let id = typeof value === "string" ? value : value?.streamId;
    if (requestId !== undefined && (typeof requestId !== "string" || !REQUEST_ID.test(requestId))) throw Error("Invalid Assistant request id");
    const pending = requests.get(requestId);
    if (id && pending?.streamId && id !== pending.streamId) throw Error("Assistant response does not belong to this request");
    if (!id) id = pending?.streamId;
    const record = streams.get(id);
    if (requestId && record?.requestId && requestId !== record.requestId) throw Error("Assistant response does not belong to this request");
    if (requestId) {
      // IPC cancellation may overtake startup/headers. Remember only a bounded,
      // short-lived set of IDs so that late registration cannot restart work.
      expireCancelled(); cancelled.set(requestId, Date.now());
      while (cancelled.size > 128) cancelled.delete(cancelled.keys().next().value);
      pending?.controller.abort(new DOMException("The request was stopped.", "AbortError")); requests.delete(requestId);
    }
    if (!record) return { stopped: true };
    streams.delete(id); requests.delete(record.requestId); record.controller?.abort(); controllers.delete(record.controller);
    await record.reader?.cancel().catch(() => {});
    if (record.remote) await api.services.call("kai.tools", "cancel", { streamId: record.remote, requestId: record.requestId });
    return { stopped: true };
  }
  async function serve(req, res) {
    const fail = (status, message) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: message })); };
    if (stopped || req.headers.host !== `127.0.0.1:${port}` || req.headers["x-kai-assistant-token"] !== secret) return fail(403, "Assistant access denied");
    let url; try { url = new URL(req.url, origin()); if (url.origin !== origin()) throw Error(); } catch { return fail(400, "Invalid request"); }
    res.setHeader("x-content-type-options", "nosniff"); res.setHeader("cache-control", "no-store");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (req.method === "GET" && staticAssets.has(url.pathname)) { const file = staticAssets.get(url.pathname); res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" }); fs.createReadStream(file).on("error", () => res.destroy()).pipe(res); return; }
    if (!url.pathname.startsWith("/core/")) return fail(404, "Not found");
    const controller = new AbortController(); req.on("aborted", () => controller.abort()); res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    const chunks = []; let length = 0; for await (const chunk of req) { length += chunk.length; if (length > MAX_REQUEST) return fail(413, "Request is too large"); chunks.push(chunk); }
    const raw = Buffer.concat(chunks), binary = !/json/.test(req.headers["content-type"] || "") && raw.length;
    try {
      const result = await (clientRequest || request)({ path: url.pathname + url.search, method: req.method, ...(raw.length ? binary ? { bodyBase64: raw.toString("base64") } : { body: raw.toString("utf8") } : {}) }, controller.signal);
      res.writeHead(result.status, result.headers);
      if (result.streamId) { try { while (!controller.signal.aborted) { const next = await poll(result.streamId, controller.signal); for (const chunk of next.chunks || []) res.write(chunk); if (next.error) throw Error(next.error); if (next.done) break; await new Promise(resolve => setTimeout(resolve, 50)); } } finally { await cancel(result.streamId).catch(() => {}); } res.end(); }
      else res.end(result.bodyBase64 ? Buffer.from(result.bodyBase64, "base64") : typeof result.body === "string" ? result.body : JSON.stringify(result.body));
    } catch (error) { if (res.headersSent) res.destroy(); else fail(400, error.message); }
  }
  async function ensure() {
    active(); if (starting) return starting;
    starting = (async () => { engines(); server = http.createServer((req, res) => { serve(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(); api.log("error", error.message); }); }); server.requestTimeout = 180000; server.headersTimeout = 10000; await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); port = server.address().port; resolve(); }); }); })(); return starting;
  }
  async function dispose() { if (stopped) return; stopped = true; clearInterval(expiry); for (const r of requests.values()) r.controller.abort(); for (const c of controllers) c.abort(); await Promise.allSettled([...streams.keys()].map(cancel)); requests.clear(); cancelled.clear(); speech?.close(); turn?.close(); await starting?.catch(() => {}); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await mascotSession.clearStorageData(); }
  return { ensure, request, poll, cancel, dispose, origin, mascotSession, staticAssets, setClientRequest(fn) { clientRequest = fn; }, get voice() { return voice; }, get speech() { return speech; }, get turn() { return turn; }, get port() { return port; } };
}
module.exports = { createRuntime, normalize };
