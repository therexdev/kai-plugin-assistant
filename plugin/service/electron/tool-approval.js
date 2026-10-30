"use strict";

function createToolApproval({ dialog }) {
  let generation = 0, pending = false;
  return {
    cancel() { generation++; },
    async confirm(window, name, args) {
      if (pending || typeof name !== "string" || !name || name.length > 180) return false;
      const detail = JSON.stringify(args, null, 2);
      // Never approve arguments the person could not actually review.
      if (!detail || detail.length > 20000) throw new Error("This action is too large to review here. Open its app screen instead.");
      if (!window || window.isDestroyed() || !window.isVisible()) return false;
      const epoch = generation; pending = true;
      try {
        const { response } = await dialog.showMessageBox(window, {
          type: "question", title: "KAI · Approve app action?", message: "Allow KAI to use " + name + "?",
          detail: detail + "\n\nThese are the exact arguments. Approve only if they match your request. This approval applies once. An action already started may continue if you stop the reply.",
          buttons: ["Cancel", "Allow once"], defaultId: 0, cancelId: 0, noLink: true,
        });
        return response === 1 && epoch === generation && !window.isDestroyed() && window.isVisible();
      } finally { pending = false; }
    },
  };
}
module.exports = { createToolApproval };
