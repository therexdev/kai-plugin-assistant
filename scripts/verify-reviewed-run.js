"use strict";
const fs = require("node:fs"), path = require("node:path"), { verifyReviewedRun } = require("./release-provenance");
const root = path.resolve(__dirname, ".."), proof = JSON.parse(fs.readFileSync(path.join(root, "release-signature.json"))), run = JSON.parse(fs.readFileSync(path.join(root, ".build/reviewed-run.json")));
verifyReviewedRun(proof, run, process.env.GITHUB_REPOSITORY);
console.log(`Reviewed build ${proof.buildRunId} passed for ${proof.sourceCommit}.`);
