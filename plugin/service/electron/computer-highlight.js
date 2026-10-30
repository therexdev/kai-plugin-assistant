"use strict";
// Passive, click-through target markers for a reviewed visual action. These
// windows have no preload or IPC capability and disappear before native input.
function highlight({ BrowserWindow, screen }, view, args) {
  const marks = [];
  if (!view.bounds) return () => {};
  for (const p of [{ x: args.x, y: args.y }, ...(args.toX !== undefined ? [{ x: args.toX, y: args.toY }] : [])]) {
    const physical = { x: Math.round(view.bounds.x + p.x * (view.bounds.width - 1) / 1000), y: Math.round(view.bounds.y + p.y * (view.bounds.height - 1) / 1000) };
    const at = screen.screenToDipPoint(physical);
    const w = new BrowserWindow({ x: at.x - 24, y: at.y - 24, width: 48, height: 48, frame: false, transparent: true, hasShadow: false,
      alwaysOnTop: true, focusable: false, skipTaskbar: true, show: false, resizable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    marks.push(w); w.setIgnoreMouseEvents(true);
    w.loadURL("data:text/html," + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{margin:4px;width:32px;height:32px;border:4px solid #ff6c35;border-radius:50%;box-shadow:0 0 0 2px white;background:#ff6c3530}</style>')).then(() => { if (!w.isDestroyed()) w.showInactive(); }).catch(() => {});
  }
  return () => { for (const w of marks) if (!w.isDestroyed()) w.destroy(); };
}
module.exports = { highlight };
