"use strict";

// OS-owned folders only. No renderer-provided path, URL, executable or command
// ever reaches shell. A model reply cannot call this capability.
const FOLDERS = Object.freeze({
  pictures: "Pictures", documents: "Documents", downloads: "Downloads",
  desktop: "Desktop", music: "Music", videos: "Videos", home: "Home",
});

function createFolderActions({ app, dialog, shell }) {
  let pending = false, generation = 0;
  return {
    cancel() { generation++; },
    async open(window, folder) {
      if (!Object.hasOwn(FOLDERS, folder)) throw new Error("KAI can only open a supported personal folder.");
      if (pending) throw new Error("Finish the current approval first.");
      if (!window || window.isDestroyed() || !window.isVisible()) return { status: "cancelled", folder };
      pending = true;
      const epoch = generation, label = FOLDERS[folder];
      try {
        const target = app.getPath(folder);
        const { response } = await dialog.showMessageBox(window, {
          type: "question", title: "KAI · Allow desktop action?",
          message: "Open your " + label + " folder?",
          detail: target + "\n\nThis opens the folder in your file manager. KAI will not read, upload, change or delete its contents. This approval applies only to this request.",
          buttons: ["Cancel", "Open folder"], defaultId: 0, cancelId: 0, noLink: true,
        });
        if (response !== 1 || epoch !== generation || window.isDestroyed() || !window.isVisible()) return { status: "cancelled", folder, label };
        const error = await shell.openPath(target);
        return error ? { status: "error", folder, label, error: String(error).slice(0, 300) } : { status: "opened", folder, label };
      } finally { pending = false; }
    },
  };
}

module.exports = { FOLDERS, createFolderActions };
