import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ZERO_SHA256 = "0".repeat(64);

export const REQUIRED_DRIFT_BLOCKERS = Object.freeze([
  "SOURCE_BUNDLE_VERSION_UNBOUND",
  "SOURCE_METADATA_END_CHECK_MISSING",
  "SOURCE_REVISION_UNPROVEN",
  "SOURCE_VERSION_DRIFT",
]);

const OVERVIEW_READS = Object.freeze([
  Object.freeze({ table: "fund_stripe_payment_requests", operations: ["read"], columns: ["id", "user_id", "request_reference", "selected_fund", "status", "commitment_amount", "first_payment_amount", "class_a_units", "class_b_units", "class_c_units", "risk_flags", "paid_at", "verified_at", "rejected_at", "reviewer_user_id", "created_at"] }),
  Object.freeze({ table: "nda_signatures", operations: ["read"], columns: ["user_id", "signer_name", "signed_at"] }),
  Object.freeze({ table: "ceo_meeting_payments", operations: ["read"], columns: ["user_id", "payment_status", "calendly_booked", "created_at"] }),
  Object.freeze({ table: "onboarding_data", operations: ["read"], columns: ["user_id", "legal_first_name", "legal_last_name", "current_step", "is_completed", "completed_at", "fund_payment_status", "fund_investor_verification_status", "financial_link_status", "nda_signed_at", "initial_investment_amount", "selected_fund", "class_a_units", "class_b_units", "class_c_units", "updated_at"] }),
  Object.freeze({ table: "fund_stripe_payments", operations: ["read"], columns: ["user_id", "amount", "status"] }),
  Object.freeze({ table: "user_financial_data", operations: ["read"], columns: ["user_id", "institution_name", "status", "plaid_sync_status", "plaid_item_id", "plaid_sync_completed_at", "updated_at"] }),
  Object.freeze({ table: "plaid_items", operations: ["read"], columns: ["user_id", "plaid_item_id", "institution_name", "status", "updated_at"] }),
  Object.freeze({ table: "plaid_accounts", operations: ["read"], columns: ["plaid_item_id", "plaid_account_id", "name", "official_name", "type", "subtype", "mask", "current_balance"] }),
  Object.freeze({ table: "plaid_product_sync_statuses", operations: ["read"], columns: ["user_id", "plaid_item_id", "product", "status", "available", "records_count", "updated_at", "completed_at"] }),
  Object.freeze({ table: "kyc_attestations", operations: ["read_optional"], columns: ["user_id", "status", "risk_band", "risk_score", "verified_at", "provider_name"] }),
]);

const ADMIN_AUDIT_EFFECT = Object.freeze({
  table: "fund_admin_access_log",
  operation: "insert_best_effort",
  columns: ["actor_user_id", "actor_email", "action", "target_user_id", "target_reference", "metadata", "ip_address", "user_agent"],
});

const TEAM_AUTH = Object.freeze({
  source_platform_verify_jwt: true,
  source_application: "supabase_user_plus_team_email_allowlist",
  target: "firebase_product_user_plus_literal_boolean_fund_admin",
});

const PUBLIC_SOURCE_AUTH = Object.freeze({
  source_platform_verify_jwt: true,
  source_application: "none",
  target: "same_origin_gateway_google_identity_plus_firebase_product_user",
});

export const EXPECTED_SOURCE_CONTRACTS = Object.freeze({
  "get-locations": Object.freeze({
    auth: PUBLIC_SOURCE_AUTH,
    data_access: [],
    side_effects: [],
  }),
  "chat-check-access": Object.freeze({
    auth: PUBLIC_SOURCE_AUTH,
    data_access: [Object.freeze({
      table: "chat_access_tokens",
      operations: ["read"],
      columns: ["*"],
    })],
    side_effects: [
      Object.freeze({ table: "chat_access_tokens", operation: "insert_free_token", columns: ["visitor_id", "profile_slug", "payment_status", "access_type", "messages_limit", "messages_sent_count", "ip_address", "user_agent"] }),
      Object.freeze({ table: "chat_access_tokens", operation: "reset_paid_hourly_counter", columns: ["id", "hourly_message_count", "hourly_reset_at"] }),
    ],
  }),
  "investor-og-image": Object.freeze({
    auth: PUBLIC_SOURCE_AUTH,
    data_access: [Object.freeze({
      table: "investor_profiles",
      operations: ["read"],
      columns: ["name", "age", "organisation", "investor_profile", "slug", "is_public", "user_confirmed"],
    })],
    side_effects: [],
  }),
  "fund-payment-admin-analytics": Object.freeze({
    auth: TEAM_AUTH,
    data_access: [
      Object.freeze({ table: "fund_stripe_payment_requests", operations: ["read"], columns: ["user_id", "selected_fund", "status", "commitment_amount", "first_payment_amount", "class_a_units", "class_b_units", "class_c_units", "recurring_selected", "recurring_amount", "paid_at", "verified_at", "rejected_at", "created_at"] }),
      Object.freeze({ table: "nda_signatures", operations: ["read"], columns: ["user_id", "signed_at"] }),
      Object.freeze({ table: "onboarding_data", operations: ["read"], columns: ["user_id", "is_completed", "completed_at", "financial_link_status", "selected_fund"] }),
      Object.freeze({ table: "fund_stripe_payments", operations: ["read"], columns: ["user_id", "amount_cents", "status", "payment_kind", "paid_at", "created_at"] }),
      Object.freeze({ table: "user_financial_data", operations: ["read"], columns: ["user_id", "status", "plaid_sync_status", "plaid_item_id"] }),
      Object.freeze({ table: "ceo_meeting_payments", operations: ["read"], columns: ["user_id", "payment_status"] }),
      Object.freeze({ table: "fund_stripe_subscriptions", operations: ["read"], columns: ["user_id", "status", "recurring_amount", "recurring_frequency"] }),
      Object.freeze({ table: "kyc_attestations", operations: ["read_optional"], columns: ["user_id", "status", "risk_band"] }),
    ],
    side_effects: [],
  }),
  "fund-payment-admin-overview": Object.freeze({
    auth: TEAM_AUTH,
    data_access: [...OVERVIEW_READS, Object.freeze({ table: "auth.users", operations: ["read_admin_list"], columns: ["id", "email", "user_metadata.full_name"] })],
    side_effects: [ADMIN_AUDIT_EFFECT],
  }),
  "fund-payment-admin-overview-list": Object.freeze({
    auth: TEAM_AUTH,
    data_access: [...OVERVIEW_READS, Object.freeze({ table: "users", operations: ["read"], columns: ["id", "email"] }), Object.freeze({ table: "auth.users", operations: ["read_admin_by_id_bounded"], columns: ["id", "email", "user_metadata.full_name"] })],
    side_effects: [ADMIN_AUDIT_EFFECT],
  }),
  "fund-payment-admin-overview-metrics": Object.freeze({
    auth: TEAM_AUTH,
    data_access: [...OVERVIEW_READS],
    side_effects: [ADMIN_AUDIT_EFFECT],
  }),
  "generate-investor-profile": Object.freeze({
    auth: Object.freeze({
      source_platform_verify_jwt: true,
      source_application: "supabase_auth_get_user",
      target: "firebase_product_user",
    }),
    data_access: [],
    side_effects: [Object.freeze({
      service: "openai",
      operation: "chat.completions.create",
      model: "gpt-4o-mini",
      persistence: "none",
    })],
  }),
});

const EXPECTED_TARGET_AUTH = Object.freeze({
  "get-locations": "source_public_target_gateway_firebase_plus_google_identity",
  "chat-check-access": "source_public_target_gateway_firebase_plus_google_identity",
  "investor-og-image": "source_public_target_gateway_firebase_plus_google_identity",
  "fund-payment-admin-analytics": "firebase_fund_admin_literal_boolean",
  "fund-payment-admin-overview": "firebase_fund_admin_literal_boolean",
  "fund-payment-admin-overview-list": "firebase_fund_admin_literal_boolean",
  "fund-payment-admin-overview-metrics": "firebase_fund_admin_literal_boolean",
  "generate-investor-profile": "firebase_user",
});

function assertDigest(value, label) {
  assert.match(value, SHA256_PATTERN, `${label} must be a SHA-256 digest`);
  assert.notEqual(value, ZERO_SHA256, `${label} must not be the zero digest`);
}

function assertExact(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label} does not match the checked-in source contract`);
}

export function validateGcpReadBatchCandidateMatrix({
  matrix,
  currentEvidence,
  sourceFiles,
}) {
  assert.deepEqual(Object.keys(matrix ?? {}).sort(), [
    "base_commit",
    "deployment_state",
    "functions",
    "required_registry_state",
    "rls_contract",
    "runtime_providers",
    "schema_version",
    "source_contracts",
    "source_evidence",
    "target_project",
  ]);
  assert.equal(matrix?.schema_version, 1);
  assert.equal(matrix?.deployment_state, "DEFAULT_OFF");
  assert.equal(matrix?.required_registry_state, "INVENTORY_FROZEN");
  assert.equal(matrix?.source_evidence?.path, "migration/evidence/supabase-current-live-function-bundles.v2.json");
  assert.equal(matrix?.source_evidence?.schema_version, 2);
  assert.deepEqual(Object.keys(matrix?.source_evidence ?? {}).sort(), [
    "bundle_to_metadata_version_binding_status",
    "canonical_source_tree_digest",
    "current_metadata_digest",
    "evidence_digest",
    "metadata_end_check_status",
    "path",
    "schema_version",
    "source_revision_status",
  ]);
  assert.equal(currentEvidence?.schema_version, 2);
  assert.equal(currentEvidence?.evidence_id, "hushh-tech-supabase-current-live-function-bundles");
  assert.equal(currentEvidence?.capture?.project_ref, "ibsisfnjxeowvdtvgzff");
  assert.equal(currentEvidence?.cutover_assessment?.metadata_end_check_status, "NOT_PERFORMED_IN_V2_BLOCKING");
  assert.equal(currentEvidence?.cutover_assessment?.bundle_to_metadata_version_binding_status, "NOT_PROVEN_WITHOUT_END_METADATA_CHECK");
  assert.equal(currentEvidence?.cutover_assessment?.source_revision_status, "NOT_PROVEN");
  assert.equal(currentEvidence?.cutover_assessment?.source_revision, null);
  assert.equal(matrix.source_evidence.metadata_end_check_status, currentEvidence.cutover_assessment.metadata_end_check_status);
  assert.equal(matrix.source_evidence.bundle_to_metadata_version_binding_status, currentEvidence.cutover_assessment.bundle_to_metadata_version_binding_status);
  assert.equal(matrix.source_evidence.source_revision_status, currentEvidence.cutover_assessment.source_revision_status);
  assert.equal(matrix.source_evidence.canonical_source_tree_digest, currentEvidence.canonical_source_tree.digest);
  assert.equal(matrix.source_evidence.current_metadata_digest, currentEvidence.current_metadata_digest.digest);
  assert.equal(matrix.source_evidence.evidence_digest, currentEvidence.evidence_digest.digest);
  assertDigest(matrix.source_evidence.canonical_source_tree_digest, "canonical source tree digest");
  assertDigest(matrix.source_evidence.current_metadata_digest, "current metadata digest");
  assertDigest(matrix.source_evidence.evidence_digest, "evidence digest");

  const expectedSlugs = Object.keys(EXPECTED_SOURCE_CONTRACTS).sort();
  const rows = matrix?.functions ?? [];
  assert.deepEqual(rows.map(({ slug }) => slug).sort(), expectedSlugs);
  assert.deepEqual(Object.keys(matrix?.source_contracts ?? {}).sort(), expectedSlugs);
  const evidenceBySlug = new Map((currentEvidence.entries ?? []).map((entry) => [entry.slug, entry]));

  for (const row of rows) {
    const slug = row.slug;
    assert.deepEqual(Object.keys(row).sort(), [
      "auth",
      "blockers",
      "cache",
      "cors",
      "current_v2",
      "dependencies",
      "live_bundle_sha256",
      "request",
      "response",
      "slug",
      "source_path",
      "source_sha256",
    ], `${slug} candidate fields drifted`);
    const source = sourceFiles?.[slug];
    assert.equal(typeof source, "string", `${slug} checked-in source is missing`);
    assert.equal(row.source_path, `supabase/functions/${slug}/index.ts`);
    assertDigest(row.source_sha256, `${slug} checked-in source digest`);
    assert.equal(createHash("sha256").update(source).digest("hex"), row.source_sha256, `${slug} checked-in source digest drifted`);
    assert.equal(row.auth, EXPECTED_TARGET_AUTH[slug], `${slug} target auth drifted`);
    assert.notEqual(row.auth, "none", `${slug} target auth must not be none`);
    assertExact(matrix.source_contracts[slug], EXPECTED_SOURCE_CONTRACTS[slug], `${slug} auth/table/column/side-effect contract`);
    assert.notEqual(matrix.source_contracts[slug]?.auth?.source_application, undefined, `${slug} source auth is missing`);
    assert.notEqual(matrix.source_contracts[slug]?.auth?.target, "none", `${slug} target auth must fail closed`);

    const evidence = evidenceBySlug.get(slug);
    assert.ok(evidence, `${slug} is absent from current v2 evidence`);
    assert.equal(evidence.status, "ACTIVE");
    assert.equal(evidence.capture_status, "EXTRACTED");
    assert.equal(evidence.version_delta, 43);
    assert.equal(evidence.current_version - evidence.manifest_version, 43);
    assert.equal(evidence.verify_jwt, true);
    assertDigest(evidence.bundle_evidence?.canonical_digest, `${slug} current v2 bundle digest`);
    assertExact(row.current_v2, {
      function_id: evidence.function_id,
      current_version: evidence.current_version,
      manifest_version: evidence.manifest_version,
      version_delta: evidence.version_delta,
      verify_jwt: evidence.verify_jwt,
      digest_algorithm: evidence.bundle_evidence.digest_algorithm,
      canonical_digest: evidence.bundle_evidence.canonical_digest,
      file_count: evidence.bundle_evidence.file_count,
      total_bytes: evidence.bundle_evidence.total_bytes,
    }, `${slug} current v2 evidence binding`);
    assert.equal(row.live_bundle_sha256, row.current_v2.canonical_digest);
    assertDigest(row.live_bundle_sha256, `${slug} live bundle digest`);
    for (const blocker of REQUIRED_DRIFT_BLOCKERS) {
      assert.ok(row.blockers.includes(blocker), `${slug} is missing blocker ${blocker}`);
    }
  }

  return true;
}
