"use strict";
const path = require("node:path"), assert = require("node:assert/strict"), root = path.resolve(__dirname, "../.build/plugin/service");
async function main() {
  const ort = require(path.join(root, "node_modules/onnxruntime-node")), sherpa = require(path.join(root, "node_modules/sherpa-onnx-node"));
  assert.equal(typeof ort.InferenceSession.create, "function"); assert.equal(typeof sherpa.OfflineTts, "function");
  const { SmartTurnManager } = require(path.join(root, "core/lib/smart-turn"));
  const manager = new SmartTurnManager({ modelPath: path.join(root, "resources/live-senses/turn/smart-turn-v3.2-cpu.onnx") });
  try { await manager.warm({ signal: AbortSignal.timeout(60000) }); console.log("Plugin-owned native voice dependencies and semantic turn model verified"); }
  finally { await manager.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
