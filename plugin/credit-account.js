"use strict";
(() => {
  function createCreditState({ read, clock = Date.now }) {
    const listeners = new Set(); let pending, generation = 0, value = { status: "loading", snapshot: null, error: null, refreshing: false };
    const notify = () => { for (const listener of listeners) listener(structuredClone(value)); };
    const atoms = n => typeof n === "string" && /^(0|[1-9]\d{0,19})$/.test(n) && BigInt(n) <= (1n << 64n) - 1n;
    function accept(result) {
      const s = result?.credits;
      if (!s || !atoms(s.available) || !atoms(s.purchased?.available) || !atoms(s.free?.available) || !atoms(s.version) ||
          !["USD-1e-8", "legacy-KOIN-1e-8"].includes(s.unit) || !["available", "unavailable", "ineligible"].includes(s.free.state) ||
          BigInt(s.available) !== BigInt(s.purchased.available) + BigInt(s.free.available)) throw Error("Credit balance could not be verified");
      const key = JSON.stringify([result.product, result.owner]);
      if (value.snapshot?.key === key && BigInt(s.version) < BigInt(value.snapshot.credits.version)) return;
      value = { status: "ready", error: null, refreshing: false, snapshot: { key, product: result.product, owner: result.owner, credits: structuredClone(s),
        deviceFree: result.accessKind === "device-free", paidAccessLocked: result.accessKind === "device-free" && result.paidAccessLocked === true,
        purchases: structuredClone(result.purchases || []), usage: structuredClone(result.usage || []), receivedAt: clock() } }; notify();
    }
    async function refresh() {
      if (!pending) { const epoch = generation; pending = Promise.resolve().then(read).then(result => { if (epoch === generation) accept(result); }).catch(error => {
        if (epoch !== generation) return;
        value = { ...value, status: "unavailable", error: String(error.message || "Credit balance unavailable").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""), refreshing: false }; notify();
      }).finally(() => { if (epoch === generation) { pending = null; if (value.refreshing) { value = { ...value, refreshing: false }; notify(); } } });
        value = { ...value, status: value.snapshot ? value.status : "loading", refreshing: true }; notify();
      }
      await pending; return structuredClone(value);
    }
    return { accept, refresh, clear() { generation++; pending = null; value = { status: "loading", snapshot: null, error: null, refreshing: false }; notify(); }, get: () => structuredClone(value), subscribe(listener) { listeners.add(listener); listener(structuredClone(value)); return () => listeners.delete(listener); } };
  }
  const credits = value => { const n = BigInt(value), fraction = String(n % 100000n).padStart(5, "0").replace(/0+$/, ""); return (n / 100000n).toLocaleString() + (fraction ? "." + fraction : ""); };
  function creditPresentation(state, now = Date.now()) {
    const snapshot = state.snapshot, s = snapshot?.credits;
    const stale = !!s && (state.status !== "ready" || now - snapshot.receivedAt > 30000);
    const loading = state.status === "loading", usd = snapshot?.product === "prepaid-usd-v1" && s?.unit === "USD-1e-8";
    const reset = Number(s?.free?.resetAt), resetText = Number.isFinite(reset) && reset > 0 ? ` Free credits reset ${new Date(reset).toLocaleString()}.` : "";
    const status = usd ? stale ? "Showing your last verified balance. Connection unavailable." : "" : s ? "Your earlier balance is in Account help. It is separate from USD credits." : loading ? "Loading your free and purchased credits." : state.error || "Your credit balance could not be loaded. Try again.";
    const compactStatus = !status ? "" : usd ? "Last verified balance · reconnecting" : s ? "Earlier balance: Account help."
      : loading ? "Checking your credit account…" : /not activated|activation is pending/i.test(status) ? "Credit service not activated yet."
      : /earlier KOIN account/i.test(status) ? "Earlier balance: Account help."
      : /Open the desktop app/i.test(status) ? "Open desktop to check your credits." : /connect.*wallet/i.test(status) ? "Wallet connection needed." : /sign in/i.test(status) ? "Credit connection needed." : "Could not refresh. Retry or view details.";
    return {
      usd, stale, total: usd ? credits(s.available) : loading ? "…" : "—",
      breakdown: usd ? `${s.free.state === "unavailable" ? "Free allowance unavailable" : s.free.state === "ineligible" ? "Free allowance not eligible" : credits(s.free.available) + " free"}${snapshot.deviceFree ? snapshot.paidAccessLocked ? " · purchased balance not connected" : "" : ` · ${credits(s.purchased.available)} purchased`}`
        : s ? "Earlier KOIN-based account" : loading ? "Checking credits…" : "Balance unavailable",
      status, compactStatus,
      detail: usd ? `Checked ${new Date(snapshot.receivedAt).toLocaleString()}.${resetText}${stale && state.error ? " " + state.error : ""}` : "",
      refreshing: state.refreshing === true,
    };
  }
  if (typeof module === "object") module.exports = { createCreditState, creditPresentation, credits };
  if (typeof window === "undefined") return;
  window.KaiCredits = createCreditState({ read: () => { if (!window.kaiKoinTestBridge) throw Error("Open the desktop app to check network credits. Local AI remains available."); return window.kaiKoinTestBridge.run("credit-status"); } });
  window.KaiCreditPresentation = creditPresentation;
  let paintedUsd = false;
  function paint(state) {
    const display = creditPresentation(state);
    if (!display.usd) {
      if (!state.snapshot && paintedUsd) {
        for (const id of ["network-chat-balance", "koin-available"]) { const node = document.getElementById(id); if (node) node.textContent = "—"; }
        const detail = document.getElementById("network-credit-sources"); if (detail) detail.textContent = "";
      }
      paintedUsd = false; return;
    }
    paintedUsd = true;
    const balance = document.getElementById("network-chat-balance"), account = document.getElementById("koin-available");
    if (balance) balance.textContent = `${display.total} credits${display.stale ? " · last known balance" : ""}`;
    if (account) account.textContent = display.total;
    const detail = document.getElementById("network-credit-sources");
    if (detail) detail.textContent = `${display.breakdown} · ${display.detail}`;
  }
  window.KaiCredits.subscribe(paint);
  setInterval(() => { if (!document.hidden) paint(window.KaiCredits.get()); }, 1000);
  window.addEventListener("kai-account-signed-out", () => { window.KaiCredits.clear(); window.KaiCredits.refresh(); });
  window.addEventListener("kai-credit-identity-changed", () => { window.KaiCredits.clear(); window.KaiCredits.refresh(); });
  window.addEventListener("kai-network-account-changed", () => window.KaiCredits.refresh());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) window.KaiCredits.refresh(); });
  // Refresh before the 30-second freshness boundary so a normal background
  // read does not briefly relabel the balance as stale. Errors and overdue
  // reads still retain the last balance with an explicit stale status.
  setInterval(() => { if (!document.hidden) window.KaiCredits.refresh(); }, 15000);
  // Read existing USD deployments too: public activation is not evidence that
  // an older, already-connected account has no purchased credits.
  window.KaiCredits.refresh();
})();
