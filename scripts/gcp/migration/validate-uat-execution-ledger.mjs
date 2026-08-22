#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash } from "./canonical-hash.mjs";
import { UAT_TARGET } from "./uat-schema-data-executor.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const EVIDENCE_BUCKET = "hushh-tech-migration-evidence-uat";
const BOOTSTRAP_BUCKET = "hushh-tech-uat_cloudbuild";
const FINAL_BUNDLE_SHA256 = "5410cf080ff4a2a3272e33366d17d796810711e79f21aa01c83f6f982a29c107";
const PITR_OBSERVED_AT = "2026-08-22T02:36:28.743Z";

function expectedOperation({
  operationId,
  phase,
  sqlOutcome,
  blockerCode = null,
  startTime,
  endTime,
  bucket,
  name,
  generation,
  sha256,
  prefixManifestSha256 = null,
  retention = "DELETED_AFTER_EXECUTION",
}) {
  return Object.freeze({
    operationId,
    phase,
    providerStatus: "DONE",
    sqlOutcome,
    atomic: true,
    blockerCode,
    startTime,
    endTime,
    object: Object.freeze({ bucket, name, generation, sha256, prefixManifestSha256 }),
    retention,
  });
}

const EXPECTED_OPERATIONS = Object.freeze([
  expectedOperation({ operationId: "d63ad994-9a85-4c25-aec2-b42200000032", phase: "PHASE00_ROLE_BASELINE", sqlOutcome: "ROLLED_BACK", blockerCode: "ROLE_ATTRIBUTE_PRIVILEGE_DENIED", startTime: "2026-08-22T00:19:36.775Z", endTime: "2026-08-22T00:19:47.131Z", bucket: BOOTSTRAP_BUCKET, name: "cloudsql-bootstrap/role-bootstrap-bf1a5776291172152cb57eb9b70183d55cf449dc711f354545a5c5312df278a9.sql", generation: "1787357960387143", sha256: "bf1a5776291172152cb57eb9b70183d55cf449dc711f354545a5c5312df278a9" }),
  expectedOperation({ operationId: "ec1d0dbc-7c68-4a10-bf98-3d3c00000032", phase: "PHASE00_ROLE_BASELINE", sqlOutcome: "ROLLED_BACK", blockerCode: "DEFAULT_PRIVILEGE_DENIED", startTime: "2026-08-22T00:20:21.923Z", endTime: "2026-08-22T00:20:32.230Z", bucket: BOOTSTRAP_BUCKET, name: "cloudsql-bootstrap/role-bootstrap-9865bdce1747b429349d3807c042c19dad28f09f5ca5e4aa86eac0c217d97305.sql", generation: "1787358020522585", sha256: "9865bdce1747b429349d3807c042c19dad28f09f5ca5e4aa86eac0c217d97305" }),
  expectedOperation({ operationId: "a0c907d4-fbad-45a7-bcea-d0be00000032", phase: "PHASE00_ROLE_BASELINE", sqlOutcome: "COMMITTED", startTime: "2026-08-22T00:20:58.486Z", endTime: "2026-08-22T00:21:08.872Z", bucket: BOOTSTRAP_BUCKET, name: "cloudsql-bootstrap/role-bootstrap-2b80e4d5e9758db2480547256576f35893ca68fabd0e5e0b26f5d866e6d302ac.sql", generation: "1787358057114445", sha256: "2b80e4d5e9758db2480547256576f35893ca68fabd0e5e0b26f5d866e6d302ac" }),
  expectedOperation({ operationId: "fecb6adb-c272-4864-a148-eceb00000032", phase: "PHASE00_ROLE_BASELINE", sqlOutcome: "ROLLED_BACK", blockerCode: "CLOUDSQL_MANDATORY_ROLE_REVOKE_DENIED", startTime: "2026-08-22T00:24:04.183Z", endTime: "2026-08-22T00:24:14.538Z", bucket: BOOTSTRAP_BUCKET, name: "cloudsql-bootstrap/role-bootstrap-c3a0c95f0a96435462c3b506d72d57632ae5ccf51ee760bd58d71c9da8052750.sql", generation: "1787358242628781", sha256: "c3a0c95f0a96435462c3b506d72d57632ae5ccf51ee760bd58d71c9da8052750" }),
  expectedOperation({ operationId: "40eb718d-08b9-4d89-9f63-233900000032", phase: "PHASE10_IDENTITY_FOUNDATION", sqlOutcome: "ROLLED_BACK", blockerCode: "SET_ROLE_DENIED", startTime: "2026-08-22T01:10:31.474Z", endTime: "2026-08-22T01:10:41.883Z", bucket: EVIDENCE_BUCKET, name: "cloudsql-import/uat/660ae217db245f2e608e19c5c21afc01c1d393cd53e12efc2c387f99b2c28b4c/01-10_firebase_identity_context.sql", generation: "1787360612583710", sha256: "4619119a9669ec1d25c9509466a8928e7e3b357d3974d7b54feb667889d8668a", prefixManifestSha256: "660ae217db245f2e608e19c5c21afc01c1d393cd53e12efc2c387f99b2c28b4c" }),
  expectedOperation({ operationId: "9805232c-f1bd-4288-8107-863100000032", phase: "TEMP_SCHEMA_OWNER_MEMBERSHIP", sqlOutcome: "COMMITTED", startTime: "2026-08-22T01:19:47.277Z", endTime: "2026-08-22T01:19:57.693Z", bucket: BOOTSTRAP_BUCKET, name: "cloudsql-bootstrap/schema-data-a8eda459c12f8f5d3fc928f0bbaad270aa96ffd9361bfeef61be07de208a8531.sql", generation: "1787361578340348", sha256: "a8eda459c12f8f5d3fc928f0bbaad270aa96ffd9361bfeef61be07de208a8531" }),
  expectedOperation({ operationId: "09e8bec8-c74f-46e4-9532-751e00000032", phase: "PHASE10_IDENTITY_FOUNDATION", sqlOutcome: "ROLLED_BACK", blockerCode: "SCHEMA_PERMISSION_DENIED", startTime: "2026-08-22T01:20:19.183Z", endTime: "2026-08-22T01:20:29.531Z", bucket: EVIDENCE_BUCKET, name: "cloudsql-import/uat/660ae217db245f2e608e19c5c21afc01c1d393cd53e12efc2c387f99b2c28b4c/01-10_firebase_identity_context.sql", generation: "1787360612583710", sha256: "4619119a9669ec1d25c9509466a8928e7e3b357d3974d7b54feb667889d8668a", prefixManifestSha256: "660ae217db245f2e608e19c5c21afc01c1d393cd53e12efc2c387f99b2c28b4c" }),
  expectedOperation({ operationId: "70aaf1b3-60e0-454d-919c-fcb000000032", phase: "TEMP_SCHEMA_OWNER_MEMBERSHIP", sqlOutcome: "COMMITTED", startTime: "2026-08-22T01:24:43.595Z", endTime: "2026-08-22T01:24:53.920Z", bucket: BOOTSTRAP_BUCKET, name: "cloudsql-bootstrap/schema-data-f0780f1e836c85aaae21683cdf699bd5f375d5700f80d823618b2fd674d97946.sql", generation: "1787361882087207", sha256: "f0780f1e836c85aaae21683cdf699bd5f375d5700f80d823618b2fd674d97946" }),
  expectedOperation({ operationId: "19f0beab-4194-4138-91c5-673c00000032", phase: "PHASE10_IDENTITY_FOUNDATION", sqlOutcome: "ROLLED_BACK", blockerCode: "MIGRATION_RUN_RLS_DENIED", startTime: "2026-08-22T01:25:14.055Z", endTime: "2026-08-22T01:25:24.388Z", bucket: EVIDENCE_BUCKET, name: "cloudsql-import/uat/f36ec211bd6e4ff87f919bddb7e54e93389b27a647fac65f58ae1934f240cf13/01-10_firebase_identity_context.sql", generation: "1787361852466653", sha256: "4619119a9669ec1d25c9509466a8928e7e3b357d3974d7b54feb667889d8668a", prefixManifestSha256: "f36ec211bd6e4ff87f919bddb7e54e93389b27a647fac65f58ae1934f240cf13" }),
  expectedOperation({ operationId: "7379f326-222e-44a1-9128-e9ea00000032", phase: "PHASE10_IDENTITY_FOUNDATION", sqlOutcome: "COMMITTED", startTime: "2026-08-22T01:28:16.901Z", endTime: "2026-08-22T01:28:27.238Z", bucket: EVIDENCE_BUCKET, name: "cloudsql-import/uat/cc131633b2703acb57a2355ffc8b88a0c4110d910048d6085cd43fd29db9ebc3/01-10_firebase_identity_context.sql", generation: "1787362075803909", sha256: "ee8d653e799762ab0a3a5800448b7de5ac331819fe2a7711036c5b853607ad11", prefixManifestSha256: "cc131633b2703acb57a2355ffc8b88a0c4110d910048d6085cd43fd29db9ebc3" }),
  expectedOperation({ operationId: "e1fe14fd-eadb-4abd-8c91-a88e00000032", phase: "PHASE20_RAW_SCHEMA", sqlOutcome: "ROLLED_BACK", blockerCode: "EXTENSIONS_SCHEMA_ABSENT", startTime: "2026-08-22T01:28:44.667Z", endTime: "2026-08-22T01:28:54.982Z", bucket: EVIDENCE_BUCKET, name: "cloudsql-import/uat/cc131633b2703acb57a2355ffc8b88a0c4110d910048d6085cd43fd29db9ebc3/02-20_raw_parity_schema.sql", generation: "1787362075002261", sha256: "38b65562d5c13204a1a8db955f1877e51e1b5775d1a9d398fec5fab84ffd2093", prefixManifestSha256: "cc131633b2703acb57a2355ffc8b88a0c4110d910048d6085cd43fd29db9ebc3" }),
  expectedOperation({ operationId: "915e12ad-001e-4665-abf8-e2d300000032", phase: "PHASE20_RAW_SCHEMA", sqlOutcome: "COMMITTED", startTime: "2026-08-22T01:31:44.249Z", endTime: "2026-08-22T01:31:54.671Z", bucket: EVIDENCE_BUCKET, name: "cloudsql-import/uat/e1b142a7d76b17a07ef291f3157e63d4c3accace3e6d10b6d6306339515ac4af/02-20_raw_parity_schema.sql", generation: "1787362285870912", sha256: "a36210fbf5efc7382c1f0f9fea8e89fbbd3bf4e269cfb1eeb2ab5c36c1234204", prefixManifestSha256: "e1b142a7d76b17a07ef291f3157e63d4c3accace3e6d10b6d6306339515ac4af" }),
  expectedOperation({ operationId: "583c0521-ce0b-4c43-98f3-6bf000000032", phase: "DATA_AND_IDENTITY", sqlOutcome: "COMMITTED", startTime: "2026-08-22T01:32:15.123Z", endTime: "2026-08-22T01:32:35.645Z", bucket: EVIDENCE_BUCKET, name: "cloudsql-import/uat/e1b142a7d76b17a07ef291f3157e63d4c3accace3e6d10b6d6306339515ac4af/12-data-and-identity.sql", generation: "1787362298108545", sha256: "1994ca75f9391aa4e4c5014f55facf1c357c9f7a72205a07214c1ccb0d16d975", prefixManifestSha256: "e1b142a7d76b17a07ef291f3157e63d4c3accace3e6d10b6d6306339515ac4af" }),
  expectedOperation({ operationId: "13ad3ecb-8a21-421c-8072-a58100000032", phase: "PHASE30_CONSTRAINTS_TRIGGERS_INDEXES", sqlOutcome: "ROLLED_BACK", blockerCode: "TRIGGER_FUNCTION_EXECUTE_DENIED", startTime: "2026-08-22T01:33:00.631Z", endTime: "2026-08-22T01:33:11.009Z", bucket: EVIDENCE_BUCKET, name: "cloudsql-import/uat/e1b142a7d76b17a07ef291f3157e63d4c3accace3e6d10b6d6306339515ac4af/03-30_constraints_triggers_indexes.sql", generation: "1787362284445316", sha256: "219a3c7fba7c2bae0dcc19fd3bde0281b42f0458c989de6be06e00538e53ed66", prefixManifestSha256: "e1b142a7d76b17a07ef291f3157e63d4c3accace3e6d10b6d6306339515ac4af" }),
  expectedOperation({ operationId: "8da835fa-9e30-43ec-b661-610500000032", phase: "PHASE30_CONSTRAINTS_TRIGGERS_INDEXES", sqlOutcome: "COMMITTED", startTime: "2026-08-22T01:36:08.222Z", endTime: "2026-08-22T01:36:18.551Z", bucket: EVIDENCE_BUCKET, name: "cloudsql-import/uat/63b2d7638a684c131d30d9a046eae15b81f63b0a4ee710551450a234e88b89d1/03-30_constraints_triggers_indexes.sql", generation: "1787362544202045", sha256: "6cf5b8403d0d63e5fa57d60b264966081daa8d9d36c901dc025137aaad5a04e9", prefixManifestSha256: "63b2d7638a684c131d30d9a046eae15b81f63b0a4ee710551450a234e88b89d1" }),
  expectedOperation({ operationId: "c1d5bbce-3f74-474f-b6a9-0d3400000032", phase: "PHASE40_RLS_POLICIES", sqlOutcome: "COMMITTED", startTime: "2026-08-22T01:36:33.008Z", endTime: "2026-08-22T01:36:43.394Z", bucket: EVIDENCE_BUCKET, name: "cloudsql-import/uat/63b2d7638a684c131d30d9a046eae15b81f63b0a4ee710551450a234e88b89d1/04-40_firebase_rls_policies.sql", generation: "1787362544238585", sha256: "aae2bfda94f8248899c6132048fe94920d718315bd1093eb04fae2b70194acda", prefixManifestSha256: "63b2d7638a684c131d30d9a046eae15b81f63b0a4ee710551450a234e88b89d1" }),
  expectedOperation({ operationId: "b23853d6-03bb-4a2e-ab0e-0a5000000032", phase: "PHASE50_PRIVILEGES", sqlOutcome: "COMMITTED", startTime: "2026-08-22T01:37:00.830Z", endTime: "2026-08-22T01:37:11.249Z", bucket: EVIDENCE_BUCKET, name: "cloudsql-import/uat/63b2d7638a684c131d30d9a046eae15b81f63b0a4ee710551450a234e88b89d1/05-50_target_privileges.sql", generation: "1787362542416037", sha256: "f00d0bf5e39a16ae690b2678087680667952b411ab361074b568398c98a49a0d", prefixManifestSha256: "63b2d7638a684c131d30d9a046eae15b81f63b0a4ee710551450a234e88b89d1" }),
  expectedOperation({ operationId: "d876a1f6-d408-4b39-8ef7-bcdf00000032", phase: "PHASE60_CATALOG_VALIDATION", sqlOutcome: "ROLLED_BACK", blockerCode: "RESIDUAL_SCHEMA_OWNER_MEMBERSHIP", startTime: "2026-08-22T01:37:26.169Z", endTime: "2026-08-22T01:37:36.516Z", bucket: EVIDENCE_BUCKET, name: "cloudsql-import/uat/63b2d7638a684c131d30d9a046eae15b81f63b0a4ee710551450a234e88b89d1/06-60_catalog_validation.sql", generation: "1787362543968193", sha256: "b6ddc8f0fd6d73e0496e7f33be40fc2b9e3984f638b8cef524ff3e03875521ef", prefixManifestSha256: "63b2d7638a684c131d30d9a046eae15b81f63b0a4ee710551450a234e88b89d1" }),
  expectedOperation({ operationId: "2d5ef54b-4406-4a2b-92ae-790e00000032", phase: "PHASE60_CATALOG_VALIDATION", sqlOutcome: "ROLLED_BACK", blockerCode: "VERIFIER_SCHEMA_USAGE_DENIED", startTime: "2026-08-22T01:38:40.544Z", endTime: "2026-08-22T01:38:50.858Z", bucket: EVIDENCE_BUCKET, name: "cloudsql-import/uat/2c3b4ee7fa96cb0371b4c520b6d969b341d94a457d48c2d3a431c77d4d58f936/06-60_catalog_validation.sql", generation: "1787362700121349", sha256: "b6ddc8f0fd6d73e0496e7f33be40fc2b9e3984f638b8cef524ff3e03875521ef", prefixManifestSha256: "2c3b4ee7fa96cb0371b4c520b6d969b341d94a457d48c2d3a431c77d4d58f936" }),
  expectedOperation({ operationId: "5663b2f9-a54a-48a0-8140-980400000032", phase: "PHASE60_CATALOG_VALIDATION", sqlOutcome: "ROLLED_BACK", blockerCode: "REVIEWED_EXTENSION_OR_IDENTITY_KEY_ABSENT", startTime: "2026-08-22T01:40:31.836Z", endTime: "2026-08-22T01:40:42.123Z", bucket: EVIDENCE_BUCKET, name: `cloudsql-import/uat/${FINAL_BUNDLE_SHA256}/06-60_catalog_validation.sql`, generation: "1787362812206369", sha256: "3581283b6b643403e1c97b1596ca743dc6d000c300d30ab7922c9119ceb369c6", prefixManifestSha256: FINAL_BUNDLE_SHA256, retention: "RETAINED_FUTURE_REPLAY_COPY" }),
  expectedOperation({ operationId: "1f181e21-3c27-464d-8115-a61600000032", phase: "PHASE00_REVIEWED_EXTENSIONS", sqlOutcome: "COMMITTED", startTime: "2026-08-22T01:42:13.294Z", endTime: "2026-08-22T01:42:23.689Z", bucket: BOOTSTRAP_BUCKET, name: "cloudsql-bootstrap/schema-data-7ebe62c167d8b732495b833a50f7a06e8581bc8d48fa58476651fb5cef95987a.sql", generation: "1787362931872326", sha256: "7ebe62c167d8b732495b833a50f7a06e8581bc8d48fa58476651fb5cef95987a" }),
  expectedOperation({ operationId: "a44c1d18-9c9d-405c-ae4f-959900000032", phase: "PHASE60_CATALOG_VALIDATION", sqlOutcome: "COMMITTED", startTime: "2026-08-22T01:42:38.395Z", endTime: "2026-08-22T01:42:48.757Z", bucket: EVIDENCE_BUCKET, name: `cloudsql-import/uat/${FINAL_BUNDLE_SHA256}/06-60_catalog_validation.sql`, generation: "1787362812206369", sha256: "3581283b6b643403e1c97b1596ca743dc6d000c300d30ab7922c9119ceb369c6", prefixManifestSha256: FINAL_BUNDLE_SHA256, retention: "RETAINED_FUTURE_REPLAY_COPY" }),
]);
const OPERATION_IDS = Object.freeze(EXPECTED_OPERATIONS.map(({ operationId }) => operationId));
const REQUIRED_COMMITTED_PHASES = Object.freeze([
  "PHASE00_ROLE_BASELINE",
  "TEMP_SCHEMA_OWNER_MEMBERSHIP",
  "PHASE10_IDENTITY_FOUNDATION",
  "PHASE20_RAW_SCHEMA",
  "DATA_AND_IDENTITY",
  "PHASE30_CONSTRAINTS_TRIGGERS_INDEXES",
  "PHASE40_RLS_POLICIES",
  "PHASE50_PRIVILEGES",
  "PHASE00_REVIEWED_EXTENSIONS",
  "PHASE60_CATALOG_VALIDATION",
]);
const EXPECTED_PRE_APPLY_ATTESTATION = Object.freeze({
  execution: "hushh-tech-cloudsql-attestor-uat-dxp8t",
  timestamp: "2026-08-22T00:29:50.337131Z",
  captureSha256: "94f219e30bc75367fbb9d3df7639dec84effd8682418c313cdffa17008bcc424",
  evidenceSha256: "ba52ac25a77276fe47046ea8eca69344b75e4b10e1a08d6f235561fa4224431c",
  targetEmpty: true,
  applicationRelations: 0,
  applicationSequences: 0,
  applicationFunctions: 0,
  applicationTriggers: 0,
});
const EXPECTED_IDENTITY_EXECUTION = Object.freeze({
  execution: "hushh-tech-identity-migration-uat-kxx8j",
  job: "hushh-tech-identity-migration-uat",
  mode: "IMPORT",
  project: "hushh-tech-uat",
  serviceAccount: "hushh-tech-id-migrate-uat@hushh-tech-uat.iam.gserviceaccount.com",
  startTime: "2026-08-22T01:08:19.050276Z",
  completionTime: "2026-08-22T01:10:14.675128Z",
  outcome: "COMMITTED",
  productionAccessDenied: true,
  artifact: Object.freeze({
    bucket: EVIDENCE_BUCKET,
    name: "identity/uat/a85f406c2852964a951740964efb02b8c9eb75d86f0db2a6568c171f4dada689.json",
    generation: "1787360583064294",
    sha256: "a85f406c2852964a951740964efb02b8c9eb75d86f0db2a6568c171f4dada689",
  }),
  imported: 369,
  linkedExisting: 0,
  finalUserCount: 369,
  uidParitySha256: "8b656c26d36021dbf67a8fadc9f9dcc15675d8f6f28c5fcd64ff34b55cac76f2",
  mappingSha256: "92a0162c5e96ff2ed4ddb425f93336b0ea43ac63f9338c61bec665d1c3523969",
  importEvidenceSha256: "3be18fac230b40b9d30af9093a31f18cb4035acc2b33872b855d72b414a09c65",
  sourceCaptureSha256: "3757b1a1497ab148f6e525af9e075bf25a05b095798e90a2cc113584c9d79e56",
  foreignKeyParitySha256: "bc9d6b450bc768785d2d70298755cba497b020fc79e2fd09d7abb7ae307b1c41",
  firebaseProjectIdSha256: "abec08edbb397f1a747f48dcf3a9287b823eedc8ca970f5f0d8cf5cc44446a1b",
  firebaseIssuerSha256: "50fcc4b3cbecea994802350d5ede046b89c43a9be4dd09482d9eded49bf7fff7",
  firebaseAudienceSha256: "abec08edbb397f1a747f48dcf3a9287b823eedc8ca970f5f0d8cf5cc44446a1b",
});
const EXPECTED_INITIAL_POST_APPLY_VERIFICATION = Object.freeze({
  execution: "hushh-tech-schema-data-verifier-uat-xjhmc",
  timestamp: "2026-08-22T01:51:09.637743Z",
  status: "CAPTURED",
  evidenceSha256: "56091c1f9ffc36389c33a54e5571e04b7f98466807dcb8f01fa78764fd094cd4",
  sourceManifestSha256: "02f520f613addcd7e9b1bc692c39b628241a3c656c463e6f15ab1276b6a6aad1",
  tableParitySha256: "2ac7d6aad6c2580ff608f8c6fd3353ff7b60a27fc3046901922d521429aa75a3",
  identityMappingSha256: "92a0162c5e96ff2ed4ddb425f93336b0ea43ac63f9338c61bec665d1c3523969",
  results: Object.freeze({
    tableCount: 70,
    rowCount: 45_042,
    rowHashParity: true,
    identityTotal: 369,
    identityActive: 369,
    identityUnclaimed: 0,
    foreignKeys: 37,
    referencedRows: 2363,
    forcedRlsTables: 70,
    publicPolicies: 280,
    operationalPolicies: 19,
    executorPolicies: 0,
    publicTriggers: 24,
    explicitIndexes: 121,
    triggerFunctions: 8,
    identityFunctions: 2,
    migrationFunctions: 1,
    reviewedExtensions: 3,
    runtimeTableSelectCount: 70,
    runtimeElevatedPrivileges: false,
    runtimeAdminOption: false,
    webRuntimeMembership: true,
  }),
});
const EXPECTED_RETAINED_OBJECTS = Object.freeze([
  Object.freeze({ purpose: "PHASE10_IDENTITY_FOUNDATION", bucket: EVIDENCE_BUCKET, name: `cloudsql-import/uat/${FINAL_BUNDLE_SHA256}/01-10_firebase_identity_context.sql`, generation: "1787362812142866", sha256: "ee8d653e799762ab0a3a5800448b7de5ac331819fe2a7711036c5b853607ad11", bytes: 20_703 }),
  Object.freeze({ purpose: "PHASE20_RAW_SCHEMA", bucket: EVIDENCE_BUCKET, name: `cloudsql-import/uat/${FINAL_BUNDLE_SHA256}/02-20_raw_parity_schema.sql`, generation: "1787362811259745", sha256: "a36210fbf5efc7382c1f0f9fea8e89fbbd3bf4e269cfb1eeb2ab5c36c1234204", bytes: 64_204 }),
  Object.freeze({ purpose: "DATA_AND_IDENTITY", bucket: EVIDENCE_BUCKET, name: `cloudsql-import/uat/${FINAL_BUNDLE_SHA256}/12-data-and-identity.sql`, generation: "1787362823902120", sha256: "1994ca75f9391aa4e4c5014f55facf1c357c9f7a72205a07214c1ccb0d16d975", bytes: 69_705_936 }),
  Object.freeze({ purpose: "PHASE30_CONSTRAINTS_TRIGGERS_INDEXES", bucket: EVIDENCE_BUCKET, name: `cloudsql-import/uat/${FINAL_BUNDLE_SHA256}/03-30_constraints_triggers_indexes.sql`, generation: "1787362810202457", sha256: "6cf5b8403d0d63e5fa57d60b264966081daa8d9d36c901dc025137aaad5a04e9", bytes: 62_046 }),
  Object.freeze({ purpose: "PHASE40_RLS_POLICIES", bucket: EVIDENCE_BUCKET, name: `cloudsql-import/uat/${FINAL_BUNDLE_SHA256}/04-40_firebase_rls_policies.sql`, generation: "1787362810185913", sha256: "aae2bfda94f8248899c6132048fe94920d718315bd1093eb04fae2b70194acda", bytes: 72_398 }),
  Object.freeze({ purpose: "PHASE50_PRIVILEGES", bucket: EVIDENCE_BUCKET, name: `cloudsql-import/uat/${FINAL_BUNDLE_SHA256}/05-50_target_privileges.sql`, generation: "1787362809960034", sha256: "f00d0bf5e39a16ae690b2678087680667952b411ab361074b568398c98a49a0d", bytes: 37_604 }),
  Object.freeze({ purpose: "PHASE60_CATALOG_VALIDATION", bucket: EVIDENCE_BUCKET, name: `cloudsql-import/uat/${FINAL_BUNDLE_SHA256}/06-60_catalog_validation.sql`, generation: "1787362812206369", sha256: "3581283b6b643403e1c97b1596ca743dc6d000c300d30ab7922c9119ceb369c6", bytes: 30_620 }),
  Object.freeze({ purpose: "BUNDLE_MANIFEST", bucket: EVIDENCE_BUCKET, name: `cloudsql-import/uat/${FINAL_BUNDLE_SHA256}/import-bundle.manifest.json`, generation: "1787362811018385", sha256: "81b90c4e1d88bcf5a242fff8ddd849455f3355880283a65b9a14f78e570d5da3", bytes: 2_081 }),
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, expected, code) {
  if (canonicalHash(Object.keys(value ?? {}).sort()) !== canonicalHash([...expected].sort())) fail(code);
}

export function buildPinnedUatExecutionLedger() {
  const payload = {
    version: 1,
    kind: "HUSHH_TECH_UAT_SCHEMA_DATA_LIVE_EXECUTION_LEDGER",
    state: "VERIFIED_COMPLETE",
    target: UAT_TARGET,
    preApplyAttestation: EXPECTED_PRE_APPLY_ATTESTATION,
    identityExecution: EXPECTED_IDENTITY_EXECUTION,
    cloudSqlOperations: EXPECTED_OPERATIONS,
    postApplyVerification: EXPECTED_INITIAL_POST_APPLY_VERIFICATION,
    retainedFutureReplayBundle: {
      manifestSha256: FINAL_BUNDLE_SHA256,
      sourceManifestSha256: "02f520f613addcd7e9b1bc692c39b628241a3c656c463e6f15ab1276b6a6aad1",
      identityArtifactSha256: "a85f406c2852964a951740964efb02b8c9eb75d86f0db2a6568c171f4dada689",
      catalogEvidenceSha256: "ba52ac25a77276fe47046ea8eca69344b75e4b10e1a08d6f235561fa4224431c",
      replayKey: "23c656b86552921f356dfc65d7021c6a588277e500be8e35fdcc89a325eb4a86",
      disposition: "FUTURE_REPLAY_ONLY_NOT_EXECUTED_AS_A_WHOLE_NOT_A_ROLLBACK",
      objects: EXPECTED_RETAINED_OBJECTS,
    },
    recovery: {
      classification: "PITR_CAPABILITY_ONLY_NOT_A_BOUND_ROLLBACK",
      pointInTimeRecoveryEnabled: true,
      transactionLogRetentionDays: 7,
      observedAt: PITR_OBSERVED_AT,
      exactPreApplyRestoreLocator: null,
      exactPreApplyRestoreTimestamp: null,
      restoreProcedureBound: false,
      rollbackReady: false,
      automaticDestructiveRollback: false,
      retainedFutureReplayBundleIsRollback: false,
    },
    cleanup: {
      temporaryCloudBuildObjects: 0,
      supersededBundlePrefixes: 0,
      temporaryBucketViewerBindings: 0,
      temporaryIdentityProjectBindings: 0,
      localSensitiveArtifacts: 0,
      retainedFutureReplayObjects: 8,
      identityMigrationExecutionMode: "DISABLED",
      schemaDataVerifierExecutionMode: "false",
    },
  };
  return validateUatExecutionLedger({ ...payload, ledgerSha256: canonicalHash(payload) });
}

export function validateUatExecutionLedger(ledger) {
  if (
    ledger?.version !== 1 ||
    ledger?.kind !== "HUSHH_TECH_UAT_SCHEMA_DATA_LIVE_EXECUTION_LEDGER" ||
    ledger?.state !== "VERIFIED_COMPLETE" ||
    canonicalHash(ledger?.target) !== canonicalHash(UAT_TARGET) ||
    !Array.isArray(ledger?.cloudSqlOperations) ||
    ledger.cloudSqlOperations.length !== OPERATION_IDS.length ||
    !Array.isArray(ledger?.retainedFutureReplayBundle?.objects) ||
    ledger.retainedFutureReplayBundle.objects.length !== 8 ||
    !SHA256.test(ledger?.ledgerSha256 ?? "")
  ) fail("EXECUTION_LEDGER_INVALID");
  exactKeys(ledger, ["version", "kind", "state", "target", "preApplyAttestation", "identityExecution", "cloudSqlOperations", "postApplyVerification", "retainedFutureReplayBundle", "recovery", "cleanup", "ledgerSha256"], "EXECUTION_LEDGER_INVALID");
  if (
    canonicalHash(ledger.preApplyAttestation) !== canonicalHash(EXPECTED_PRE_APPLY_ATTESTATION) ||
    canonicalHash(ledger.identityExecution) !== canonicalHash(EXPECTED_IDENTITY_EXECUTION) ||
    canonicalHash(ledger.postApplyVerification) !== canonicalHash(EXPECTED_INITIAL_POST_APPLY_VERIFICATION)
  ) fail("EXECUTION_LEDGER_EVIDENCE_BINDING_MISMATCH");
  if (canonicalHash(ledger.cloudSqlOperations.map(({ operationId }) => operationId)) !== canonicalHash(OPERATION_IDS)) {
    fail("EXECUTION_LEDGER_OPERATION_SET_MISMATCH");
  }
  const committedPhases = new Set();
  let previousStart = "";
  for (const [operationIndex, operation] of ledger.cloudSqlOperations.entries()) {
    exactKeys(operation, ["operationId", "phase", "providerStatus", "sqlOutcome", "atomic", "blockerCode", "startTime", "endTime", "object", "retention"], "EXECUTION_LEDGER_OPERATION_INVALID");
    exactKeys(operation.object, ["bucket", "name", "generation", "sha256", "prefixManifestSha256"], "EXECUTION_LEDGER_OBJECT_INVALID");
    if (
      operation.providerStatus !== "DONE" ||
      !["COMMITTED", "ROLLED_BACK"].includes(operation.sqlOutcome) ||
      operation.atomic !== true ||
      !GENERATION.test(operation.object.generation ?? "") ||
      !SHA256.test(operation.object.sha256 ?? "") ||
      !["DELETED_AFTER_EXECUTION", "RETAINED_FUTURE_REPLAY_COPY"].includes(operation.retention) ||
      typeof operation.startTime !== "string" ||
      operation.startTime <= previousStart ||
      typeof operation.endTime !== "string" ||
      operation.endTime < operation.startTime ||
      (operation.sqlOutcome === "COMMITTED") !== (operation.blockerCode === null)
    ) fail("EXECUTION_LEDGER_OPERATION_INVALID");
    if (canonicalHash(operation) !== canonicalHash(EXPECTED_OPERATIONS[operationIndex])) {
      fail("EXECUTION_LEDGER_OPERATION_EVIDENCE_MISMATCH");
    }
    previousStart = operation.startTime;
    const bundleMatch = /^cloudsql-import\/uat\/([a-f0-9]{64})\//.exec(operation.object.name);
    if (bundleMatch) {
      if (operation.object.bucket !== "hushh-tech-migration-evidence-uat" || operation.object.prefixManifestSha256 !== bundleMatch[1]) {
        fail("EXECUTION_LEDGER_OBJECT_INVALID");
      }
    } else if (
      operation.object.bucket !== "hushh-tech-uat_cloudbuild" ||
      !operation.object.name.startsWith("cloudsql-bootstrap/") ||
      operation.object.prefixManifestSha256 !== null
    ) fail("EXECUTION_LEDGER_OBJECT_INVALID");
    if (operation.sqlOutcome === "COMMITTED") committedPhases.add(operation.phase);
  }
  if (REQUIRED_COMMITTED_PHASES.some((phase) => !committedPhases.has(phase))) {
    fail("EXECUTION_LEDGER_PHASE_INCOMPLETE");
  }
  const finalOperation = ledger.cloudSqlOperations.at(-1);
  if (finalOperation.operationId !== "a44c1d18-9c9d-405c-ae4f-959900000032" || finalOperation.phase !== "PHASE60_CATALOG_VALIDATION" || finalOperation.sqlOutcome !== "COMMITTED") {
    fail("EXECUTION_LEDGER_FINAL_PHASE_INVALID");
  }
  const bundle = ledger.retainedFutureReplayBundle;
  if (
    bundle.manifestSha256 !== FINAL_BUNDLE_SHA256 ||
    bundle.disposition !== "FUTURE_REPLAY_ONLY_NOT_EXECUTED_AS_A_WHOLE_NOT_A_ROLLBACK" ||
    bundle.sourceManifestSha256 !== "02f520f613addcd7e9b1bc692c39b628241a3c656c463e6f15ab1276b6a6aad1" ||
    bundle.identityArtifactSha256 !== "a85f406c2852964a951740964efb02b8c9eb75d86f0db2a6568c171f4dada689" ||
    bundle.catalogEvidenceSha256 !== "ba52ac25a77276fe47046ea8eca69344b75e4b10e1a08d6f235561fa4224431c" ||
    bundle.replayKey !== "23c656b86552921f356dfc65d7021c6a588277e500be8e35fdcc89a325eb4a86" ||
    canonicalHash(bundle.objects) !== canonicalHash(EXPECTED_RETAINED_OBJECTS)
  ) fail("EXECUTION_LEDGER_RETAINED_BUNDLE_INVALID");
  exactKeys(bundle, ["manifestSha256", "sourceManifestSha256", "identityArtifactSha256", "catalogEvidenceSha256", "replayKey", "disposition", "objects"], "EXECUTION_LEDGER_RETAINED_BUNDLE_INVALID");
  if (
    ledger.recovery?.classification !== "PITR_CAPABILITY_ONLY_NOT_A_BOUND_ROLLBACK" ||
    ledger.recovery?.pointInTimeRecoveryEnabled !== true ||
    ledger.recovery?.transactionLogRetentionDays !== 7 ||
    ledger.recovery?.exactPreApplyRestoreLocator !== null ||
    ledger.recovery?.exactPreApplyRestoreTimestamp !== null ||
    ledger.recovery?.restoreProcedureBound !== false ||
    ledger.recovery?.rollbackReady !== false ||
    ledger.recovery?.automaticDestructiveRollback !== false ||
    ledger.recovery?.retainedFutureReplayBundleIsRollback !== false ||
    ledger.recovery?.observedAt !== PITR_OBSERVED_AT
  ) fail("EXECUTION_LEDGER_RECOVERY_CLAIM_INVALID");
  exactKeys(ledger.recovery, ["classification", "pointInTimeRecoveryEnabled", "transactionLogRetentionDays", "observedAt", "exactPreApplyRestoreLocator", "exactPreApplyRestoreTimestamp", "restoreProcedureBound", "rollbackReady", "automaticDestructiveRollback", "retainedFutureReplayBundleIsRollback"], "EXECUTION_LEDGER_RECOVERY_CLAIM_INVALID");
  if (
    ledger.cleanup?.temporaryCloudBuildObjects !== 0 ||
    ledger.cleanup?.supersededBundlePrefixes !== 0 ||
    ledger.cleanup?.temporaryBucketViewerBindings !== 0 ||
    ledger.cleanup?.temporaryIdentityProjectBindings !== 0 ||
    ledger.cleanup?.localSensitiveArtifacts !== 0 ||
    ledger.cleanup?.retainedFutureReplayObjects !== 8 ||
    ledger.cleanup?.identityMigrationExecutionMode !== "DISABLED" ||
    ledger.cleanup?.schemaDataVerifierExecutionMode !== "false"
  ) fail("EXECUTION_LEDGER_CLEANUP_INVALID");
  exactKeys(ledger.cleanup, ["temporaryCloudBuildObjects", "supersededBundlePrefixes", "temporaryBucketViewerBindings", "temporaryIdentityProjectBindings", "localSensitiveArtifacts", "retainedFutureReplayObjects", "identityMigrationExecutionMode", "schemaDataVerifierExecutionMode"], "EXECUTION_LEDGER_CLEANUP_INVALID");
  const { ledgerSha256, ...payload } = ledger;
  if (canonicalHash(payload) !== ledgerSha256) fail("EXECUTION_LEDGER_DIGEST_MISMATCH");
  return ledger;
}

function main() {
  const path = process.argv[2]
    ? resolve(process.argv[2])
    : fileURLToPath(new URL("../../../migration/contracts/uat-schema-data-execution-ledger.v1.json", import.meta.url));
  const ledger = validateUatExecutionLedger(JSON.parse(readFileSync(path, "utf8")));
  process.stdout.write(`${JSON.stringify({ status: "CAPTURED", ledgerSha256: ledger.ledgerSha256, operationCount: ledger.cloudSqlOperations.length, committedCount: ledger.cloudSqlOperations.filter(({ sqlOutcome }) => sqlOutcome === "COMMITTED").length, rolledBackCount: ledger.cloudSqlOperations.filter(({ sqlOutcome }) => sqlOutcome === "ROLLED_BACK").length, rollbackReady: ledger.recovery.rollbackReady })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "BLOCKED", blocker: error?.code ?? "EXECUTION_LEDGER_VALIDATION_FAILED" })}\n`);
    process.exitCode = 1;
  }
}
