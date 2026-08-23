import { chmodSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

import { canonicalHash, canonicalJson } from "./canonical-hash.mjs";
import {
  UAT_TARGET,
  RETAINED_UAT_SOURCE_MANIFEST_SHA256,
  activateReviewedPhase,
  validateRowsForTable,
  validateSourceCaptureManifest,
  validateUatIdentityArtifact,
} from "./uat-schema-data-executor.mjs";
import {
  RETAINED_UAT_SOURCE_KEY_MANIFEST_SHA256,
  loadRetainedUatSourceKeyManifest,
  validateUatSourceKeyManifest,
} from "./uat-source-key-manifest.mjs";
import {
  TARGET_SCHEMA_PHASES,
  validatePrivateTargetSchemaPlan,
} from "./target-schema-compiler.mjs";

const PHASE_ORDER = Object.freeze([
  "10_firebase_identity_context.sql.plan",
  "20_raw_parity_schema.sql.plan",
  "30_constraints_triggers_indexes.sql.plan",
  "40_firebase_rls_policies.sql.plan",
  "50_target_privileges.sql.plan",
  "60_catalog_validation.sql.plan",
]);
const IMPORT_ORDER = Object.freeze([10, 11, 13, 14, 15, 16]);
const EXECUTOR_POLICY_TARGETS = Object.freeze([
  ["hushh_identity.identity_links", "identity_links_executor_owner_all"],
  ["hushh_migration.migration_runs", "migration_runs_executor_owner_all"],
  ["hushh_migration.identity_migration_dispositions", "identity_migration_dispositions_executor_owner_all"],
  ["hushh_migration.migration_checkpoints", "migration_checkpoints_executor_owner_all"],
  ["hushh_migration.migration_audit_events", "migration_audit_events_executor_owner_all"],
  ["hushh_migration.migration_outbox", "migration_outbox_executor_owner_all"],
]);

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function quotedIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value ?? "")) throw new Error("IMPORT_IDENTIFIER_INVALID");
  return `"${value}"`;
}

function sqlString(value) {
  if (typeof value !== "string") throw new Error("IMPORT_VALUE_INVALID");
  return `'${value.replaceAll("'", "''")}'`;
}

function bytea(value) {
  if (value === null) return "NULL";
  if (!/^[a-f0-9]{64}$/.test(value ?? "")) throw new Error("IMPORT_HASH_INVALID");
  return `decode('${value}','hex')`;
}

function jsonb(value) {
  const hex = Buffer.from(canonicalJson(value), "utf8").toString("hex");
  return `convert_from(decode('${hex}','hex'),'UTF8')::jsonb`;
}

function writePrivate(path, contents) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, contents, "utf8");
    chmodSync(path, 0o600);
  } finally {
    closeSync(fd);
  }
}

function temporaryOwnerPoliciesSql(action) {
  if (action === "create") {
    return EXECUTOR_POLICY_TARGETS.map(
      ([target, policy]) =>
        `CREATE POLICY ${quotedIdentifier(policy)} ON ${target} FOR ALL TO hushh_tech_schema_owner USING (true) WITH CHECK (true);`,
    ).join("\n");
  }
  if (action === "drop") {
    return EXECUTOR_POLICY_TARGETS.map(
      ([target, policy]) => `DROP POLICY ${quotedIdentifier(policy)} ON ${target};`,
    ).join("\n");
  }
  throw new Error("IMPORT_POLICY_ACTION_INVALID");
}

function executionPhaseStatements(phase) {
  if (phase.name === "50_target_privileges.sql.plan") {
    return [
      ...phase.statements,
      'GRANT hushh_tech_runtime TO "hushh-tech-web-uat@hushh-tech-uat.iam" WITH INHERIT TRUE, SET TRUE, ADMIN FALSE;',
    ];
  }
  if (phase.name !== "30_constraints_triggers_indexes.sql.plan") return phase.statements;
  const triggerIndexes = phase.statements
    .map((statement, index) => (/^CREATE\s+TRIGGER\b/i.test(statement.trim()) ? index : -1))
    .filter((index) => index >= 0);
  const functionRefs = phase.statements
    .map((statement) =>
      /^ALTER\s+FUNCTION\s+(public\.(?:"(?:""|[^"])+"|[a-z_][a-z0-9_]*)\([^;]*\))\s+OWNER\s+TO\s+hushh_tech_schema_owner;$/i.exec(
        statement.trim(),
      )?.[1],
    )
    .filter(Boolean);
  if (triggerIndexes.length !== 24 || functionRefs.length !== 8) {
    throw new Error("IMPORT_TRIGGER_CONTRACT_INVALID");
  }
  const firstTrigger = triggerIndexes[0];
  const lastTrigger = triggerIndexes.at(-1);
  const grants = functionRefs.map(
    (ref) => `GRANT EXECUTE ON FUNCTION ${ref} TO hushh_tech_schema_owner;`,
  );
  const revokes = functionRefs.map(
    (ref) => `REVOKE EXECUTE ON FUNCTION ${ref} FROM hushh_tech_schema_owner;`,
  );
  return [
    ...phase.statements.slice(0, firstTrigger),
    ...grants,
    ...phase.statements.slice(firstTrigger, lastTrigger + 1),
    ...revokes,
    ...phase.statements.slice(lastTrigger + 1),
  ];
}

function phaseSql({ phase, replayKey, sourceManifestSha256, identityArtifactSha256 }) {
  const ensureRun = phase.name === PHASE_ORDER[0]
    ? `\nINSERT INTO hushh_migration.migration_runs (replay_key,source_inventory_hash,mapping_input_hash,source_project_ref,source_database,target_environment,target_project,target_region,target_instance,target_database,mode,status,started_at)
VALUES (${bytea(replayKey)},${bytea(sourceManifestSha256)},${bytea(identityArtifactSha256)},'ibsisfnjxeowvdtvgzff','postgres','uat','hushh-tech-uat','us-central1','hushh-tech-app-pg-uat','hushh_tech_app','APPLY','RUNNING',clock_timestamp())
ON CONFLICT (replay_key) DO NOTHING;\n`
    : "";
  const record = `INSERT INTO hushh_migration.migration_audit_events (migration_run_id,event_type,actor,event_hash,details)
SELECT id,'SCHEMA_PHASE','governed_cloudsql_import',${bytea(phase.sha256)},jsonb_build_object('phase',${sqlString(phase.name)})
FROM hushh_migration.migration_runs WHERE replay_key=${bytea(replayKey)}
AND NOT EXISTS (SELECT 1 FROM hushh_migration.migration_audit_events event WHERE event.migration_run_id=hushh_migration.migration_runs.id AND event.event_type='SCHEMA_PHASE' AND event.event_hash=${bytea(phase.sha256)});`;
  const isFoundation = phase.name === PHASE_ORDER[0];
  const isValidation = phase.name === PHASE_ORDER.at(-1);
  const executableStatements = executionPhaseStatements(phase);
  const body = isValidation
    ? `${record}\n${temporaryOwnerPoliciesSql("drop")}\nGRANT USAGE ON SCHEMA public, hushh_identity, hushh_migration TO postgres WITH GRANT OPTION;\nREVOKE hushh_tech_schema_owner FROM postgres;\n${executableStatements.join("\n")}\nREVOKE GRANT OPTION FOR USAGE ON SCHEMA public, hushh_identity, hushh_migration FROM postgres;\nREVOKE USAGE ON SCHEMA public, hushh_identity, hushh_migration FROM postgres;\nUPDATE hushh_migration.migration_runs SET status='SUCCEEDED',completed_at=clock_timestamp() WHERE replay_key=${bytea(replayKey)} AND status='RUNNING';`
    : `${executableStatements.join("\n")}\n${isFoundation ? temporaryOwnerPoliciesSql("create") : ""}\n${ensureRun}${record}`;
  return `BEGIN;
SET LOCAL statement_timeout='15min';
SET LOCAL lock_timeout='10s';
SET LOCAL idle_in_transaction_session_timeout='2min';
${body}
COMMIT;
`;
}

function identitySql(identityArtifact, replayKey) {
  const lines = [];
  for (const row of identityArtifact.identityRows) {
    lines.push(`INSERT INTO hushh_identity.identity_links (legacy_project,legacy_user_uuid,firebase_uid,provider_id,provider_subject_hash,mapping_basis,status,provenance)
VALUES ('ibsisfnjxeowvdtvgzff',${sqlString(row.legacyUserUuid)}::uuid,${sqlString(row.firebaseUid)},${row.providerId ? sqlString(row.providerId) : "NULL"},${bytea(row.providerSubjectHash)},${sqlString(row.mappingBasis)}::hushh_identity.identity_mapping_basis,'ACTIVE',jsonb_build_object('artifactSha256',${sqlString(identityArtifact.artifactSha256)}))
;`);
    lines.push(`INSERT INTO hushh_migration.identity_migration_dispositions (migration_run_id,legacy_project,legacy_user_uuid,firebase_uid,terminal_disposition,mapping_basis,provider_evidence_count,email_was_used,access_allowed)
SELECT id,'ibsisfnjxeowvdtvgzff',${sqlString(row.legacyUserUuid)}::uuid,${sqlString(row.firebaseUid)},${sqlString(row.terminalDisposition)}::hushh_migration.identity_terminal_disposition,${sqlString(row.mappingBasis)},${row.providerEvidenceCount},false,true
FROM hushh_migration.migration_runs WHERE replay_key=${bytea(replayKey)}
;`);
  }
  lines.push(`DO $identity_parity$ BEGIN
IF (SELECT count(*) FROM hushh_identity.identity_links WHERE status='ACTIVE') <> 369
OR (SELECT count(*) FROM hushh_identity.identity_links WHERE status='UNCLAIMED_LEGACY_PRINCIPAL') <> 0
OR (SELECT count(*) FROM hushh_migration.identity_migration_dispositions WHERE email_was_used) <> 0
THEN RAISE EXCEPTION 'TARGET_IDENTITY_PARITY_MISMATCH'; END IF;
END $identity_parity$;`);
  return lines.join("\n");
}

function tableSql({ table, rows, replayKey }) {
  validateRowsForTable(table, rows);
  const relation = `public.${quotedIdentifier(table.name)}`;
  const columns = table.insertColumns.map(quotedIdentifier);
  const checkpointHash = canonicalHash({ replayKey, table: table.name, rowCount: table.rowCount, rowSha256: table.rowSha256 });
  const insert = rows.length === 0 ? "" : `INSERT INTO ${relation} (${columns.join(",")})
SELECT ${columns.map((column) => `source_row.${column}`).join(",")}
FROM jsonb_populate_recordset(NULL::${relation}, ${jsonb(rows)}) AS source_row;`;
  return `DO $empty_${table.name}$ BEGIN IF EXISTS (SELECT 1 FROM ${relation} LIMIT 1) THEN RAISE EXCEPTION 'TARGET_TABLE_NOT_EMPTY:${table.name}'; END IF; END $empty_${table.name}$;
${insert}
DO $count_${table.name}$ BEGIN IF (SELECT count(*) FROM ${relation}) <> ${table.rowCount} THEN RAISE EXCEPTION 'TARGET_ROW_COUNT_MISMATCH:${table.name}'; END IF; END $count_${table.name}$;
INSERT INTO hushh_migration.migration_checkpoints (migration_run_id,stream,sequence,cursor,row_count,batch_hash,previous_checkpoint_hash,checkpoint_hash)
SELECT id,${sqlString(`table.${table.name}`)},0,jsonb_build_object('table',${sqlString(table.name)}),${table.rowCount},${bytea(table.rowSha256)},NULL,${bytea(checkpointHash)}
FROM hushh_migration.migration_runs WHERE replay_key=${bytea(replayKey)}
ON CONFLICT (migration_run_id,stream,sequence) DO NOTHING;`;
}

export function loadValidatedSourceMembers({
  sourceManifest,
  rowDirectory,
  sourceKeyManifest = loadRetainedUatSourceKeyManifest(),
  expectedSourceKeyManifestSha256 = RETAINED_UAT_SOURCE_KEY_MANIFEST_SHA256,
  expectedSourceRowCount = 45_042,
}) {
  validateUatSourceKeyManifest(sourceKeyManifest, sourceManifest, expectedSourceKeyManifestSha256, expectedSourceRowCount);
  const expectedKeys = new Map(sourceKeyManifest.tables.map((table) => [table.name, table]));
  const rowsByTable = new Map();
  for (const table of sourceManifest.tables) {
    let rows;
    try {
      rows = JSON.parse(readFileSync(resolve(rowDirectory, table.artifact.member), "utf8"));
    } catch {
      throw new Error("SOURCE_MEMBER_JSON_INVALID");
    }
    validateRowsForTable(table, rows, expectedKeys.get(table.name));
    rowsByTable.set(table.name, rows);
  }
  return rowsByTable;
}

export function buildCloudSqlImportBundle({
  catalogEvidenceSha256,
  sourceManifest,
  identityArtifact,
  phaseDirectory,
  rowDirectory,
  outputDirectory,
  sourceKeyManifest = loadRetainedUatSourceKeyManifest(),
}) {
  validateSourceCaptureManifest(sourceManifest, RETAINED_UAT_SOURCE_MANIFEST_SHA256);
  validateUatIdentityArtifact(identityArtifact);
  if (!/^[a-f0-9]{64}$/.test(catalogEvidenceSha256 ?? "")) throw new Error("CATALOG_EVIDENCE_INVALID");
  const reviewedPlans = Object.fromEntries(
    TARGET_SCHEMA_PHASES.map((name) => [name, readFileSync(resolve(phaseDirectory, name), "utf8")]),
  );
  const reviewedReport = JSON.parse(
    readFileSync(resolve(phaseDirectory, "target-schema-plan.v1.json"), "utf8"),
  );
  validatePrivateTargetSchemaPlan({ report: reviewedReport, phases: reviewedPlans });
  const reviewedPhaseEvidence = new Map(
    reviewedReport.phases.map((phase) => [phase.name, phase]),
  );
  // Validate every governed table member before creating even one SQL artifact.
  // This makes a same-count/member/hash substitution fail without a partial bundle.
  const rowsByTable = loadValidatedSourceMembers({ sourceManifest, rowDirectory, sourceKeyManifest });
  const replayKey = canonicalHash({
    catalogEvidenceSha256,
    sourceManifestSha256: sourceManifest.manifestSha256,
    sourceKeyManifestSha256: sourceKeyManifest.manifestSha256,
    identityArtifactSha256: identityArtifact.artifactSha256,
    target: UAT_TARGET,
  });
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  chmodSync(outputDirectory, 0o700);
  const artifacts = [];
  for (const [index, name] of PHASE_ORDER.entries()) {
    const phase = activateReviewedPhase(
      name,
      reviewedPlans[name],
      reviewedPhaseEvidence.get(name),
    );
    const path = resolve(outputDirectory, `${String(index + 1).padStart(2, "0")}-${name.replace(".plan", "")}`);
    const sql = phaseSql({ phase, replayKey, sourceManifestSha256: sourceManifest.manifestSha256, identityArtifactSha256: identityArtifact.artifactSha256 });
    writePrivate(path, sql);
    artifacts.push({ order: IMPORT_ORDER[index], name: path.split("/").at(-1), sha256: sha256(sql), bytes: Buffer.byteLength(sql) });
  }
  const dataParts = [
    "BEGIN;",
    "SET LOCAL statement_timeout='30min';",
    "SET LOCAL lock_timeout='10s';",
    "SET LOCAL idle_in_transaction_session_timeout='5min';",
    identitySql(identityArtifact, replayKey),
  ];
  for (const table of sourceManifest.tables) {
    const rows = rowsByTable.get(table.name);
    dataParts.push(tableSql({ table, rows, replayKey }));
  }
  dataParts.push(`INSERT INTO hushh_migration.migration_audit_events (migration_run_id,event_type,actor,event_hash,details)
SELECT id,'DATA_AND_IDENTITY_LOADED','governed_cloudsql_import',${bytea(sourceManifest.manifestSha256)},jsonb_build_object('status','AWAITING_PHASE60_CATALOG_VALIDATION')
FROM hushh_migration.migration_runs WHERE replay_key=${bytea(replayKey)};`, "COMMIT;");
  const dataSql = `${dataParts.join("\n")}\n`;
  const dataPath = resolve(outputDirectory, "12-data-and-identity.sql");
  writePrivate(dataPath, dataSql);
  artifacts.push({ order: 12, name: "12-data-and-identity.sql", sha256: sha256(dataSql), bytes: Buffer.byteLength(dataSql) });
  artifacts.sort((left, right) => left.order - right.order);
  const payload = {
    version: 1,
    kind: "HUSHH_TECH_UAT_CLOUDSQL_IMPORT_BUNDLE",
    target: UAT_TARGET,
    replayKey,
    catalogEvidenceSha256,
    sourceManifestSha256: sourceManifest.manifestSha256,
    sourceKeyManifestSha256: sourceKeyManifest.manifestSha256,
    identityArtifactSha256: identityArtifact.artifactSha256,
    tableCount: 70,
    rowCount: 45_042,
    phase00: "EXTERNAL_LIVE_EXECUTION_EVIDENCE_REQUIRED",
    executionDisposition: "RETAINED_FUTURE_REPLAY_BUNDLE_NOT_EXECUTED_AS_A_WHOLE",
    recoveryDisposition: "NOT_A_ROLLBACK_ARTIFACT",
    phases: PHASE_ORDER,
    reviewedPlanSha256: reviewedReport.planSha256,
    artifacts,
  };
  const manifest = { ...payload, manifestSha256: canonicalHash(payload) };
  writePrivate(resolve(outputDirectory, "import-bundle.manifest.json"), `${canonicalJson(manifest)}\n`);
  return manifest;
}
