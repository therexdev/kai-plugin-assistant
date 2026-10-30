"use strict";
(() => {
  const button = document.getElementById("launch-kai"), error = document.getElementById("kai-launch-error");
  if (!button || !window.koinosShell?.launchMascot) return;
  button.hidden = false;
  button.addEventListener("click", async () => {
    button.disabled = true; error.hidden = true;
    try {
      const model = typeof composedChatModel === "function" ? composedChatModel() : null;
      await window.koinosShell.launchMascot({ model });
    } catch {
      KaiI18n.setText(error, "KAI could not open. Try again, or restart the app.");
      error.hidden = false;
    } finally { button.disabled = false; }
  });
  window.koinosShell.onMascotOpenView?.(view => {
    let safeView = window.KaiAppNavigation?.valid(view) ? view : "chat";
    const baseView = safeView.startsWith("koinos") ? "koinos" : safeView;
    const nav = document.querySelector('[data-view="' + baseView + '"]');
    if (nav?.hidden) safeView = "settings";
    if (typeof activateView === "function") {
      activateView(safeView.startsWith("koinos") ? "koinos" : safeView);
      if (safeView.startsWith("koinos")) window.KaiKoinosNode?.select(safeView);
    } else nav?.click();
    if (typeof refreshChatList === "function") refreshChatList();
  });
  window.addEventListener("focus", () => {
    if (typeof refreshChatList === "function") refreshChatList();
  });
})();
