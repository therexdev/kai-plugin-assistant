"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { BINARY } = require("./package-format"), root = path.resolve(__dirname, ".."), raw = fs.readFileSync(path.join(root, ".build/unsigned-plugin.json")), meta = require("../.build/unsigned-metadata.json"), payload = JSON.parse(raw);
assert.equal(crypto.createHash("sha256").update(raw).digest("hex"), meta.payloadSha256); assert.deepEqual(payload.manifest, require("../plugin/manifest.json"));
const target = path.join(root, ".build/plugin"); fs.mkdirSync(target, { recursive: true });
for (const [name, value] of Object.entries(payload.files)) { assert.ok(name.split("/").every(part => /^[a-zA-Z0-9_@-][a-zA-Z0-9_.@-]*$/.test(part) && !/[. ]$/.test(part))); const file = path.join(target, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(value, BINARY.test(name) ? "base64" : "utf8")); }
fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify(payload.manifest)); console.log("Extracted reviewed build payload for native checks");
