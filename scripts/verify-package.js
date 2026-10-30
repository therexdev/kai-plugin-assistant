"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { signingPayload, BINARY } = require("./package-format"), root = path.resolve(__dirname, ".."), manifest = require("../plugin/manifest.json"), publisher = require("../publisher.json");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "dist", `kai-plugin-assistant-${manifest.version}.kaiplugin`), "utf8"));
assert.deepEqual(pkg.manifest, manifest); assert.equal(pkg.publicKey, publisher.publicKey); assert.equal(pkg.manifest.id, publisher.id);
const key = crypto.createPublicKey({ key: Buffer.from(pkg.publicKey, "base64"), format: "der", type: "spki" }); assert.equal(key.asymmetricKeyType, "ed25519"); assert.ok(crypto.verify(null, Buffer.from(signingPayload(pkg.manifest, pkg.files)), key, Buffer.from(pkg.signature, "base64")));
function walk(dir, prefix = "") { for (const row of fs.readdirSync(dir, { withFileTypes: true })) { const name = prefix + row.name; if (row.isDirectory()) walk(path.join(dir, row.name), name + "/"); else if (name !== "manifest.json") assert.equal(pkg.files[name], fs.readFileSync(path.join(dir, row.name)).toString(BINARY.test(name) ? "base64" : "utf8"), "Source changed since payload build: " + name); } }
walk(path.join(root, "plugin"));
for (const required of ["service/node_modules/onnxruntime-node/package.json", "service/node_modules/sherpa-onnx-win-x64/package.json", "service/node_modules/sherpa-onnx-linux-x64/package.json", "service/node_modules/sherpa-onnx-darwin-x64/package.json", "service/node_modules/sherpa-onnx-darwin-arm64/package.json", "service/resources/live-senses/turn/smart-turn-v3.2-cpu.onnx", "service/build/bin/kai-windows-voice.exe", "service/build/bin/kai-computer.exe"]) assert.ok(pkg.files[required], "Missing native payload: " + required);
console.log(`Verified ${manifest.id}@${manifest.version}: ${Object.keys(pkg.files).length} files.`);
