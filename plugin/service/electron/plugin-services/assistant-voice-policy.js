"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
function createVoiceDownloadPolicy({ isLocalOnly, services }) {
  const execution = new AsyncLocalStorage(), jobs = new Map(), downloads = new Set(), originals = [];
  let disposed = false;
  const blocked = () => Error(disposed ? "Assistant voice setup is closing" : "Local-Only blocks voice downloads. Installed voices still work. Choose Local-First or Network before downloading a voice.");
  const check = () => { if (disposed || isLocalOnly()) throw blocked(); };
  const report = (service, error) => { const key = "_setup" in service ? "_setup" : "setup"; service[key] = { state: "error", error: error.message }; };
  for (const service of services.filter(Boolean)) {
    const ensure = service.ensure;
    if (typeof ensure !== "function") continue;
    function reviewedEnsure(options = {}) {
      try { const state = service.status?.() || {}; if (disposed || isLocalOnly() && !state.available && !state.modelPresent) throw blocked(); } catch (error) { report(service, error); return Promise.reject(error); }
      const controller = new AbortController(); let task;
      try { task = execution.run({ signal: controller.signal }, () => Promise.resolve(ensure.call(service, { ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal }))); }
      catch (error) { task = Promise.reject(error); }
      jobs.set(task, { controller, service }); task.then(() => jobs.delete(task), () => jobs.delete(task)); return task;
    }
    service.ensure = reviewedEnsure; originals.push(() => { if (service.ensure === reviewedEnsure) service.ensure = ensure; });
    if (typeof service.download === "function") {
      const download = service.download;
      function reviewedDownload(url, destination, options = {}) {
        check(); const signal = execution.getStore()?.signal; signal?.throwIfAborted();
        const combined = signal && options.signal ? AbortSignal.any([signal, options.signal]) : signal || options.signal;
        const task = Promise.resolve(download.call(service, url, destination, { ...options, signal: combined }));
        downloads.add(task); task.then(() => downloads.delete(task), () => downloads.delete(task)); return task;
      }
      service.download = reviewedDownload; originals.push(() => { if (service.download === reviewedDownload) service.download = download; });
    }
  }
  function cancel() {
    for (const { controller, service } of jobs.values()) { controller.abort(); service.downloadAbort?.abort(); }
  }
  return {
    async pause() { cancel(); await Promise.allSettled([...downloads]); },
    async dispose() {
      disposed = true; cancel();
      for (const service of new Set([...jobs.values()].map(job => job.service))) service.close?.();
      await Promise.allSettled([...jobs.keys()]); for (const restore of originals.reverse()) restore();
    },
  };
}
module.exports = { createVoiceDownloadPolicy };
