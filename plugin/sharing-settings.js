"use strict";
(() => {
  const settings = document.getElementById("view-settings"); if (!settings) return;
  const panel = document.createElement("details"); panel.className = "assistant-sharing card";
  const summary = document.createElement("summary"); KaiI18n.setText(summary, "Conversation access");
  const explanation = document.createElement("p"); KaiI18n.setText(explanation, "Review which plugins can read selected conversations or save workflow results in the background.");
  const list = document.createElement("div"), status = document.createElement("p"); status.setAttribute("role", "status");
  panel.append(summary, explanation, list, status); settings.append(panel);
  async function refresh() {
    try {
      const grants = await window.kai.call("assistant.access.list", {}); list.replaceChildren(); status.textContent = "";
      if (!Object.keys(grants).length) { KaiI18n.setText(status, "No plugins have saved conversation access."); return; }
      for (const [caller, grant] of Object.entries(grants)) {
        const row = document.createElement("div"); row.className = "assistant-sharing-row";
        const label = document.createElement("span"); KaiI18n.setText(label, KaiI18n.message`${caller} · ${(grant.reads || []).length} selected conversations · ${Object.keys(grant.writes || {}).length} workflow outputs`);
        const revoke = document.createElement("button"); revoke.type = "button"; KaiI18n.setText(revoke, "Revoke access");
        revoke.addEventListener("click", async () => { revoke.disabled = true; try { await window.kai.call("assistant.access.revoke", { caller }); await refresh(); } catch (error) { status.textContent = error.message; revoke.disabled = false; } });
        row.append(label, revoke); list.append(row);
      }
    } catch (error) { status.textContent = error.message; }
  }
  panel.addEventListener("toggle", () => { if (panel.open) void refresh(); });
})();
