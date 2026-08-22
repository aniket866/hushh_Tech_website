import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  REQUIRED_DRIFT_BLOCKERS,
  validateGcpReadBatchCandidateMatrix,
} from "../../../scripts/gcp/migration/validate-gcp-read-batch-candidates.mjs";

const serviceRoot = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../../", import.meta.url);
const matrix = JSON.parse(
  await readFile(new URL("registry/candidates.gcp-read-batch.v1.json", serviceRoot), "utf8"),
);
const currentEvidence = JSON.parse(
  await readFile(new URL(matrix.source_evidence.path, repositoryRoot), "utf8"),
);
const sourceFiles = Object.fromEntries(
  await Promise.all(
    matrix.functions.map(async ({ slug, source_path }) => [
      slug,
      await readFile(new URL(source_path, repositoryRoot), "utf8"),
    ]),
  ),
);

function validate(candidate = matrix, evidence = currentEvidence) {
  return validateGcpReadBatchCandidateMatrix({
    matrix: candidate,
    currentEvidence: evidence,
    sourceFiles,
  });
}

test("candidate evidence binds checked-in source and current v2 capture exactly", () => {
  assert.equal(validate(), true);
  for (const row of matrix.functions) {
    assert.equal(row.current_v2.version_delta, 43);
    assert.equal(row.current_v2.verify_jwt, true);
    assert.deepEqual(
      REQUIRED_DRIFT_BLOCKERS.filter((code) => row.blockers.includes(code)),
      REQUIRED_DRIFT_BLOCKERS,
    );
  }
});

test("candidate evidence rejects zero hashes and source drift", () => {
  const zeroSource = structuredClone(matrix);
  zeroSource.functions[0].source_sha256 = "0".repeat(64);
  assert.throws(() => validate(zeroSource), /zero digest/);

  const zeroBundle = structuredClone(matrix);
  zeroBundle.functions[0].current_v2.canonical_digest = "0".repeat(64);
  zeroBundle.functions[0].live_bundle_sha256 = "0".repeat(64);
  assert.throws(() => validate(zeroBundle), /current v2 evidence binding/);

  const changedSource = { ...sourceFiles, "get-locations": `${sourceFiles["get-locations"]}\n// drift` };
  assert.throws(
    () => validateGcpReadBatchCandidateMatrix({ matrix, currentEvidence, sourceFiles: changedSource }),
    /checked-in source digest drifted/,
  );
});

test("candidate evidence rejects auth none, fake tables, and missing side effects", () => {
  const noAuth = structuredClone(matrix);
  noAuth.functions.find(({ slug }) => slug === "get-locations").auth = "none";
  assert.throws(() => validate(noAuth), /target auth drifted/);

  const fakeTable = structuredClone(matrix);
  fakeTable.source_contracts["investor-og-image"].data_access[0].table = "investor_profiles_fake";
  assert.throws(() => validate(fakeTable), /auth\/table\/column\/side-effect contract/);

  const missingEffect = structuredClone(matrix);
  missingEffect.source_contracts["chat-check-access"].side_effects.pop();
  assert.throws(() => validate(missingEffect), /auth\/table\/column\/side-effect contract/);

  const fakeProvider = structuredClone(matrix);
  fakeProvider.source_contracts["generate-investor-profile"].side_effects[0].service = "generative_ai";
  assert.throws(() => validate(fakeProvider), /auth\/table\/column\/side-effect contract/);
});

test("candidate evidence retains every cutover blocker while current metadata is +43", () => {
  const missingBlocker = structuredClone(matrix);
  missingBlocker.functions[0].blockers = missingBlocker.functions[0].blockers.filter(
    (code) => code !== "SOURCE_METADATA_END_CHECK_MISSING",
  );
  assert.throws(() => validate(missingBlocker), /missing blocker SOURCE_METADATA_END_CHECK_MISSING/);

  const rewrittenVersion = structuredClone(matrix);
  rewrittenVersion.functions[0].current_v2.version_delta = 0;
  assert.throws(() => validate(rewrittenVersion), /current v2 evidence binding/);

  const driftedEvidence = structuredClone(currentEvidence);
  driftedEvidence.entries.find(({ slug }) => slug === "get-locations")
    .bundle_evidence.canonical_digest = "f".repeat(64);
  assert.throws(() => validate(matrix, driftedEvidence), /current v2 evidence binding/);
});
