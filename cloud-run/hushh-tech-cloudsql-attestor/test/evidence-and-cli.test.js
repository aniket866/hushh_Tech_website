import assert from "node:assert/strict";
import test from "node:test";

import { canonicalHash } from "../src/canonical.js";
import {
  EXPECTED_BOUNDS_QUERY_SHA256,
  EXPECTED_CATALOG_QUERY_SHA256,
  EXPECTED_EXECUTION_CONTRACT_SHA256,
  EXPECTED_QUERY_SET_SHA256,
  EXPECTED_SOURCE_SHA256,
} from "../src/constants.js";
import { executeCli } from "../src/cli.js";
import {
  bindSupervisorEvidence,
  buildCapturedEvidence,
  normalizeCatalogResult,
  serializeEvidence,
  validateEvidence,
} from "../src/evidence.js";
import { runAttestation } from "../src/runner.js";
import { loadBaseline } from "../src/baseline.js";
import { AttestorError, buildConnectionDiagnostic } from "../src/errors.js";
import {
  evidenceCanonicalSha256,
  EXPECTED_SERVICE_IDENTITY_SHA256,
  verifyExternalContext,
} from "../src/verifier.js";
import {
  activeConfig,
  captureWriter,
  catalogResult,
  fakeRuntime,
} from "./helpers.js";

const config = activeConfig({
  contract: EXPECTED_EXECUTION_CONTRACT_SHA256,
  querySet: EXPECTED_QUERY_SET_SHA256,
  source: EXPECTED_SOURCE_SHA256,
});

test("CLI default-off path makes zero runtime-loader calls", async () => {
  const output = captureWriter();
  let loaderCalls = 0;
  const exitCode = await executeCli({
    env: {},
    stdout: output.stdout,
    loadRuntime: async () => {
      loaderCalls += 1;
      throw new Error("must not load");
    },
  });
  const evidence = JSON.parse(output.read());
  assert.equal(exitCode, 0);
  assert.equal(loaderCalls, 0);
  assert.equal(evidence.status, "NOT_EXECUTED");
  assert.equal(evidence.execution.connectorCalls, 0);
  assert.equal(evidence.execution.connectionAttempts, 0);
  assert.equal(evidence.execution.queryStatements, 0);
});

test("CLI never emits a raw runtime error", async () => {
  const output = captureWriter();
  const env = {
    HUSHH_TECH_CLOUDSQL_ATTESTOR_EXECUTE: "true",
    HUSHH_TECH_CLOUDSQL_ATTESTOR_PROJECT: "hushh-tech-uat",
    HUSHH_TECH_CLOUDSQL_ATTESTOR_REGION: "us-central1",
    HUSHH_TECH_CLOUDSQL_ATTESTOR_INSTANCE: "hushh-tech-app-pg-uat",
    HUSHH_TECH_CLOUDSQL_ATTESTOR_DATABASE: "hushh_tech_app",
    HUSHH_TECH_CLOUDSQL_ATTESTOR_IAM_DB_USER:
      "hushh-tech-audit-uat@hushh-tech-uat.iam",
    HUSHH_TECH_CLOUDSQL_ATTESTOR_APPROVED_CONTRACT_SHA256:
      EXPECTED_EXECUTION_CONTRACT_SHA256,
    HUSHH_TECH_CLOUDSQL_ATTESTOR_APPROVED_QUERY_SET_SHA256: EXPECTED_QUERY_SET_SHA256,
    HUSHH_TECH_CLOUDSQL_ATTESTOR_APPROVED_SOURCE_SHA256: EXPECTED_SOURCE_SHA256,
    HUSHH_TECH_CLOUDSQL_ATTESTOR_IMAGE_DIGEST: config.imageDigest,
  };
  const exitCode = await executeCli({
    env,
    stdout: output.stdout,
    loadRuntime: async () => ({}),
    run: async () => {
      throw new Error("connect 10.0.0.9 Bearer raw-secret-token-value principal@example.invalid");
    },
  });
  assert.equal(exitCode, 1);
  assert.doesNotMatch(output.read(), /10\.0\.0\.9|Bearer|principal@|raw-secret/i);
  assert.equal(JSON.parse(output.read()).blockers[0], "RUNTIME_CONNECTION_FAILED");
});

test("CLI emits only the safe connection diagnostic side channel", async () => {
  const output = captureWriter();
  const diagnostics = captureWriter();
  const failure = new AttestorError("RUNTIME_CONNECTION_FAILED");
  failure.attestorDiagnostic = buildConnectionDiagnostic(
    Object.assign(new Error("Bearer raw-secret"), {
      code: "ECONNREFUSED",
      address: "10.0.0.9",
      port: 5432,
    }),
    "POST_CONNECT",
  );
  const exitCode = await executeCli({
    env: {
      HUSHH_TECH_CLOUDSQL_ATTESTOR_EXECUTE: "true",
      HUSHH_TECH_CLOUDSQL_ATTESTOR_PROJECT: "hushh-tech-uat",
      HUSHH_TECH_CLOUDSQL_ATTESTOR_REGION: "us-central1",
      HUSHH_TECH_CLOUDSQL_ATTESTOR_INSTANCE: "hushh-tech-app-pg-uat",
      HUSHH_TECH_CLOUDSQL_ATTESTOR_DATABASE: "hushh_tech_app",
      HUSHH_TECH_CLOUDSQL_ATTESTOR_IAM_DB_USER: "hushh-tech-audit-uat@hushh-tech-uat.iam",
      HUSHH_TECH_CLOUDSQL_ATTESTOR_APPROVED_CONTRACT_SHA256: EXPECTED_EXECUTION_CONTRACT_SHA256,
      HUSHH_TECH_CLOUDSQL_ATTESTOR_APPROVED_QUERY_SET_SHA256: EXPECTED_QUERY_SET_SHA256,
      HUSHH_TECH_CLOUDSQL_ATTESTOR_APPROVED_SOURCE_SHA256: EXPECTED_SOURCE_SHA256,
      HUSHH_TECH_CLOUDSQL_ATTESTOR_IMAGE_DIGEST: config.imageDigest,
    },
    stdout: output.stdout,
    stderr: diagnostics.stdout,
    loadRuntime: async () => ({}),
    run: async () => {
      throw failure;
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(diagnostics.read()).stage, "TCP");
  assert.doesNotMatch(diagnostics.read(), /Bearer|raw-secret/i);
  assert.equal(JSON.parse(output.read()).blockers[0], "RUNTIME_CONNECTION_FAILED");
});

test("rejects raw or extra catalog result fields", () => {
  const result = catalogResult({
    mutateRow(rows) {
      rows[1].definition = "CREATE FUNCTION leaked()";
    },
  });
  assert.throws(
    () => normalizeCatalogResult(result),
    (error) => error.code === "CATALOG_RESULT_INVALID",
  );
});

test("capture and evidence hashes reject forged result or root state", async () => {
  const { runtime } = fakeRuntime();
  const evidence = await runAttestation({ config, runtime });
  assert.equal(validateEvidence(evidence), true);

  const forgedResult = structuredClone(evidence);
  forgedResult.collections[1].rowCount += 1;
  const { evidenceSha256: _ignored, ...forgedPayload } = forgedResult;
  forgedResult.evidenceSha256 = canonicalHash(forgedPayload);
  assert.throws(
    () => validateEvidence(forgedResult),
    (error) => error.code === "EVIDENCE_INVALID",
  );

  const forgedRoot = structuredClone(evidence);
  forgedRoot.evidenceSha256 = "0".repeat(64);
  assert.throws(
    () => validateEvidence(forgedRoot),
    (error) => error.code === "EVIDENCE_INVALID",
  );
});

test("external context rejects a self-resealed forged capture", async () => {
  const { runtime } = fakeRuntime();
  const evidence = bindSupervisorEvidence(await runAttestation({ config, runtime }));
  const trustedContext = {
    actualImageDigest: evidence.bindings.imageDigest,
    serviceIdentitySha256: EXPECTED_SERVICE_IDENTITY_SHA256,
    cloudRunExecutionSha256: "1".repeat(64),
    immutableLogEntrySha256: "2".repeat(64),
    loggedEvidenceSha256: evidenceCanonicalSha256(evidence),
    executionContractSha256: EXPECTED_EXECUTION_CONTRACT_SHA256,
    querySetSha256: EXPECTED_QUERY_SET_SHA256,
    boundsQuerySha256: EXPECTED_BOUNDS_QUERY_SHA256,
    catalogQuerySha256: EXPECTED_CATALOG_QUERY_SHA256,
    sourceSha256: EXPECTED_SOURCE_SHA256,
  };
  assert.equal(verifyExternalContext({ evidence, trustedContext }).valid, true);

  const forged = structuredClone(evidence);
  forged.collections[1].rowCount += 1;
  forged.captureSha256 = canonicalHash({
    checks: forged.checks,
    collections: forged.collections,
    baseline: forged.baseline,
  });
  const { evidenceSha256: _oldHash, ...forgedPayload } = forged;
  forged.evidenceSha256 = canonicalHash(forgedPayload);
  assert.equal(validateEvidence(forged), true);
  assert.throws(
    () => verifyExternalContext({ evidence: forged, trustedContext }),
    (error) => error.code === "EXTERNAL_CONTEXT_INVALID",
  );
  assert.throws(
    () =>
      verifyExternalContext({
        evidence,
        trustedContext: { ...trustedContext, actualImageDigest: `sha256:${"b".repeat(64)}` },
      }),
    (error) => error.code === "EXTERNAL_CONTEXT_INVALID",
  );
});

test("serialized evidence is bounded and contains no raw principal, IP, URL, or secret", async () => {
  const { runtime } = fakeRuntime();
  const output = serializeEvidence(await runAttestation({ config, runtime }));
  assert.ok(Buffer.byteLength(output, "utf8") < 16_384);
  assert.doesNotMatch(output, /@|\b(?:\d{1,3}\.){3}\d{1,3}\b|postgres(?:ql)?:\/\/|Bearer/i);
  assert.doesNotMatch(output, /hushh-tech-audit-uat/);
});

test("baseline drift blocks an otherwise safe captured catalog", () => {
  const baseline = loadBaseline();
  const result = catalogResult({
    baselineObserved: { ...baseline.expectedCatalog, publicTables: 71 },
  });
  const normalized = normalizeCatalogResult(result);
  const evidence = buildCapturedEvidence({
    normalized,
    imageDigest: `sha256:${"a".repeat(64)}`,
    cleanup: {
      connectorCreated: true,
      poolCreated: true,
      connectorCloseCalled: true,
      poolCloseCalled: true,
    },
  });
  assert.equal(evidence.status, "BLOCKED");
  assert.equal(evidence.baseline.status, "BLOCKED");
  assert.ok(evidence.blockers.includes("EXPECTED_CATALOG_DRIFT"));
  assert.equal(new Set(evidence.blockers).size, evidence.blockers.length);
  assert.equal(validateEvidence(evidence), true);
});

test("accepts SQL baseline comparisons whose set-like arrays are key-sorted", () => {
  const baseline = loadBaseline();
  const result = catalogResult({
    baselineObserved: { ...baseline.expectedCatalog, publicTables: 71 },
    mutateRow(rows) {
      const comparison = rows[0].baseline;
      rows[0].baseline = {
        ...comparison,
        matched: [...comparison.matched].sort(),
        drifted: [...comparison.drifted].sort((left, right) => left.key.localeCompare(right.key)),
      };
    },
  });
  const normalized = normalizeCatalogResult(result);
  assert.equal(normalized.baseline.status, "BLOCKED");
  assert.deepEqual(normalized.baseline.drifted, [
    { key: "publicTables", expected: 70, observed: 71 },
  ]);
});
