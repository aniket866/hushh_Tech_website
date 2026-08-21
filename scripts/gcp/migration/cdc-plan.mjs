import {
  MigrationContractError,
  PUBLIC_TABLES,
  assertDryRunOnly,
  assertMigrationBoundary,
  assertSqlIdentifier,
} from "./contract.mjs";

function quoteIdentifier(value) {
  return `"${assertSqlIdentifier(value).replaceAll('"', '""')}"`;
}

export function buildCdcPlan(boundary, options = {}) {
  assertDryRunOnly(options);
  const lockedBoundary = assertMigrationBoundary({
    environment: boundary?.environment,
    sourceProjectRef: boundary?.source?.projectRef,
    sourceDatabase: boundary?.source?.database,
    targetProject: boundary?.target?.projectId,
    targetRegion: boundary?.target?.region,
    targetInstance: boundary?.target?.instance,
    targetDatabase: boundary?.target?.database,
    postgresMajor: boundary?.target?.postgresMajor,
    dryRun: true,
  });
  const publication = "hushh_tech_gcp_cutover_v1";
  const slot = "hushh_tech_gcp_cutover_v1_slot";
  const subscription = `hushh_tech_${lockedBoundary.environment}_v1`;
  const requestedTargetOutgoingIpMode = options.targetOutgoingIpMode;
  if (
    requestedTargetOutgoingIpMode !== undefined &&
    !["PRIVATE_ONLY", "TEMPORARY_PUBLIC_IPV4"].includes(requestedTargetOutgoingIpMode)
  ) {
    throw new MigrationContractError(
      "INVALID_CDC_PREFLIGHT",
      "Target outgoing IP mode must use an approved non-address enum value."
    );
  }
  const requestedEvidenceHash = options.connectivityEvidenceHash;
  const connectivityEvidenceHash = /^[a-f0-9]{64}$/.test(requestedEvidenceHash ?? "")
    ? requestedEvidenceHash
    : null;
  const preflight = {
    sourceDirectConnectivityVerified: options.sourceDirectConnectivityVerified === true,
    sourceIpv4AddonVerified: options.sourceIpv4AddonVerified === true,
    targetOutgoingIpMode: requestedTargetOutgoingIpMode ?? "PRIVATE_ONLY",
    targetOutgoingIpVerified: options.targetOutgoingIpVerified === true,
    connectivityEvidenceHash,
  };
  const blockers = [];
  if (!preflight.sourceDirectConnectivityVerified) {
    blockers.push("SOURCE_DIRECT_CONNECTIVITY_NOT_VERIFIED");
  }
  if (!preflight.sourceIpv4AddonVerified) {
    blockers.push("SOURCE_IPV4_ADDON_NOT_VERIFIED");
  }
  if (preflight.targetOutgoingIpMode !== "TEMPORARY_PUBLIC_IPV4") {
    blockers.push("TARGET_STABLE_OUTGOING_IP_MODE_NOT_ENABLED");
  }
  if (!preflight.targetOutgoingIpVerified) {
    blockers.push("TARGET_STABLE_OUTGOING_IP_NOT_VERIFIED");
  }
  if (preflight.connectivityEvidenceHash === null) {
    blockers.push("CONNECTIVITY_EVIDENCE_HASH_REQUIRED");
  }
  blockers.push("LIVE_ATTESTATION_EXECUTOR_REQUIRED");
  const qualifiedTables = PUBLIC_TABLES.map(
    (table) => `${quoteIdentifier("public")}.${quoteIdentifier(table)}`
  );

  return Object.freeze({
    mode: "PLAN_ONLY",
    executorIncluded: false,
    source: {
      publication,
      slot,
      publicationSql: [
        `CREATE PUBLICATION ${quoteIdentifier(publication)}`,
        `FOR TABLE ${qualifiedTables.join(",\n  ")}`,
        "WITH (publish = 'insert, update, delete, truncate', publish_via_partition_root = true);",
      ].join("\n"),
      slotSql: `SELECT * FROM pg_create_logical_replication_slot('${slot}', 'pgoutput');`,
      slotDropSql: `SELECT pg_drop_replication_slot('${slot}');`,
    },
    target: {
      subscription,
      disabledSubscriptionSqlTemplate: [
        `CREATE SUBSCRIPTION ${quoteIdentifier(subscription)}`,
        "CONNECTION '<loaded only at execution from Secret Manager>'",
        `PUBLICATION ${quoteIdentifier(publication)}`,
        `WITH (copy_data = true, create_slot = false, enabled = false, slot_name = '${slot}');`,
      ].join("\n"),
      enableAfterGovernedVerificationSql: null,
      teardownSql: [
        `ALTER SUBSCRIPTION ${quoteIdentifier(subscription)} DISABLE;`,
        `ALTER SUBSCRIPTION ${quoteIdentifier(subscription)} SET (slot_name = NONE);`,
        `DROP SUBSCRIPTION ${quoteIdentifier(subscription)};`,
      ].join("\n"),
    },
    safety: {
      sourceTableCount: PUBLIC_TABLES.length,
      targetProject: lockedBoundary.target.projectId,
      targetRegion: lockedBoundary.target.region,
      targetInstance: lockedBoundary.target.instance,
      targetDatabase: lockedBoundary.target.database,
      sourceTransport: "DIRECT_DATABASE",
      sourceNetworkDefault: "IPV6",
      temporaryIpv4AddonMayBeRequired: true,
      subscriberTopology: "ZONAL",
      regionalHaAllowedDuringCdc: false,
      stopSubscriptionBeforeRegionalHa: true,
      removePublicConnectivityBeforeGcpWrites: true,
      requiresSeparateGovernedExecution: true,
    },
    readiness: {
      status: "BLOCKED_PRECONDITION",
      cdcReady: false,
      blockers,
      preflight: {
        ...preflight,
        claimsOnly: true,
      },
      actualIpAddressesEmitted: false,
    },
    lifecycle: [
      "ENABLE_TEMPORARY_SOURCE_IPV4_ADDON",
      "ENABLE_TEMPORARY_TARGET_PUBLIC_IPV4",
      "VERIFY_STABLE_TARGET_OUTGOING_IP",
      "VERIFY_DIRECT_SOURCE_CONNECTIVITY",
      "CREATE_SCOPED_PUBLICATION",
      "PRECREATE_PGOUTPUT_SLOT",
      "CREATE_DISABLED_ZONAL_SUBSCRIPTION_WITH_INITIAL_COPY",
      "ENABLE_AFTER_GOVERNED_VERIFICATION",
      "REACH_ZERO_LAG_TWICE",
      "DISABLE_AND_DROP_SUBSCRIPTION",
      "DROP_SOURCE_SLOT",
      "REMOVE_PUBLIC_CONNECTIVITY",
      "ENABLE_REGIONAL_HA",
      "OPEN_GCP_WRITES",
    ],
  });
}

export function assertCdcReady() {
  throw new MigrationContractError(
    "LIVE_ATTESTATION_EXECUTOR_REQUIRED",
    "This plan-only package cannot attest live connectivity or declare CDC ready."
  );
}
