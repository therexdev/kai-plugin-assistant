/* Presentation only. Routing, approvals and node state stay in their controllers. */
(() => {
  "use strict";
  let artwork, sequence = 0;
  async function mountCharacters(root = document) {
    const hosts = [...root.querySelectorAll("[data-kai-character]:not([data-kai-mounted])")];
    if (!hosts.length) return;
    hosts.forEach(host => { host.dataset.kaiMounted = "loading"; });
    try {
      artwork ||= Promise.resolve(document.getElementById("kai-artwork").innerHTML);
      const svg = await artwork;
      for (const host of hosts) {
        // Every inline instance owns its fragment IDs, including after New chat.
        const prefix = `kai-art-${++sequence}-`;
        host.innerHTML = svg.replace(/id="(kai-[^"]+)"/g, (_, id) => `id="${prefix}${id}"`)
          .replace(/url\(#(kai-[^)]+)\)/g, (_, id) => `url(#${prefix}${id})`);
        if (host.classList.contains("kai-avatar")) host.querySelector("svg").setAttribute("viewBox", "20 60 984 660");
        host.dataset.kaiMounted = "ready";
      }
    } catch {
      for (const host of hosts) { KaiI18n.setText(host, "KAI"); delete host.dataset.kaiMounted; }
    }
  }
  window.kaiBrand = { mountCharacters };
  mountCharacters();
  document.getElementById("messages")?.addEventListener("click", event => {
    const prompt = event.target.closest("[data-chat-prompt]");
    const input = document.getElementById("input");
    if (!prompt || input.disabled) return;
    input.value = prompt.dataset.chatPrompt;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  });
  const history = document.getElementById("history-toggle");
  history?.addEventListener("click", () => {
    const open = document.getElementById("view-chat").classList.toggle("history-open");
    history.setAttribute("aria-expanded", String(open));
  });
  function closeHistory() {
    document.getElementById("view-chat").classList.remove("history-open");
    history?.setAttribute("aria-expanded", "false");
  }
  document.getElementById("chat-list")?.addEventListener("click", event => {
    if (event.target.closest(".chat-row") && !event.target.closest("button")) closeHistory();
  });
  document.getElementById("btn-new-chat")?.addEventListener("click", closeHistory);
})();
