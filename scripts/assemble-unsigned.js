"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { BINARY, signingPayload } = require("./package-format"), root = path.resolve(__dirname, ".."), source = path.resolve(process.argv[2] || path.join(root, ".build/plugin"));
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"))), files = {};
function walk(dir, prefix = "") { for (const row of fs.readdirSync(dir, { withFileTypes: true })) { if (row.isSymbolicLink()) throw Error("No symlinks in a signed plugin"); const name = prefix + row.name; if (row.isDirectory()) walk(path.join(dir, row.name), name + "/"); else if (name !== "manifest.json") files[name] = fs.readFileSync(path.join(dir, row.name)).toString(BINARY.test(name) ? "base64" : "utf8"); } }
walk(source); const payload = { manifest, files }, encoded = JSON.stringify(payload);
if (Buffer.byteLength(encoded) > 510 * 1024 * 1024) throw Error("Payload exceeds Foundation package size budget");
const target = path.join(path.dirname(source), "unsigned-plugin.json"); fs.writeFileSync(target, encoded);
const metadata = { schema: 1, id: manifest.id, version: manifest.version, sourceCommit: process.env.GITHUB_SHA || null, payloadSha256: crypto.createHash("sha256").update(encoded).digest("hex"), signingSha256: crypto.createHash("sha256").update(signingPayload(payload.manifest, payload.files)).digest("hex"), files: Object.keys(files).length, bytes: Buffer.byteLength(encoded) };
fs.writeFileSync(path.join(path.dirname(source), "unsigned-metadata.json"), JSON.stringify(metadata, null, 2) + "\n"); console.log(JSON.stringify(metadata));
