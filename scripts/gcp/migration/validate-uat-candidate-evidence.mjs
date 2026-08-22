#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash } from "./canonical-hash.mjs";
import { validateExpected } from "../../../migration/cloud-run/hushh-tech-schema-data-verifier-uat/index.mjs";

export const PINNED_CANDIDATE_EVIDENCE_SHA256 =
  "3e8c0dd7f40b47887fd9cce8002f988305003d793ad9276771f4f63433020938";

const TARGET = Object.freeze({
  project: "hushh-tech-uat",
  region: "us-central1",
  instance: "hushh-tech-app-pg-uat",
  database: "hushh_tech_app",
});
const RUNTIME_COMMIT = "bf7538e4016318bcc236418733a9a396b829be11";
const RUNTIME_TREE = "6c53040a17f4ffb8f6d3b3297228a2f8fea96adb";
const IMAGE_DIGEST = "sha256:05b739aba984752648a2e747ed71148f9b552de04a73328ae407167fc44603cd";
const IMAGE_URI = `us-central1-docker.pkg.dev/hushh-tech-uat/cloud-run-source-deploy/hushh-tech-schema-data-verifier-uat@${IMAGE_DIGEST}`;
const SECTION_HASHES = Object.freeze({
  ndaBoundaryOperation: "1c8bd8c32afe9728f7edcc46470e955ba0da0bddbebb91be3c2725d0ca353099",
  verifierBuild: "c955c818000de84455be102f27f0b2c5c4f367aba4f3be4e43447f679d5b1d5f",
  readOnlyVerifierHistory: "7010e79f72b982ed5cc96c53af5941b782fd292e8f9e3daab8579f7e7d5c3780",
  job: "573b4fea6c57b4bf128b7efe5ed66f25f41690d3d1fbdfe4e062432e9a2b6b18",
  execution: "99ac4eeb74b9d0cf0df67c1381f0d344096ea8a3ff6ddb56c503e46d91dd7e67",
  mutationSafety: "2d901529c3e8401d9e8ce39a8d2eccdc25b0a36e35129f3e36ff26b52fdb7381",
  cleanup: "591462d1eaf725d62f62bd309db88686c379644856f38194af191c60bdced28f",
});
const MAIN_LOG_SHA256 = "4f3e17a60099c60a5a23d4712fa489faa0d785470d92df90fd17dc170c6d6e94";
const DIAGNOSTIC_LOG_SHA256 = "95a218b4a08ccd049aedea83ede7988e88a3182f4a639c36c23c17c6ee660ff3";
const VERIFIER_PAYLOAD_SHA256 = "b5c24220268e59dd12a41bef105c664e6c5b7dd6abb517cd46f51c7706a74805";
const BUILD_CONTEXT_FILES = Object.freeze([
  ".dockerignore",
  "Dockerfile",
  "expected-manifest.v1.json",
  "index.mjs",
  "package-lock.json",
  "package.json",
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, expected, code) {
  if (canonicalHash(Object.keys(value ?? {}).sort()) !== canonicalHash([...expected].sort())) fail(code);
}

function buildLocalContext(root) {
  const files = BUILD_CONTEXT_FILES.map((name) => {
    const bytes = readFileSync(join(root, name));
    return Object.freeze({
      name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });
  const input = files.map(({ name, bytes, sha256 }) => `${name}\0${bytes}\0${sha256}\n`).join("");
  return Object.freeze({ files, contextSha256: createHash("sha256").update(input).digest("hex") });
}

function validateVerifierPayload(payload, expected, expectedPayloadSha256 = VERIFIER_PAYLOAD_SHA256) {
  if (
    payload?.version !== 1 ||
    payload?.kind !== "HUSHH_TECH_UAT_SCHEMA_DATA_POST_VERIFY" ||
    payload?.status !== "CAPTURED" ||
    canonicalHash(payload?.target) !== canonicalHash(TARGET) ||
    payload?.verifierExpectedSha256 !== expected.expectedSha256 ||
    payload?.sourceManifestSha256 !== expected.sourceManifest.manifestSha256 ||
    payload?.sourceKeyManifestSha256 !== expected.sourceKeys.manifestSha256 ||
    payload?.tableCount !== 70 ||
    payload?.rowCount !== 45_042 ||
    payload?.rowHashParity !== true ||
    payload?.keyHashParity !== true ||
    !Array.isArray(payload?.tableParity) ||
    payload.tableParity.length !== 70 ||
    payload?.evidenceSha256 !== expectedPayloadSha256
  ) fail("CANDIDATE_VERIFIER_PAYLOAD_INVALID");
  const expectedParity = expected.sourceManifest.tables.map((table, index) => ({
    name: table.name,
    rowCount: table.rowCount,
    rowSha256: table.rowSha256,
    keySha256: expected.sourceKeys.tables[index].keySha256,
  }));
  if (
    canonicalHash(payload.tableParity) !== canonicalHash(expectedParity) ||
    payload.tableParitySha256 !== canonicalHash(expectedParity)
  ) fail("CANDIDATE_TABLE_PARITY_MISMATCH");
  const { evidenceSha256, ...unsignedPayload } = payload;
  if (canonicalHash(unsignedPayload) !== evidenceSha256) fail("CANDIDATE_VERIFIER_DIGEST_MISMATCH");
  if (
    payload.identity?.total !== 369 ||
    payload.identity?.active !== 369 ||
    payload.identity?.unclaimed !== 0 ||
    payload.identity?.foreignKeys !== 37 ||
    payload.identity?.referencedRows !== 2_363 ||
    payload.identity?.mappingSha256 !== expected.identity.mappingSha256 ||
    payload.identity?.importEvidenceSha256 !== expected.identity.importEvidenceSha256 ||
    canonicalHash(payload.identity?.authority) !== canonicalHash({
      projectIdSha256: expected.identity.firebaseProjectIdSha256,
      issuerSha256: expected.identity.firebaseIssuerSha256,
      audienceSha256: expected.identity.firebaseAudienceSha256,
    })
  ) fail("CANDIDATE_IDENTITY_PARITY_MISMATCH");
  if (canonicalHash(payload.catalog) !== canonicalHash(expected.expectedCatalog)) {
    fail("CANDIDATE_CATALOG_PARITY_MISMATCH");
  }
  const nda = payload.access?.engagementNdaAdminFetch;
  const role = "hushh-tech-engagement-api-uat@hushh-tech-uat.iam";
  if (
    payload.access?.totalPublicPolicies !== 281 ||
    nda?.ready !== true ||
    nda?.roleExists !== true ||
    canonicalHash(nda?.selectColumns) !== canonicalHash([
      "public.nda_signatures.id",
      "public.nda_signatures.nda_version",
      "public.nda_signatures.pdf_url",
      "public.nda_signatures.signed_at",
      "public.nda_signatures.user_id",
    ]) ||
    nda?.tableWideSelect !== false ||
    nda?.publicDml !== false ||
    nda?.elevatedPrivileges !== false ||
    nda?.rlsPolicyExact !== true ||
    canonicalHash(nda?.rlsPolicy) !== canonicalHash({
      name: "nda_signatures_engagement_api_select",
      command: "SELECT",
      permissive: true,
      roles: [role],
      qual: "current_setting('app.firebase_fund_admin',true)='true'",
      withCheck: null,
    }) ||
    canonicalHash(nda?.missing) !== canonicalHash([])
  ) fail("CANDIDATE_NDA_BOUNDARY_MISMATCH");
  const runtime = payload.access?.engagementRuntime;
  if (
    runtime?.ready !== true ||
    runtime?.current_user !== role ||
    ["rolsuper", "rolcreaterole", "rolcreatedb", "rolreplication", "rolbypassrls", "can_create_database", "can_create_temporary_tables", "can_create_public_schema"].some((field) => runtime?.[field] !== false) ||
    ["application_schema_create_count", "inherited_privileged_role_count", "non_dml_table_privilege_count", "executable_security_definer_routine_count", "executable_procedure_count", "accessible_table_rls_disabled_count", "accessible_table_rls_not_forced_count", "owned_application_schema_count", "owned_application_table_count", "owned_application_sequence_count", "owned_application_routine_count"].some((field) => runtime?.[field] !== 0) ||
    runtime?.executable_application_routine_count !== 164 ||
    canonicalHash(runtime?.effective_table_dml_privileges) !== canonicalHash([]) ||
    canonicalHash(runtime?.effective_sequence_privileges) !== canonicalHash([]) ||
    canonicalHash(runtime?.executable_security_definer_routines) !== canonicalHash([]) ||
    canonicalHash(runtime?.reasons) !== canonicalHash([]) ||
    canonicalHash(runtime?.effective_column_privileges) !== canonicalHash([
      "id", "nda_version", "pdf_url", "signed_at", "user_id",
    ].map((column) => ({ schema: "public", table: "nda_signatures", column, privilege: "SELECT", kind: "r", grantable: false })))
  ) fail("CANDIDATE_ENGAGEMENT_RUNTIME_MISMATCH");
  if (canonicalHash(payload.runtime) !== canonicalHash({
    webRuntimeMembership: true,
    adminOption: false,
    tableSelectCount: 70,
    elevatedPrivileges: false,
  })) fail("CANDIDATE_WEB_RUNTIME_MISMATCH");
  return payload;
}

export function validateUatCandidateEvidence(
  evidence,
  {
    verifierRoot,
    expectedEvidenceSha256 = PINNED_CANDIDATE_EVIDENCE_SHA256,
    expectedMainLogSha256 = MAIN_LOG_SHA256,
    expectedDiagnosticLogSha256 = DIAGNOSTIC_LOG_SHA256,
    expectedVerifierPayloadSha256 = VERIFIER_PAYLOAD_SHA256,
  } = {},
) {
  if (
    evidence?.version !== 2 ||
    evidence?.kind !== "HUSHH_TECH_UAT_SCHEMA_DATA_CANDIDATE_EVIDENCE" ||
    evidence?.evidenceSha256 !== expectedEvidenceSha256 ||
    canonicalHash(evidence?.target) !== canonicalHash(TARGET) ||
    evidence?.runtimeCandidate?.commit !== RUNTIME_COMMIT ||
    evidence?.runtimeCandidate?.tree !== RUNTIME_TREE ||
    evidence?.runtimeCandidate?.cleanCheckout !== true ||
    evidence?.runtimeCandidate?.dirtyPathCount !== 0
  ) fail("CANDIDATE_EVIDENCE_INVALID");
  exactKeys(evidence, ["version", "kind", "target", "runtimeCandidate", "ndaBoundaryOperation", "verifierBuild", "readOnlyVerifierHistory", "deployment", "mutationSafety", "cleanup", "evidenceSha256"], "CANDIDATE_EVIDENCE_INVALID");
  const { evidenceSha256, ...unsignedEvidence } = evidence;
  if (canonicalHash(unsignedEvidence) !== evidenceSha256) fail("CANDIDATE_EVIDENCE_DIGEST_MISMATCH");
  for (const [section, sha256] of Object.entries(SECTION_HASHES)) {
    const value = section === "job" || section === "execution" ? evidence.deployment?.[section] : evidence[section];
    if (canonicalHash(value) !== sha256) fail(`CANDIDATE_${section.toUpperCase()}_MISMATCH`);
  }
  if (
    evidence.ndaBoundaryOperation?.operationId !== "112ffe84-afbf-41c0-b2b3-f87900000032" ||
    evidence.ndaBoundaryOperation?.object?.generation !== "1787367841243086" ||
    evidence.ndaBoundaryOperation?.object?.sha256 !== "42a5cc0f03bd41baf986a3c49c8052a5ce08089c8b8449905b1d5bd22df2b97f" ||
    evidence.ndaBoundaryOperation?.sqlSource?.commit !== "c60ba54a9218cef7fa07c8552b35e692445bb5e5" ||
    evidence.ndaBoundaryOperation?.sqlSource?.tree !== "d0fc8bebbfecd1fe0f6798c0dea54c3f4e984cfb" ||
    evidence.ndaBoundaryOperation?.sqlOutcome !== "COMMITTED_SELF_VERIFIED_TRANSACTION"
  ) fail("CANDIDATE_NDA_OPERATION_MISMATCH");
  if (
    evidence.verifierBuild?.buildId !== "16ba7551-59a0-4c8e-b411-adc23fe3c9f4" ||
    evidence.verifierBuild?.status !== "SUCCESS" ||
    evidence.verifierBuild?.source?.generation !== "1787370598858352" ||
    evidence.verifierBuild?.source?.archiveSha256 !== "31c7ccd5f2f80fe348ba9f50a711c551f7a5f195b7f5e67c4bf24aa3b3f7effd" ||
    evidence.verifierBuild?.source?.retention !== "DELETED_AFTER_PROVENANCE_CAPTURE" ||
    evidence.verifierBuild?.image?.digest !== IMAGE_DIGEST ||
    evidence.verifierBuild?.image?.uri !== IMAGE_URI
  ) fail("CANDIDATE_BUILD_PROVENANCE_MISMATCH");
  const localRoot = verifierRoot ?? fileURLToPath(new URL("../../../migration/cloud-run/hushh-tech-schema-data-verifier-uat", import.meta.url));
  const localContext = buildLocalContext(resolve(localRoot));
  if (
    canonicalHash(localContext.files) !== canonicalHash(evidence.verifierBuild.context.files) ||
    localContext.contextSha256 !== evidence.verifierBuild.context.contextSha256 ||
    localContext.contextSha256 !== "81b9380755052d86cba22ff875a5797b5e75cc0fe0e13300070bc12c7832fd9a"
  ) fail("CANDIDATE_CLEAN_CONTEXT_MISMATCH");
  const expected = validateExpected(JSON.parse(readFileSync(
    join(localRoot, "expected-manifest.v1.json"),
    "utf8",
  )));
  const main = evidence.deployment?.mainLog;
  const diagnostic = evidence.deployment?.runtimeDiagnosticLog;
  if (
    main?.entrySha256 !== expectedMainLogSha256 ||
    canonicalHash(main?.entry) !== main.entrySha256 ||
    diagnostic?.entrySha256 !== expectedDiagnosticLogSha256 ||
    canonicalHash(diagnostic?.entry) !== diagnostic.entrySha256 ||
    main?.entry?.insertId !== "6a891d2f0001c8d08ec0858d" ||
    diagnostic?.entry?.insertId !== "6a891d2f0001834b1db78d81"
  ) fail("CANDIDATE_LOG_BINDING_MISMATCH");
  const payload = validateVerifierPayload(main.entry.jsonPayload, expected, expectedVerifierPayloadSha256);
  if (
    diagnostic.entry.jsonPayload?.kind !== "HUSHH_TECH_UAT_ENGAGEMENT_RUNTIME_DIAGNOSTIC" ||
    diagnostic.entry.jsonPayload?.status !== "CAPTURED" ||
    canonicalHash(diagnostic.entry.jsonPayload?.engagementRuntime) !== canonicalHash(payload.access.engagementRuntime)
  ) fail("CANDIDATE_DIAGNOSTIC_MISMATCH");
  if (
    evidence.deployment.job?.image !== IMAGE_URI ||
    evidence.deployment.job?.generation !== "7" ||
    evidence.deployment.job?.observedGeneration !== "7" ||
    evidence.deployment.job?.env?.[0]?.name !== "HUSHH_TECH_SCHEMA_DATA_VERIFY" ||
    evidence.deployment.job?.env?.[0]?.value !== "false" ||
    evidence.deployment.execution?.image !== IMAGE_URI ||
    evidence.deployment.execution?.succeededCount !== 1 ||
    evidence.deployment.execution?.failedCount !== 0 ||
    evidence.deployment.execution?.env?.[0]?.value !== "true"
  ) fail("CANDIDATE_EXECUTION_IMAGE_MISMATCH");
  const safety = evidence.mutationSafety;
  if (
    safety?.identityMigrationJob?.env?.find(({ name }) => name === "EXECUTION_MODE")?.value !== "DISABLED" ||
    safety?.verifierJob?.env?.find(({ name }) => name === "HUSHH_TECH_SCHEMA_DATA_VERIFY")?.value !== "false" ||
    safety?.triggerInventory?.cloudScheduler?.directMigrationJobReferenceCount !== 0 ||
    safety?.triggerInventory?.cloudScheduler?.inventorySha256 !== canonicalHash(safety.triggerInventory.cloudScheduler.jobs) ||
    safety?.triggerInventory?.cloudScheduler?.inventorySha256 !== "27ae7e6b87cf3ac6da23cc3700ca4cbde1ed0b8ef5d30e00ac1642576fd11619" ||
    safety?.triggerInventory?.cloudBuild?.directMigrationJobReferenceCount !== 0 ||
    safety?.triggerInventory?.cloudBuild?.inventorySha256 !== canonicalHash(safety.triggerInventory.cloudBuild.triggers) ||
    safety?.triggerInventory?.cloudBuild?.inventorySha256 !== "6d08047a610f63d0e803e91a6f253cc95587f6eb4b462722e048adcd74076238" ||
    safety?.triggerInventory?.eventarc?.serviceEnabled !== false ||
    safety?.triggerInventory?.eventarc?.triggerState !== "NO_SERVICE_NO_TRIGGER"
  ) fail("CANDIDATE_MUTATION_SAFETY_MISMATCH");
  if (
    evidence.cleanup?.verifierStagingObjectCount !== 0 ||
    evidence.cleanup?.temporaryVerifierTagCount !== 0 ||
    evidence.cleanup?.cloudSqlBootstrapObjectCount !== 0 ||
    evidence.cleanup?.ndaBoundaryObjectCount !== 0 ||
    evidence.cleanup?.evidenceBucketCloudSqlServiceAgentBindingCount !== 0 ||
    evidence.cleanup?.protectedSourceRowTempArtifactCount !== 0
  ) fail("CANDIDATE_CLEANUP_MISMATCH");
  return evidence;
}

function main() {
  const path = process.argv[2]
    ? resolve(process.argv[2])
    : fileURLToPath(new URL("../../../migration/contracts/uat-schema-data-candidate-evidence.v2.json", import.meta.url));
  const evidence = validateUatCandidateEvidence(JSON.parse(readFileSync(path, "utf8")));
  process.stdout.write(`${JSON.stringify({
    status: "CAPTURED",
    evidenceSha256: evidence.evidenceSha256,
    execution: evidence.deployment.execution.name.split("/").at(-1),
    imageDigest: evidence.verifierBuild.image.digest,
    tableCount: evidence.deployment.mainLog.entry.jsonPayload.tableCount,
    rowCount: evidence.deployment.mainLog.entry.jsonPayload.rowCount,
    keyHashParity: evidence.deployment.mainLog.entry.jsonPayload.keyHashParity,
  })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "BLOCKED", blocker: error?.code ?? "CANDIDATE_EVIDENCE_VALIDATION_FAILED" })}\n`);
    process.exitCode = 1;
  }
}
