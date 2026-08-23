import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PATHS = Object.freeze({
  manifest: "migration/manifests/supabase-retirement.v1.json",
  registry: "cloud-run/hushh-tech-app-services/registry/functions.v1.json",
  current: "migration/evidence/supabase-current-live-function-bundles.v2.json",
  traffic: "migration/evidence/supabase-function-traffic-30d.v1.json",
  contracts: "migration/functions/edge-function-terminal-contracts.v1.json",
  terminalSource: "migration/evidence/supabase-terminal-function-source-captures.v1.json",
  retirementRuntime: "cloud-run/hushh-tech-app-services/src/app.js",
  retirementTest: "cloud-run/hushh-tech-app-services/test/app.test.js",
  live: "migration/evidence/gcp-edge-function-uat-live.v1.json",
  output: "migration/evidence/edge-function-terminal-matrix.v1.json",
});
const TERMINAL_STATES = new Set(["PORTED_AND_VERIFIED", "RETIRED"]);
const EXPECTED_LIVE_BUILDS = Object.freeze({
  service: Object.freeze({
    build_id: "fa9d7524-e570-4866-8595-4b8511933de4",
    build_status: "SUCCESS",
    source_commit: "340656ebc6b69ece1e52b3eb5c5f95890f93ddcf",
    source_tree: "8c201788067242d2ba3daacd67ec451b715c7a63",
    source_subtree: "de2e6654bd4b054037221edcab7c229140e9a1ab",
    source_scope: "cloud-run/hushh-tech-app-services",
    source_file_count: 27,
    source_file_set_sha256: "0ffa9c59c2c1f5b21eacb805233f206ec6d500965aae6d07b1e23ea1916f6796",
    source_archive_bucket: "hushh-tech-uat_cloudbuild",
    source_archive_object:
      "source/1787373144.345858-9d4f082bda5b4cfc85bde1dcf3803970.tgz",
    source_archive_generation: "1787373145772638",
    source_archive_sha256: "da192d06439aa24dd60752fb7472c3d2d54e4a8ec3aa4a8484eb13f30102921e",
    image_digest: "sha256:5c5c903297563b901f58a73a38d82ec62a29e39153ec34794848ea5c260b3154",
    image_tag:
      "us-central1-docker.pkg.dev/hushh-tech-uat/cloud-run-source-deploy/hushh-tech-app-services:edge-340656eb",
  }),
  gateway_smoke: Object.freeze({
    build_id: "a7369616-a6b0-42a1-8931-538b8aae84cd",
    build_status: "SUCCESS",
    source_commit: "b997f7c6ce852e18eb135cc4f0d494f4049bb6e5",
    source_tree: "d261e4882fdfbd152312513e2431a6cfb9df7d7a",
    source_subtree: null,
    source_scope: ".",
    source_file_count: 49,
    source_file_set_sha256: "fb98ca6c028f4549c121eac36b7d7ac1bf568163f7e4e6bd13a040abc57a161a",
    source_archive_bucket: "hushh-tech-uat_cloudbuild",
    source_archive_object:
      "source/1787373900.918049-96a02feefdde413fa956f38199b94eb1.tgz",
    source_archive_generation: "1787373902821834",
    source_archive_sha256: "1e4fa33c02baf90810455cecdd14b6de2d0187c7abe123b0f8fb5177bf1b6d09",
    image_digest: "sha256:90a588e9c43e0a399645d2f27fc3d709319340f31d956a4db4ecd2d06cf46f61",
    image_tag:
      "us-central1-docker.pkg.dev/hushh-tech-uat/cloud-run-source-deploy/hushh-tech-edge-gateway-smoke:gateway-b997f7c6",
  }),
});
const EXPECTED_REPOSITORY_BINDINGS = Object.freeze({
  service: Object.freeze({
    commit: "e3e579013473ad09e1ac5e07f36dd3e4f3f462b1",
    tree: "ae5d4829022f800d10b4cb7514526e037a387848",
    relation: "EXACT_BUILD_SCOPE_SUBTREE_AND_FILE_SET",
  }),
  gateway_smoke: Object.freeze({
    commit: "b94b0a751f6062c98704f7017a5be3c118b124fe",
    tree: "10f08d95fd13c64525c0f7f712ac905f561d3529",
    relation: "EXACT_BUILD_FILE_SET",
  }),
});
const EXPECTED_RUNTIME = Object.freeze({
  "get-secrets": Object.freeze({
    service: "hushh-tech-identity-api",
    revision: "hushh-tech-identity-api-retired-340656eb",
    service_account: "hushh-tech-identity-api-uat@hushh-tech-uat.iam.gserviceaccount.com",
    service_owner: "identity-api",
    audience: "https://hushh-tech-identity-api-175298245599.us-central1.run.app",
  }),
  "hushh-location-geocode": Object.freeze({
    service: "hushh-tech-investor-api",
    revision: "hushh-tech-investor-api-geocode-340656eb",
    service_account: "hushh-tech-investor-api-uat@hushh-tech-uat.iam.gserviceaccount.com",
    service_owner: "investor-api",
    audience: "https://hushh-tech-investor-api-175298245599.us-central1.run.app",
  }),
  "nda-admin-fetch": Object.freeze({
    service: "hushh-tech-engagement-api",
    revision: "hushh-tech-engagement-api-nda-frozen-340656eb",
    service_account: "hushh-tech-engagement-api-uat@hushh-tech-uat.iam.gserviceaccount.com",
    service_owner: "engagement-api-worker",
    audience: "https://hushh-tech-engagement-api-175298245599.us-central1.run.app",
  }),
});
const CONTRACT_FIELDS = Object.freeze([
  "auth",
  "body",
  "cache",
  "cors",
  "desired_terminal_state",
  "idempotency",
  "request",
  "response",
  "route",
  "service_owner",
  "side_effects",
  "target_dependencies",
]);

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareUtf8)
      .map((key) => [key, stableValue(value[key])]),
  );
};
export const stableJson = (value) => JSON.stringify(stableValue(value));
export const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const digestRecord = (value) => sha256(stableJson(value));
const isSha256 = (value) => /^[a-f0-9]{64}$/.test(value ?? "");
const isImageDigest = (value) => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const withoutEvidenceDigest = (value) => {
  const copy = structuredClone(value);
  delete copy.evidence_digest;
  return copy;
};
export const sealEvidenceRecord = (value) => ({
  ...withoutEvidenceDigest(value),
  evidence_digest: digestRecord(withoutEvidenceDigest(value)),
});

function exactKeys(value, expected) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      stableJson(Object.keys(value).sort(compareUtf8)) ===
        stableJson([...expected].sort(compareUtf8)),
  );
}

function git(root, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: root,
    encoding,
    maxBuffer: 20 * 1024 * 1024,
  });
}

export function deriveSourceBinding(root, expected, repositoryBinding, kind) {
  const commit = repositoryBinding?.commit;
  let observedCommit;
  let observedTree;
  try {
    observedCommit = git(root, ["rev-parse", `${commit}^{commit}`]).trim();
    observedTree = git(root, ["rev-parse", `${commit}^{tree}`]).trim();
  } catch {
    throw new Error("IMAGE_SOURCE_REPOSITORY_BINDING_UNAVAILABLE");
  }
  if (
    observedCommit !== commit ||
    observedTree !== repositoryBinding.tree ||
    ![
      "EXACT_BUILD_SCOPE_SUBTREE_AND_FILE_SET",
      "EXACT_BUILD_FILE_SET",
    ].includes(repositoryBinding.relation)
  ) {
    throw new Error("IMAGE_SOURCE_REPOSITORY_BINDING_DRIFT");
  }
  try {
    git(root, ["merge-base", "--is-ancestor", commit, "HEAD"]);
  } catch {
    throw new Error("IMAGE_SOURCE_REPOSITORY_BINDING_NOT_REACHABLE");
  }
  const allPaths = git(root, ["ls-tree", "-r", "--name-only", commit])
    .trim()
    .split("\n")
    .filter(Boolean);
  const prefix = kind === "service" ? `${expected.source_scope}/` : "";
  const paths = allPaths
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length))
    .filter((file) =>
      kind === "service"
        ? [".dockerignore", "Dockerfile", "package-lock.json", "package.json"].includes(file) ||
          /^(registry|smoke|src)\//.test(file)
        : file === "package-server.json" ||
          file.startsWith("api/") ||
          [
            "migration/docker/edge-gateway-smoke.Dockerfile",
            "migration/docker/edge-gateway-smoke.gcloudignore",
            "migration/smoke/edge-function-gateway-uat.mjs",
          ].includes(file),
    )
    .sort(compareUtf8);
  const files = paths.map((file) => {
    const bytes = git(root, ["show", `${commit}:${prefix}${file}`], null);
    return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return Object.freeze({
    repository_commit: commit,
    repository_tree: observedTree,
    repository_relation: repositoryBinding.relation,
    source_subtree:
      kind === "service"
        ? git(root, ["rev-parse", `${commit}:${expected.source_scope}`]).trim()
        : null,
    source_file_count: files.length,
    source_file_set_sha256: digestRecord(files),
  });
}

const encodeCanonicalRecord = (fields) => {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(fields.length);
  const chunks = [count];
  for (const field of fields) {
    const bytes = Buffer.from(String(field).normalize("NFC"), "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
};

function digestBundleFiles(files) {
  const ordered = [...files].sort((left, right) =>
    compareUtf8(left.canonical_path, right.canonical_path),
  );
  const hash = crypto.createHash("sha256");
  hash.update(
    encodeCanonicalRecord([
      "hushh-current-function-evidence",
      "uint32be_field_count_then_uint64be_length_prefixed_utf8_fields_v2",
      "bundle-files-v2",
      String(ordered.length),
    ]),
  );
  for (const file of ordered) {
    hash.update(
      encodeCanonicalRecord([
        file.canonical_path,
        file.sha256,
        String(file.bytes),
      ]),
    );
  }
  return hash.digest("hex");
}

function uniqueIndex(entries, label, slugOf = (entry) => entry.slug) {
  if (!Array.isArray(entries)) throw new Error(`${label} must be an array.`);
  const output = new Map();
  for (const entry of entries) {
    const slug = slugOf(entry);
    if (typeof slug !== "string" || !slug || output.has(slug)) {
      throw new Error(`${label} contains a missing or duplicate slug.`);
    }
    output.set(slug, entry);
  }
  return output;
}

function assertExactSet(label, expected, actual) {
  const left = [...expected].sort(compareUtf8);
  const right = [...actual].sort(compareUtf8);
  if (stableJson(left) !== stableJson(right)) {
    throw new Error(`${label} slug set does not match the frozen 112-function inventory.`);
  }
}

function validateContract(slug, contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error(`Terminal contract ${slug} must be an object.`);
  }
  const fields = Object.keys(contract).sort(compareUtf8);
  if (stableJson(fields) !== stableJson([...CONTRACT_FIELDS].sort(compareUtf8))) {
    throw new Error(`Terminal contract ${slug} has a missing or unknown surface.`);
  }
  if (!TERMINAL_STATES.has(contract.desired_terminal_state)) {
    throw new Error(`Terminal contract ${slug} has an invalid desired state.`);
  }
  for (const name of ["auth", "body", "cache", "cors", "idempotency", "request", "response", "route"]) {
    if (!contract[name] || typeof contract[name] !== "object" || Array.isArray(contract[name])) {
      throw new Error(`Terminal contract ${slug}.${name} is incomplete.`);
    }
  }
  if (!Array.isArray(contract.side_effects) || !Array.isArray(contract.target_dependencies)) {
    throw new Error(`Terminal contract ${slug} side effects or dependencies are incomplete.`);
  }
}

function blocker(code, evidence) {
  return Object.freeze({ code, evidence });
}

const EXPECTED_LIVE_CAPTURE = Object.freeze({
  observed_at_utc: "2026-08-22T04:49:19.406865Z",
  source_write_mode: "GCP_UAT_ONLY_NO_SUPABASE_IO_NO_PUBLIC_TRAFFIC",
  smoke_execution: "hushh-tech-edge-gateway-smoke-uat-b6krt",
  pass_log_insert_id: "6a892a49000bc98715e38808",
  cleanup_log_insert_id: "6a892a4a0000b142bfc04b5d",
});
const EXPECTED_LIVE_CLEANUP = Object.freeze({
  smoke_job_exists: false,
  smoke_router_exists: false,
  smoke_nat_exists: false,
  temporary_iam_binding_active: false,
  temporary_iam_role_active: false,
  temporary_iam_role_soft_deleted: true,
  synthetic_firebase_users_retained: 0,
  smoke_image_exists: false,
  smoke_source_archive_exists: false,
});
const EXPECTED_NDA_DATABASE = Object.freeze({
  instance: "hushh-tech-app-pg-uat",
  database: "hushh_tech_app",
  role: "hushh-tech-engagement-api-uat@hushh-tech-uat.iam",
  table: "public.nda_signatures",
  select_columns: ["id", "nda_version", "pdf_url", "signed_at", "user_id"],
  table_wide_select: false,
  dml: false,
  elevated_privileges: false,
  security_definer_routine_count: 0,
  procedure_count: 0,
  owned_schema_count: 0,
  owned_table_count: 0,
  owned_sequence_count: 0,
  owned_routine_count: 0,
  rls_enabled: true,
  rls_forced: true,
  rls_policy: "nda_signatures_engagement_api_select",
  rls_qual: "current_setting('app.firebase_fund_admin',true)='true'",
  schema_verifier_execution: "hushh-tech-schema-data-verifier-uat-f5pkm",
  schema_verifier_evidence_sha256:
    "44a7b19ec9969f089da702fa73d7b3f6762f27ce6d1cc49c4d14355ef7cf5261",
  runtime_verifier_execution: "hushh-tech-schema-data-verifier-uat-8wctw",
});
const EXPECTED_NDA_PROJECTION = Object.freeze({
  response_fields: ["highlighted", "nda_version", "pdf_available", "record_id", "signed_at"],
  raw_pii_fields: [],
  projected_field_count: 5,
});
const EXPECTED_NDA_ADMIN = Object.freeze({
  firebase_user_count: 369,
  boolean_fund_admin_claim_count: 0,
  string_fund_admin_claim_count: 0,
  real_admin_terminal_success_count: 0,
  synthetic_admin_users_retained: 0,
  status: "BLOCKED_REAL_ADMIN_FIREBASE_CLAIM_ABSENT",
});

function expectedRuntime(slug) {
  const expected = EXPECTED_RUNTIME[slug];
  if (!expected) return null;
  return {
    project_id: "hushh-tech-uat",
    region: "us-central1",
    service: expected.service,
    revision: expected.revision,
    service_account: expected.service_account,
    image_digest: EXPECTED_LIVE_BUILDS.service.image_digest,
    ingress: "internal",
    traffic: [{ revision: expected.revision, percent: 100 }],
    labels: { default_off: "true", environment: "uat", migration: "edge-functions" },
    direct_vpc: {
      network: "default",
      subnet: "default",
      egress: "private-ranges-only",
    },
    autoscaling: { min_instances: 0, max_instances: 20 },
    invoker_members: [
      "serviceAccount:hushh-tech-web-uat@hushh-tech-uat.iam.gserviceaccount.com",
    ],
    environment: {
      allowed_google_callers: "hushh-tech-web-uat@hushh-tech-uat.iam.gserviceaccount.com",
      firebase_project_id: "hushh-tech-uat",
      public_stock_quotes_enabled: "false",
      service_owner: expected.service_owner,
      service_audience: expected.audience,
    },
    external_unauthenticated: {
      path: "/readyz",
      status_code: 404,
      content_type: "text/html; charset=UTF-8",
    },
  };
}

function expectedProof(slug) {
  const shared = {
    gateway_build_ref: "gateway_smoke",
    smoke_execution: EXPECTED_LIVE_CAPTURE.smoke_execution,
  };
  if (slug === "hushh-location-geocode") {
    return {
      ...shared,
      same_origin_route: "/functions/v1/hushh-location-geocode",
      same_origin_unauthenticated_status: 401,
      same_origin_success_status: 200,
      compatibility_source: "gcp",
      cache_control: "private, no-store",
      investor_readiness_status: 200,
      investor_readiness_body_status: "ready",
      gateway_nda_frozen_status: 503,
      direct_nda_frozen_status: 503,
      gateway_retired_status: 410,
      direct_retired_status: 410,
      firebase_authority_project_id: "hushh-tech-uat",
      preexisting_firebase_user_count: 369,
      preexisting_fund_admin_boolean_count: 0,
    };
  }
  if (slug === "get-secrets") {
    return {
      ...shared,
      retirement_overlay: true,
      gateway_status: 410,
      direct_status: 410,
      response_code: "FEATURE_RETIRED",
      response_content_type: "application/json; charset=utf-8",
    };
  }
  if (slug === "nda-admin-fetch") {
    return {
      ...shared,
      gateway_status: 503,
      direct_status: 503,
      response_code: "FUNCTION_NOT_MIGRATED",
      database: EXPECTED_NDA_DATABASE,
      pii_projection: EXPECTED_NDA_PROJECTION,
      real_admin: EXPECTED_NDA_ADMIN,
    };
  }
  return null;
}

function runtimeReasons(slug, runtime) {
  const expected = expectedRuntime(slug);
  if (!expected || stableJson(runtime) !== stableJson(expected)) {
    return ["RUNTIME_ATTESTATION_MISMATCH"];
  }
  return [];
}

export function assessLiveProof({
  slug,
  desiredState,
  proof,
  contractDigest,
  sourceCaptureDigest = null,
  liveValidation,
}) {
  const reasons = [];
  if (!proof) return Object.freeze({ complete: false, reasons: ["LIVE_PROOF_ABSENT"] });
  if (proof.evidence_digest !== digestRecord(withoutEvidenceDigest(proof))) {
    reasons.push("LIVE_PROOF_DIGEST_MISMATCH");
  }
  const expectedEntryKeys = [
    "slug",
    "contract_digest",
    "source_capture_digest",
    "registry_state",
    "build_ref",
    "runtime",
    "proof",
    "evidence_digest",
  ];
  if (!exactKeys(proof, expectedEntryKeys)) reasons.push("LIVE_PROOF_SCHEMA_MISMATCH");
  if (proof.contract_digest !== contractDigest) reasons.push("CONTRACT_DIGEST_MISMATCH");
  if (proof.source_capture_digest !== sourceCaptureDigest) {
    reasons.push("SOURCE_CAPTURE_DIGEST_MISMATCH");
  }
  if (proof.build_ref !== "service" || liveValidation?.buildsValid !== true) {
    reasons.push("IMAGE_SOURCE_BINDING_MISMATCH");
  }
  reasons.push(...runtimeReasons(slug, proof.runtime));
  const expectedSlugProof = expectedProof(slug);
  if (!expectedSlugProof || stableJson(proof.proof) !== stableJson(expectedSlugProof)) {
    reasons.push("FUNCTION_PROOF_MISMATCH");
  }
  if (liveValidation?.cleanupValid !== true) reasons.push("CLEANUP_ATTESTATION_MISMATCH");
  if (slug === "get-secrets") {
    if (desiredState !== "RETIRED" || proof.registry_state !== "RETIRED") {
      reasons.push("RETIREMENT_STATE_MISMATCH");
    }
  } else if (slug === "hushh-location-geocode") {
    if (
      desiredState !== "PORTED_AND_VERIFIED" ||
      proof.registry_state !== "PORTED_AND_VERIFIED"
    ) {
      reasons.push("PORT_STATE_MISMATCH");
    }
  } else if (slug === "nda-admin-fetch") {
    if (proof.registry_state !== "INVENTORY_FROZEN") reasons.push("NDA_NOT_FROZEN");
    reasons.push("REAL_ADMIN_FIREBASE_CLAIM_ABSENT");
  }
  return Object.freeze({ complete: reasons.length === 0, reasons: [...new Set(reasons)] });
}

function validateLiveEvidence(live, imageSourceBindings) {
  if (!live) return Object.freeze({ entries: new Map(), buildsValid: false, cleanupValid: false });
  const expectedTopKeys = [
    "schema_version",
    "evidence_id",
    "target",
    "capture",
    "builds",
    "cleanup",
    "entries",
    "evidence_digest",
  ];
  if (
    !exactKeys(live, expectedTopKeys) ||
    live.schema_version !== 2 ||
    live.evidence_id !== "hushh-tech-edge-function-uat-live" ||
    stableJson(live.target) !==
      stableJson({ project_id: "hushh-tech-uat", region: "us-central1" }) ||
    live.evidence_digest !== digestRecord(withoutEvidenceDigest(live))
  ) {
    throw new Error("Live UAT evidence envelope or digest is invalid.");
  }
  let buildsValid = exactKeys(live.builds, ["service", "gateway_smoke"]);
  for (const [name, expected] of Object.entries(EXPECTED_LIVE_BUILDS)) {
    const build = live.builds?.[name];
    const derived = imageSourceBindings?.[name];
    const repositoryBinding = EXPECTED_REPOSITORY_BINDINGS[name];
    buildsValid = Boolean(
      buildsValid &&
        stableJson(build) === stableJson(expected) &&
        derived?.repository_commit === repositoryBinding.commit &&
        derived?.repository_tree === repositoryBinding.tree &&
        derived?.repository_relation === repositoryBinding.relation &&
        derived?.source_subtree === expected.source_subtree &&
        derived?.source_file_count === expected.source_file_count &&
        derived?.source_file_set_sha256 === expected.source_file_set_sha256 &&
        isSha256(expected.source_archive_sha256) &&
        isImageDigest(expected.image_digest),
    );
  }
  const cleanupValid = stableJson(live.cleanup) === stableJson(EXPECTED_LIVE_CLEANUP);
  if (stableJson(live.capture) !== stableJson(EXPECTED_LIVE_CAPTURE)) {
    buildsValid = false;
  }
  const entries = uniqueIndex(live.entries, "live UAT evidence");
  assertExactSet("Live UAT evidence", Object.keys(EXPECTED_RUNTIME), entries.keys());
  return Object.freeze({ entries, buildsValid, cleanupValid });
}

function validateTerminalSourceCaptures(captures, manifestIndex) {
  if (
    captures?.schema_version !== 1 ||
    captures?.source?.project_ref !== "ibsisfnjxeowvdtvgzff" ||
    captures?.source?.tool !== "supabase_cli" ||
    captures?.source?.tool_version !== "2.115.0" ||
    captures?.source?.source_write_mode !== "READ_ONLY_NO_DEPLOYMENT" ||
    captures?.source?.capture_protocol !== "LIST_BEFORE_DOWNLOAD_USE_API_LIST_AFTER" ||
    captures?.canonicalization?.record_encoding !==
      "uint32be_field_count_then_uint64be_length_prefixed_utf8_fields_v2" ||
    captures?.canonicalization?.bundle_digest_algorithm !==
      "sha256_length_prefixed_utf8_bundle_file_records_v2"
  ) {
    throw new Error("Terminal source capture contract is invalid.");
  }
  const index = uniqueIndex(captures.entries, "terminal source captures");
  for (const slug of index.keys()) {
    if (!manifestIndex.has(slug)) {
      throw new Error(`Terminal source capture has unknown slug ${slug}.`);
    }
  }
  return index;
}

function sourceCaptureAssessment({ slug, planned, capture, repositoryVerified }) {
  if (!capture) return Object.freeze({ complete: false, evidence: "absent", digest: null });
  const before = capture.metadata_before;
  const after = capture.metadata_after;
  const files = capture.bundle?.files;
  const started = Date.parse(capture.capture_started_at_utc);
  const completed = Date.parse(capture.capture_completed_at_utc);
  const stableMetadata = stableJson(before) === stableJson(after);
  const fileCount = Array.isArray(files) ? files.length : 0;
  const totalBytes = Array.isArray(files)
    ? files.reduce((sum, file) => sum + Number(file.bytes || 0), 0)
    : 0;
  const safeFiles =
    Array.isArray(files) &&
    files.length > 0 &&
    files.every(
      (file) =>
        typeof file.canonical_path === "string" &&
        file.canonical_path.startsWith(`supabase/functions/${slug}/`) &&
        typeof file.repository_path === "string" &&
        file.repository_path.startsWith("supabase/functions/") &&
        !file.repository_path.includes("..") &&
        /^[a-f0-9]{64}$/.test(file.sha256 ?? "") &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0,
    ) &&
    new Set(files.map((file) => file.canonical_path)).size === files.length &&
    new Set(files.map((file) => file.repository_path)).size === files.length;
  const complete = Boolean(
    stableMetadata &&
      Number.isFinite(started) &&
      Number.isFinite(completed) &&
      completed >= started &&
      before?.function_id === planned.source.function_id &&
      before?.status === "ACTIVE" &&
      Number.isSafeInteger(before?.version) &&
      before.version > 0 &&
      before?.verify_jwt === planned.source.verify_jwt &&
      Number.isSafeInteger(before?.updated_at_epoch_ms) &&
      before.updated_at_epoch_ms > 0 &&
      safeFiles &&
      capture.bundle.file_count === fileCount &&
      capture.bundle.total_bytes === totalBytes &&
      capture.bundle.canonical_digest === digestBundleFiles(files) &&
      repositoryVerified === true,
  );
  return Object.freeze({
    complete,
    evidence: complete ? `stable_version=${before.version}` : "incomplete_or_repository_drift",
    digest: digestRecord(capture),
  });
}

export function buildTerminalMatrix({ manifest, registry, current, traffic, contracts, terminalSource, sourceRepositoryBindings = {}, imageSourceBindings = {}, live = null, fileDigests, retirementProof }) {
  if (
    manifest?.expected_counts?.active_edge_functions !== 112 ||
    current?.observed_counts?.active_functions !== 112 ||
    traffic?.expected_counts?.active_functions !== 112 ||
    contracts?.target?.project_id !== "hushh-tech-uat"
  ) {
    throw new Error("The edge-function inventory or UAT target is not the frozen 112-function contract.");
  }
  const manifestIndex = uniqueIndex(manifest.functions, "manifest", (entry) => entry?.source?.slug);
  const registryIndex = uniqueIndex(registry, "runtime registry");
  const currentIndex = uniqueIndex(current.entries, "current bundle evidence");
  const trafficIndex = uniqueIndex(traffic.entries, "traffic evidence");
  for (const candidate of [registryIndex, currentIndex, trafficIndex]) {
    assertExactSet("Upstream evidence", manifestIndex.keys(), candidate.keys());
  }
  if (manifestIndex.size !== 112) throw new Error("Manifest must contain exactly 112 functions.");
  const terminalSourceIndex = validateTerminalSourceCaptures(terminalSource, manifestIndex);
  const liveValidation = validateLiveEvidence(live, imageSourceBindings);

  const contractEntries = contracts.entries ?? {};
  for (const [slug, contract] of Object.entries(contractEntries)) {
    if (!manifestIndex.has(slug)) throw new Error(`Terminal contract has unknown slug ${slug}.`);
    validateContract(slug, contract);
  }

  const entries = [...manifestIndex.keys()].sort(compareUtf8).map((slug) => {
    const planned = manifestIndex.get(slug);
    const runtime = registryIndex.get(slug);
    const source = currentIndex.get(slug);
    const observedTraffic = trafficIndex.get(slug);
    if (
      runtime.owner_group !== planned.owner_group ||
      runtime.auth_mode !== planned.auth_mode ||
      runtime.final_disposition !== planned.final_disposition ||
      source.function_id !== planned.source.function_id ||
      source.manifest_version !== planned.source.version ||
      source.verify_jwt !== planned.source.verify_jwt
    ) {
      throw new Error(`Frozen identity or runtime registry drift for ${slug}.`);
    }

    const desiredState = planned.final_disposition === "RETIRE_WITH_410"
      ? "RETIRED"
      : "PORTED_AND_VERIFIED";
    const contract = contractEntries[slug] ?? null;
    const contractDigest = contract ? digestRecord(contract) : null;
    const proof = liveValidation.entries.get(slug) ?? null;
    const sourceCapture = terminalSourceIndex.get(slug) ?? null;
    const sourceAssessment = sourceCaptureAssessment({
      slug,
      planned,
      capture: sourceCapture,
      repositoryVerified: sourceRepositoryBindings[slug] === true,
    });
    const blockers = [];

    if (!contract) blockers.push(blocker("TARGET_CONTRACT_MISSING", "terminal contract entry absent"));
    if (contract && contract.desired_terminal_state !== desiredState) {
      blockers.push(blocker("TARGET_DISPOSITION_MISMATCH", contract.desired_terminal_state));
    }

    if (desiredState === "PORTED_AND_VERIFIED") {
      if (!sourceAssessment.complete) {
        if (sourceCapture) {
          blockers.push(blocker("TERMINAL_SOURCE_CAPTURE_INVALID", sourceAssessment.evidence));
        }
        if (source.version_delta !== 0) {
          blockers.push(blocker("SOURCE_VERSION_DRIFT", `manifest=${source.manifest_version};current=${source.current_version}`));
        }
        if (source.capture_status !== "EXTRACTED" || !source.bundle_evidence?.canonical_digest) {
          blockers.push(blocker("SOURCE_BUNDLE_UNAVAILABLE", source.capture_status));
        }
        if (observedTraffic.source_reconstruction_status.startsWith("CUTOVER_BLOCKING_")) {
          blockers.push(blocker("SOURCE_CONTRACT_UNPROVEN", observedTraffic.source_reconstruction_status));
        }
        if (current.cutover_assessment?.metadata_end_check_status !== "PASS") {
          blockers.push(blocker("SOURCE_METADATA_END_CHECK_MISSING", current.cutover_assessment?.metadata_end_check_status));
        }
        if (current.cutover_assessment?.bundle_to_metadata_version_binding_status !== "PROVEN") {
          blockers.push(blocker("SOURCE_BUNDLE_VERSION_UNBOUND", current.cutover_assessment?.bundle_to_metadata_version_binding_status));
        }
        if (current.cutover_assessment?.source_revision_status !== "PROVEN") {
          blockers.push(blocker("SOURCE_REVISION_UNPROVEN", current.cutover_assessment?.source_revision_status));
        }
      }
      if (runtime.migration_state !== "PORTED_AND_VERIFIED") {
        blockers.push(blocker("TARGET_REGISTRY_NOT_ENABLED", runtime.migration_state));
      }
    } else {
      if (observedTraffic.terminal_traffic_status !== "ZERO_TRAFFIC_OBSERVED") {
        blockers.push(blocker("RETIREMENT_TRAFFIC_PRESENT", observedTraffic.request_count));
      }
      if (source.current_version !== source.manifest_version) {
        blockers.push(blocker("RETIREMENT_SOURCE_VERSION_DRIFT", `manifest=${source.manifest_version};current=${source.current_version}`));
      }
    }

    const liveAssessment = contract
      ? assessLiveProof({
          slug,
          desiredState,
          proof,
          contractDigest,
          sourceCaptureDigest:
            desiredState === "RETIRED" ? null : sourceAssessment.digest,
          liveValidation,
        })
      : Object.freeze({ complete: false, reasons: ["TARGET_CONTRACT_MISSING"] });
    if (desiredState === "RETIRED") {
      if (retirementProof !== true) {
        blockers.push(blocker("RETIREMENT_410_PROOF_MISSING", "runtime_or_test_contract_absent"));
      }
      if (contract && !liveAssessment.complete) {
        blockers.push(blocker("UAT_LIVE_TERMINAL_PROOF_MISSING", liveAssessment.reasons.join(",")));
      }
    } else if (contract && !liveAssessment.complete) {
      blockers.push(blocker("UAT_LIVE_TERMINAL_PROOF_MISSING", liveAssessment.reasons.join(",")));
    }
    if (
      slug === "nda-admin-fetch" &&
      proof?.proof?.real_admin?.status !== "PASS"
    ) {
      blockers.push(
        blocker(
          "REAL_ADMIN_FIREBASE_CLAIMS_UNPROVEN",
          proof?.proof?.real_admin?.status ?? "absent",
        ),
      );
    }

    const state = blockers.length === 0 ? desiredState : "BLOCKED";
    return {
      slug,
      owner_group: planned.owner_group,
      auth_mode: planned.auth_mode,
      desired_terminal_state: desiredState,
      observed_state: state,
      source: {
        function_id: source.function_id,
        status: source.status,
        manifest_version: source.manifest_version,
        current_version: source.current_version,
        verify_jwt: source.verify_jwt,
        capture_status: source.capture_status,
        bundle_digest: source.bundle_evidence?.canonical_digest ?? null,
        terminal_capture_digest: sourceAssessment.digest,
        terminal_capture_status: sourceAssessment.complete ? "PROVEN" : sourceAssessment.evidence,
        deployment_binding_sha256: observedTraffic.deployment_binding_sha256,
        traffic_status: observedTraffic.terminal_traffic_status,
        request_count_30d: observedTraffic.request_count,
      },
      target: {
        project_id: "hushh-tech-uat",
        region: "us-central1",
        service_owner: contract?.service_owner ?? planned.owner_group,
        contract_digest: contractDigest,
        live_evidence_digest: proof ? digestRecord(proof) : null,
      },
      blockers: blockers.sort((left, right) => compareUtf8(left.code, right.code)),
    };
  });

  const stateCounts = Object.fromEntries(
    ["BLOCKED", "PORTED_AND_VERIFIED", "RETIRED"].map((state) => [
      state.toLowerCase(),
      entries.filter((entry) => entry.observed_state === state).length,
    ]),
  );
  const blockerCounts = {};
  for (const entry of entries) {
    for (const item of entry.blockers) blockerCounts[item.code] = (blockerCounts[item.code] ?? 0) + 1;
  }
  const output = {
    schema_version: 1,
    evidence_id: "hushh-tech-edge-function-terminal-matrix",
    target: contracts.target,
    source_write_mode: "READ_ONLY_SOURCE_CAPTURE_NO_DEPLOYMENT",
    required_terminal_states: ["PORTED_AND_VERIFIED", "RETIRED"],
    bindings: fileDigests,
    source_capture: {
      completed_at_utc: current.capture.capture_completed_at_utc,
      status: current.cutover_assessment.status,
      traffic_window_end_utc: traffic.capture.window_end_utc,
    },
    summary: {
      total: entries.length,
      desired_ported_and_verified: entries.filter((entry) => entry.desired_terminal_state === "PORTED_AND_VERIFIED").length,
      desired_retired: entries.filter((entry) => entry.desired_terminal_state === "RETIRED").length,
      observed: stateCounts,
      all_terminal: entries.every((entry) => TERMINAL_STATES.has(entry.observed_state)),
      blocker_code_counts: Object.fromEntries(Object.entries(blockerCounts).sort(([left], [right]) => compareUtf8(left, right))),
    },
    entries,
  };
  return { ...output, evidence_digest: sha256(stableJson(output)) };
}

export function readInputs(root = process.cwd()) {
  const bytes = {};
  for (const [name, relativePath] of Object.entries(PATHS)) {
    if (["output", "live"].includes(name)) continue;
    bytes[name] = fs.readFileSync(path.join(root, relativePath));
  }
  const livePath = path.join(root, PATHS.live);
  const liveBytes = fs.existsSync(livePath) ? fs.readFileSync(livePath) : null;
  const parse = (name) => JSON.parse(bytes[name].toString("utf8"));
  const terminalSource = parse("terminalSource");
  const canonicalRoot = fs.realpathSync(root);
  const sourceRepositoryBindings = Object.fromEntries(
    (terminalSource.entries ?? []).map((entry) => {
      const verified =
        Array.isArray(entry?.bundle?.files) &&
        entry.bundle.files.every((file) => {
          try {
            const candidate = path.resolve(root, file.repository_path);
            const actual = fs.realpathSync(candidate);
            if (
              actual !== canonicalRoot &&
              !actual.startsWith(`${canonicalRoot}${path.sep}`)
            ) {
              return false;
            }
            const value = fs.readFileSync(actual);
            return value.length === file.bytes && sha256(value) === file.sha256;
          } catch {
            return false;
          }
        });
      return [entry.slug, verified];
    }),
  );
  const retirementRuntime = bytes.retirementRuntime.toString("utf8");
  const retirementTest = bytes.retirementTest.toString("utf8");
  const imageSourceBindings = Object.fromEntries(
    Object.entries(EXPECTED_LIVE_BUILDS).map(([name, expected]) => [
      name,
      deriveSourceBinding(
        root,
        expected,
        EXPECTED_REPOSITORY_BINDINGS[name],
        name === "service" ? "service" : "gateway",
      ),
    ]),
  );
  return {
    manifest: parse("manifest"),
    registry: parse("registry"),
    current: parse("current"),
    traffic: parse("traffic"),
    contracts: parse("contracts"),
    terminalSource,
    sourceRepositoryBindings,
    imageSourceBindings,
    live: liveBytes ? JSON.parse(liveBytes.toString("utf8")) : null,
    retirementProof:
      /entry\.final_disposition === "RETIRE_WITH_410"[\s\S]{0,220}"FEATURE_RETIRED"[\s\S]{0,160}\b410\b/.test(retirementRuntime) &&
      /legacy-functions\/get-secrets[\s\S]{0,160}response\.status, 410[\s\S]{0,160}"FEATURE_RETIRED"/.test(retirementTest),
    fileDigests: Object.fromEntries([
      ...Object.entries(bytes).map(([name, value]) => [name, { path: PATHS[name], sha256: sha256(value) }]),
      ...(liveBytes ? [["live", { path: PATHS.live, sha256: sha256(liveBytes) }]] : []),
    ]),
  };
}

function render(matrix) {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) {
  const matrix = buildTerminalMatrix(readInputs());
  const outputPath = path.resolve(PATHS.output);
  const expected = render(matrix);
  if (process.argv.includes("--write")) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, expected);
  } else if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== expected) {
    console.error("Edge-function terminal matrix is stale or missing; run with --write.");
    process.exitCode = 1;
  }
  console.log(JSON.stringify(matrix.summary));
  if (process.argv.includes("--require-terminal") && !matrix.summary.all_terminal) {
    console.error(`Edge-function cutover blocked: ${matrix.summary.observed.blocked} of 112 functions are not terminal.`);
    process.exitCode = 1;
  }
}
