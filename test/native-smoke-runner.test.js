"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { runNativeSmoke } = require("../scripts/run-native-smoke");
async function fixture(t, exitCode) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-runner-test-")), entry = path.join(dir, "child.cjs"), report = path.join(dir, "child-profile.json");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(entry, `const fs=require('node:fs'),path=require('node:path');const profile=process.env.KAI_ASSISTANT_SMOKE_PROFILE;fs.writeFileSync(path.join(profile,'owned.txt'),'fixture');fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({profile,alive:fs.existsSync(profile)}));setTimeout(()=>process.exit(${exitCode}),25);`);
  return { entry, report };
}
test("native smoke parent removes its profile only after the child exits", async t => {
  const f = await fixture(t, 0), code = await runNativeSmoke({ electronBinary: process.execPath, entry: f.entry });
  const report = JSON.parse(await fs.readFile(f.report, "utf8")); assert.equal(report.alive, true); assert.equal(code, 0); await assert.rejects(fs.stat(report.profile), { code: "ENOENT" });
});
test("post-exit cleanup preserves a failing native smoke exit status", async t => {
  const f = await fixture(t, 7), code = await runNativeSmoke({ electronBinary: process.execPath, entry: f.entry });
  const report = JSON.parse(await fs.readFile(f.report, "utf8")); assert.equal(code, 7); await assert.rejects(fs.stat(report.profile), { code: "ENOENT" });
});
