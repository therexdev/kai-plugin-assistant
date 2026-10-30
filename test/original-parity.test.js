"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.join(__dirname, "../plugin"), read = file => fs.readFileSync(path.join(root, file), "utf8"), html = read("index.html");
test("original chat controls and advanced modes are retained in the plugin", () => {
  for (const id of ["chat-list", "chat-search", "btn-new-chat", "composer", "mode-pick", "src-pick", "model-pick", "persona-pick", "persona-custom", "btn-attach", "btn-web", "btn-mic", "btn-stop", "launch-kai", "desktop-providers", "provider-openai", "provider-anthropic"]) assert.ok(html.includes(`id="${id}"`), id);
  for (const mode of ["chat", "research", "agent", "team:research", "team:analyst", "team:review"]) assert.ok(html.includes(`value="${mode}"`), mode);
  const app = read("app.js"); assert.match(app, /Regenerate/); assert.match(app, /kaiCompanionBridge\.manage\("note"/); assert.match(app, /citations/); assert.match(app, /images/); assert.match(app, /\/core\/teams\/run/);
  assert.match(read("assistant-extras.js"), /MediaRecorder/); assert.match(read("assistant-extras.js"), /\/core\/transcribe/);
});
test("all application scripts parse and the native bridge routes only through scoped calls", () => {
  for (const match of html.matchAll(/<script src="([^"]+)"/g)) new vm.Script(read(match[1]), { filename: match[1] });
  const bridge = read("bridge.js"); assert.match(bridge, /window\.kai\.call\("assistant\.request"/); assert.match(bridge, /startsWith\("\/core\/"\)/);
  assert.match(bridge, /assistant\.cancel/); assert.match(bridge, /assistant\.poll/); assert.match(bridge, /init\.signal/);
  assert.ok(!/ipcRenderer|require\(|eval\(/.test(bridge));
});
