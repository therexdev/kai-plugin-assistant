"use strict";
const assert = require("node:assert/strict");
function validateProof(proof) {
  assert.equal(proof?.schema, 1, "Unsupported release proof");
  assert.ok(Number.isSafeInteger(proof.buildRunId) && proof.buildRunId > 0, "Invalid reviewed build run ID");
  assert.match(proof.sourceCommit || "", /^[a-f0-9]{40}$/, "Invalid reviewed source commit");
  assert.match(proof.payloadSha256 || "", /^[a-f0-9]{64}$/, "Invalid reviewed payload digest");
}
function verifyReviewedRun(proof, run, repository) {
  validateProof(proof);
  assert.equal(repository, "therexdev/kai-plugin-assistant", "Unexpected release repository");
  assert.equal(run.id, proof.buildRunId, "Wrong reviewed build run");
  assert.equal(run.repository?.full_name, repository, "Build belongs to another repository");
  assert.equal(run.head_repository?.full_name, repository, "Build source belongs to another repository");
  assert.equal(run.path, ".github/workflows/build.yml", "Wrong build workflow");
  assert.equal(run.head_sha, proof.sourceCommit, "Build does not match the reviewed source commit");
  assert.equal(run.status, "completed", "Reviewed build is incomplete");
  assert.equal(run.conclusion, "success", "Reviewed build did not pass all checks");
}
function verifyArtifactMetadata(proof, metadata, observed) {
  validateProof(proof);
  assert.equal(metadata.schema, 1, "Unsupported build metadata");
  assert.equal(metadata.sourceCommit, proof.sourceCommit, "Artifact belongs to another source commit");
  assert.equal(metadata.payloadSha256, proof.payloadSha256, "Artifact metadata differs from the reviewed digest");
  assert.equal(observed.payloadSha256, proof.payloadSha256, "Build artifact does not match the reviewed payload");
  for (const key of ["id", "version", "bytes", "files", "signingSha256"]) assert.equal(metadata[key], observed[key], "Build metadata mismatch: " + key);
}
module.exports = { validateProof, verifyReviewedRun, verifyArtifactMetadata };
