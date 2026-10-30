"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { verifyReviewedRun, verifyArtifactMetadata } = require("../scripts/release-provenance");
const repository = "therexdev/kai-plugin-assistant", proof = { schema: 1, buildRunId: 41136390866, sourceCommit: "8fa0cb7da12ccc14836ca49af6cd39c808efdb2b", payloadSha256: "a".repeat(64) };
const run = { id: proof.buildRunId, repository: { full_name: repository }, head_repository: { full_name: repository }, path: ".github/workflows/build.yml", head_sha: proof.sourceCommit, status: "completed", conclusion: "success" };
const observed = { id: "kai.assistant", version: "0.3.0", bytes: 10, files: 2, payloadSha256: proof.payloadSha256, signingSha256: "b".repeat(64) }, metadata = { schema: 1, sourceCommit: proof.sourceCommit, ...observed };
test("release accepts only the successful reviewed source run", () => {
  verifyReviewedRun(proof, run, repository);
  for (const change of [{ id: run.id + 1 }, { head_sha: "0".repeat(40) }, { status: "in_progress" }, { conclusion: "failure" }, { path: ".github/workflows/unreviewed.yml" }, { repository: { full_name: "other/repository" } }, { head_repository: { full_name: "other/repository" } }]) assert.throws(() => verifyReviewedRun(proof, { ...run, ...change }, repository));
  assert.throws(() => verifyReviewedRun(proof, run, "other/repository"));
});
test("release artifact provenance binds the exact bytes, source and signing digest", () => {
  verifyArtifactMetadata(proof, metadata, observed);
  for (const change of [{ sourceCommit: "0".repeat(40) }, { payloadSha256: "c".repeat(64) }, { id: "other.plugin" }, { version: "9.0.0" }, { bytes: 11 }, { files: 3 }, { signingSha256: "d".repeat(64) }]) assert.throws(() => verifyArtifactMetadata(proof, { ...metadata, ...change }, observed));
  assert.throws(() => verifyArtifactMetadata(proof, metadata, { ...observed, payloadSha256: "c".repeat(64) }));
  assert.throws(() => verifyArtifactMetadata({ ...proof, buildRunId: "not-a-run" }, metadata, observed));
});
