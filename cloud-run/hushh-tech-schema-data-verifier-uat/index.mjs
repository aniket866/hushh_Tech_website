import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET = Object.freeze({
  project: "hushh-tech-uat",
  region: "us-central1",
  instance: "hushh-tech-app-pg-uat",
  database: "hushh_tech_app",
  auditUser: "hushh-tech-audit-uat@hushh-tech-uat.iam",
  webUser: "hushh-tech-web-uat@hushh-tech-uat.iam",
});
const SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const PAGE_SIZE = 1_000;
export const PINNED_EXPECTED_SHA256 = "a924487b2660d2f7aa9226111a53de6539c590b52db4b2f2971bebc1ef774618";
const PINNED_SOURCE_MANIFEST_SHA256 = "02f520f613addcd7e9b1bc692c39b628241a3c656c463e6f15ab1276b6a6aad1";
const PINNED_SOURCE_KEY_MANIFEST_SHA256 = "050e24baa2b939ce539c7472502dd7d13bbdde0f8832712c4a6cd4229ae0cf70";
const PINNED_IDENTITY_ARTIFACT_SHA256 = "a85f406c2852964a951740964efb02b8c9eb75d86f0db2a6568c171f4dada689";
const PINNED_IDENTITY_MAPPING_SHA256 = "92a0162c5e96ff2ed4ddb425f93336b0ea43ac63f9338c61bec665d1c3523969";
const TRIGGER_FUNCTIONS = Object.freeze([
  "generate_investor_slug",
  "handle_new_user",
  "hushh_agents_set_updated_at",
  "hushh_agents_sync_conversation_preview",
  "hushh_agents_sync_match_from_swipe",
  "set_current_timestamp_updated_at",
  "update_onboarding_data_timestamp",
  "wa_set_updated_at",
]);

class VerifyError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new VerifyError(code);
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("NON_CANONICAL_VALUE");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail("NON_CANONICAL_VALUE");
      output[key.normalize("NFC")] = canonicalize(value[key]);
    }
    return output;
  }
  fail("NON_CANONICAL_VALUE");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalHash(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function exactKeys(value, expected, code) {
  if (canonicalHash(Object.keys(value ?? {}).sort()) !== canonicalHash([...expected].sort())) fail(code);
}

function hashRows(rows) {
  const hash = createHash("sha256");
  for (const row of rows.map(canonicalJson).sort()) hash.update(row, "utf8").update("\n", "utf8");
  return hash.digest("hex");
}

function hashPrimaryKeys(table, rows) {
  const keys = rows.map((row) => canonicalJson(Object.fromEntries(
    table.primaryKey.map((column) => [column, row[column]]),
  ))).sort();
  const hash = createHash("sha256");
  for (const key of keys) hash.update(key, "utf8").update("\n", "utf8");
  return hash.digest("hex");
}

function quoteIdentifier(value) {
  if (!IDENTIFIER.test(value ?? "")) fail("IDENTIFIER_INVALID");
  return `"${value}"`;
}

export function validateExpected(expected) {
  if (
    expected?.version !== 1 ||
    expected?.kind !== "HUSHH_TECH_UAT_SCHEMA_DATA_VERIFIER_INPUT" ||
    expected?.expectedSha256 !== PINNED_EXPECTED_SHA256 ||
    expected?.sourceManifest?.manifestSha256 !== PINNED_SOURCE_MANIFEST_SHA256 ||
    expected?.identity?.artifactSha256 !== PINNED_IDENTITY_ARTIFACT_SHA256 ||
    expected?.identity?.mappingSha256 !== PINNED_IDENTITY_MAPPING_SHA256 ||
    expected?.sourceManifest?.totalRowCount !== 45_042 ||
    !Array.isArray(expected?.sourceManifest?.tables) ||
    expected.sourceManifest.tables.length !== 70
  ) fail("EXPECTED_MANIFEST_INVALID");
  exactKeys(expected, ["version", "kind", "target", "preApplyCatalogEvidenceSha256", "replayKey", "sourceManifest", "sourceKeys", "identity", "expectedCatalog", "expectedIdentity", "expectedAccess", "expectedSha256"], "EXPECTED_MANIFEST_INVALID");
  const { expectedSha256, ...expectedPayload } = expected;
  if (canonicalHash(expectedPayload) !== expectedSha256) fail("EXPECTED_INPUT_DIGEST_MISMATCH");
  const { manifestSha256, ...sourcePayload } = expected.sourceManifest;
  if (canonicalHash(sourcePayload) !== manifestSha256) fail("EXPECTED_SOURCE_DIGEST_MISMATCH");
  const names = new Set();
  const members = new Set();
  for (const [index, table] of expected.sourceManifest.tables.entries()) {
    if (
      table?.schema !== "public" ||
      !IDENTIFIER.test(table?.name ?? "") ||
      names.has(table.name) ||
      !Number.isSafeInteger(table.rowCount) ||
      table.rowCount < 0 ||
      !SHA256.test(table.rowSha256 ?? "") ||
      !Array.isArray(table.rowColumns) ||
      table.rowColumns.length === 0 ||
      table.rowColumns.some((column) => !IDENTIFIER.test(column)) ||
      !Array.isArray(table.primaryKey) ||
      table.primaryKey.length === 0 ||
      table.primaryKey.some((column) => !table.rowColumns.includes(column)) ||
      table.artifact?.member !== `${String(index + 1).padStart(2, "0")}-${table.name}.rows.json` ||
      members.has(table.artifact.member) ||
      !SHA256.test(table.artifact?.memberSha256 ?? "")
    ) fail("EXPECTED_TABLE_INVALID");
    names.add(table.name);
    members.add(table.artifact.member);
  }
  if (expected.sourceManifest.tables.reduce((sum, table) => sum + table.rowCount, 0) !== 45_042) {
    fail("EXPECTED_ROW_TOTAL_INVALID");
  }
  if (
    expected.sourceKeys?.version !== 1 ||
    expected.sourceKeys?.kind !== "HUSHH_TECH_UAT_SOURCE_PRIMARY_KEY_PARITY" ||
    expected.sourceKeys?.manifestSha256 !== PINNED_SOURCE_KEY_MANIFEST_SHA256 ||
    expected.sourceKeys?.sourceManifestSha256 !== PINNED_SOURCE_MANIFEST_SHA256 ||
    expected.sourceKeys?.bundleObjectSha256 !== expected.sourceManifest.bundle.objectSha256 ||
    String(expected.sourceKeys?.bundleGeneration) !== String(expected.sourceManifest.bundle.generation) ||
    expected.sourceKeys?.tableCount !== 70 ||
    expected.sourceKeys?.rowCount !== 45_042 ||
    !Array.isArray(expected.sourceKeys?.tables) ||
    expected.sourceKeys.tables.length !== 70
  ) fail("EXPECTED_KEY_MANIFEST_INVALID");
  exactKeys(expected.sourceKeys, ["version", "kind", "sourceManifestSha256", "bundleObjectSha256", "bundleGeneration", "tableCount", "rowCount", "tables", "manifestSha256"], "EXPECTED_KEY_MANIFEST_INVALID");
  const { manifestSha256: keyManifestSha256, ...keyManifestPayload } = expected.sourceKeys;
  if (canonicalHash(keyManifestPayload) !== keyManifestSha256) fail("EXPECTED_KEY_MANIFEST_DIGEST_MISMATCH");
  for (const [index, keyTable] of expected.sourceKeys.tables.entries()) {
    const sourceTable = expected.sourceManifest.tables[index];
    exactKeys(keyTable, ["name", "primaryKey", "keyCount", "keySha256"], "EXPECTED_KEY_TABLE_INVALID");
    if (
      keyTable.name !== sourceTable.name ||
      canonicalHash(keyTable.primaryKey) !== canonicalHash(sourceTable.primaryKey) ||
      keyTable.keyCount !== sourceTable.rowCount ||
      !SHA256.test(keyTable.keySha256 ?? "")
    ) fail("EXPECTED_KEY_TABLE_INVALID");
  }
  if (
    expected.target?.project !== TARGET.project ||
    expected.target?.instance !== TARGET.instance ||
    expected.target?.database !== TARGET.database ||
    !SHA256.test(expected.replayKey ?? "") ||
    Object.values(expected.identity).some((value) => typeof value === "string" && !SHA256.test(value)) ||
    expected.identity.authTerminalCount !== 369 ||
    expected.identity.importedFirebase !== 369 ||
    expected.identity.linkedExistingFirebase !== 0
  ) fail("EXPECTED_IDENTITY_INVALID");
  const engagementAccess = expected.expectedAccess?.engagementNdaAdminFetch;
  exactKeys(expected.expectedAccess, ["engagementNdaAdminFetch"], "EXPECTED_ACCESS_INVALID");
  exactKeys(engagementAccess, ["role", "table", "selectColumns", "rlsPolicy", "rlsClaimSetting", "rlsClaimValue", "tableWideSelect", "publicDml", "elevatedPrivileges", "expectedTotalPublicPolicies"], "EXPECTED_ACCESS_INVALID");
  if (
    engagementAccess?.role !== "hushh-tech-engagement-api-uat@hushh-tech-uat.iam" ||
    engagementAccess?.table !== "public.nda_signatures" ||
    canonicalHash(engagementAccess?.selectColumns) !== canonicalHash(["id", "user_id", "signed_at", "nda_version", "pdf_url"]) ||
    engagementAccess?.rlsPolicy !== "nda_signatures_engagement_api_select" ||
    engagementAccess?.rlsClaimSetting !== "app.firebase_fund_admin" ||
    engagementAccess?.rlsClaimValue !== "true" ||
    engagementAccess?.tableWideSelect !== false ||
    engagementAccess?.publicDml !== false ||
    engagementAccess?.elevatedPrivileges !== false ||
    engagementAccess?.expectedTotalPublicPolicies !== 281
  ) fail("EXPECTED_ACCESS_INVALID");
  return expected;
}

function normalizePolicyExpression(value) {
  if (typeof value !== "string") return null;
  let normalized = value.replaceAll("::text", "").replace(/\s+/g, "");
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let index = 0; index < normalized.length; index += 1) {
      if (normalized[index] === "(") depth += 1;
      if (normalized[index] === ")") depth -= 1;
      if (depth === 0 && index < normalized.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

export function assessEngagementNdaBoundary(observed, expected) {
  exactKeys(observed, ["role", "selectColumns", "tableWideSelect", "publicDml", "forbiddenMemberships", "policy"], "ENGAGEMENT_BOUNDARY_OBSERVATION_INVALID");
  exactKeys(observed.role, ["exists", "login", "superuser", "createRole", "createDatabase", "replication", "bypassRls", "databaseCreate", "databaseTemporary", "publicSchemaUsage", "publicSchemaCreate"], "ENGAGEMENT_BOUNDARY_OBSERVATION_INVALID");
  if (!Array.isArray(observed.selectColumns) || !Array.isArray(observed.forbiddenMemberships) || !Array.isArray(observed.policy)) {
    fail("ENGAGEMENT_BOUNDARY_OBSERVATION_INVALID");
  }
  const expectedColumns = expected.selectColumns.map((column) => `${expected.table}.${column}`).sort();
  const actualColumns = observed.selectColumns.map(([schema, table, column]) => `${schema}.${table}.${column}`).sort();
  const expectedPolicyExpression = `current_setting('${expected.rlsClaimSetting}',true)='${expected.rlsClaimValue}'`;
  const exactPolicy = observed.policy.length === 1 &&
    observed.policy[0]?.name === expected.rlsPolicy &&
    observed.policy[0]?.command === "r" &&
    observed.policy[0]?.permissive === true &&
    canonicalHash(observed.policy[0]?.roles) === canonicalHash([expected.role]) &&
    normalizePolicyExpression(observed.policy[0]?.qual) === expectedPolicyExpression &&
    observed.policy[0]?.withCheck === null;
  const elevatedPrivileges = Boolean(
    observed.role.superuser ||
    observed.role.createRole ||
    observed.role.createDatabase ||
    observed.role.replication ||
    observed.role.bypassRls ||
    observed.role.databaseCreate ||
    observed.role.databaseTemporary ||
    observed.role.publicSchemaCreate ||
    observed.forbiddenMemberships.length > 0
  );
  if (observed.tableWideSelect || observed.publicDml || elevatedPrivileges) {
    fail("ENGAGEMENT_BOUNDARY_OVERPRIVILEGED");
  }
  const missing = [];
  if (!observed.role.exists) missing.push("ROLE_ABSENT");
  if (observed.role.exists && !observed.role.login) missing.push("LOGIN_DISABLED");
  if (observed.role.exists && !observed.role.publicSchemaUsage) missing.push("PUBLIC_SCHEMA_USAGE_ABSENT");
  if (canonicalHash(actualColumns) !== canonicalHash(expectedColumns)) missing.push("EXACT_COLUMN_SELECT_ABSENT");
  if (!exactPolicy) missing.push("EXACT_RLS_POLICY_ABSENT");
  return Object.freeze({
    ready: missing.length === 0,
    roleExists: observed.role.exists,
    selectColumns: actualColumns,
    tableWideSelect: observed.tableWideSelect,
    publicDml: observed.publicDml,
    elevatedPrivileges,
    rlsPolicyExact: exactPolicy,
    rlsPolicy: observed.policy.length === 1 ? {
      name: observed.policy[0].name,
      command: observed.policy[0].command === "r" ? "SELECT" : observed.policy[0].command,
      permissive: observed.policy[0].permissive,
      roles: observed.policy[0].roles,
      qual: normalizePolicyExpression(observed.policy[0].qual),
      withCheck: normalizePolicyExpression(observed.policy[0].withCheck),
    } : null,
    missing,
  });
}

async function fetchTable(client, table, expectedKey) {
  const rows = [];
  const relation = `public.${quoteIdentifier(table.name)}`;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await client.query({
      text: `SELECT to_jsonb(target_row)::text AS row_json FROM ${relation} AS target_row ORDER BY to_jsonb(target_row)::text LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      rowMode: "object",
    });
    for (const entry of result.rows) {
      if (typeof entry?.row_json !== "string") fail("TARGET_ROW_ENVELOPE_INVALID");
      const row = JSON.parse(entry.row_json);
      if (!row || typeof row !== "object" || Array.isArray(row)) fail("TARGET_ROW_INVALID");
      if (canonicalHash(Object.keys(row).sort()) !== canonicalHash([...table.rowColumns].sort())) fail("TARGET_ROW_SHAPE_INVALID");
      rows.push(row);
    }
    if (result.rowCount < PAGE_SIZE) break;
  }
  const rowSha256 = hashRows(rows);
  const keySha256 = hashPrimaryKeys(table, rows);
  return {
    name: table.name,
    rowCount: rows.length,
    rowSha256,
    keySha256,
    parity: rows.length === table.rowCount && rowSha256 === table.rowSha256 &&
      rows.length === expectedKey.keyCount && keySha256 === expectedKey.keySha256,
  };
}

async function scalar(client, text, values = []) {
  const result = await client.query({ text, values, rowMode: "array" });
  if (result.rowCount !== 1 || result.rows[0].length !== 1) fail("SCALAR_QUERY_INVALID");
  return result.rows[0][0];
}

const ENGAGEMENT_FORBIDDEN_MEMBERSHIPS = Object.freeze([
  "hushh_tech_schema_owner",
  "hushh_tech_migration",
  "hushh_tech_runtime",
  "hushh_tech_audit",
  "hushh_tech_rollback",
  "cloudsqladmin",
  "cloudsqlsuperuser",
  "pg_checkpoint",
  "pg_create_subscription",
  "pg_database_owner",
  "pg_maintain",
  "pg_monitor",
  "pg_read_all_data",
  "pg_signal_backend",
  "pg_write_all_data",
]);

async function inspectEngagementNdaBoundary(client, expected) {
  const roleResult = await client.query({
    text: `SELECT rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,
                  has_database_privilege(oid,current_database(),'CREATE'),
                  has_database_privilege(oid,current_database(),'TEMPORARY'),
                  has_schema_privilege(oid,'public','USAGE'),
                  has_schema_privilege(oid,'public','CREATE')
             FROM pg_catalog.pg_roles
            WHERE rolname=$1`,
    values: [expected.role],
    rowMode: "array",
  });
  const role = roleResult.rowCount === 1 ? {
    exists: true,
    login: roleResult.rows[0][0],
    superuser: roleResult.rows[0][1],
    createRole: roleResult.rows[0][2],
    createDatabase: roleResult.rows[0][3],
    replication: roleResult.rows[0][4],
    bypassRls: roleResult.rows[0][5],
    databaseCreate: roleResult.rows[0][6],
    databaseTemporary: roleResult.rows[0][7],
    publicSchemaUsage: roleResult.rows[0][8],
    publicSchemaCreate: roleResult.rows[0][9],
  } : {
    exists: false,
    login: false,
    superuser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
    databaseCreate: false,
    databaseTemporary: false,
    publicSchemaUsage: false,
    publicSchemaCreate: false,
  };
  let selectColumns = [];
  let tableWideSelect = false;
  let publicDml = false;
  let forbiddenMemberships = [];
  if (role.exists) {
    const columns = await client.query({
      text: `SELECT n.nspname,c.relname,a.attname
               FROM pg_catalog.pg_attribute a
               JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
               JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND c.relkind IN ('r','p')
                AND a.attnum>0 AND NOT a.attisdropped
                AND has_column_privilege($1,c.oid,a.attnum,'SELECT')
              ORDER BY n.nspname,c.relname,a.attname`,
      values: [expected.role],
      rowMode: "array",
    });
    selectColumns = columns.rows;
    tableWideSelect = Boolean(await scalar(client, `SELECT EXISTS(
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p')
        AND has_table_privilege($1,c.oid,'SELECT'))`, [expected.role]));
    publicDml = Boolean(await scalar(client, `SELECT
      EXISTS(
        SELECT 1 FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (
          has_table_privilege($1,c.oid,'INSERT') OR has_table_privilege($1,c.oid,'UPDATE') OR
          has_table_privilege($1,c.oid,'DELETE') OR has_table_privilege($1,c.oid,'TRUNCATE') OR
          has_table_privilege($1,c.oid,'REFERENCES') OR has_table_privilege($1,c.oid,'TRIGGER')
        )
      ) OR EXISTS(
        SELECT 1 FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped AND (
          has_column_privilege($1,c.oid,a.attnum,'INSERT') OR
          has_column_privilege($1,c.oid,a.attnum,'UPDATE') OR
          has_column_privilege($1,c.oid,a.attnum,'REFERENCES')
        )
      )`, [expected.role]));
    const memberships = await client.query({
      text: `SELECT rolname FROM pg_catalog.pg_roles
              WHERE rolname=ANY($2::text[]) AND pg_has_role($1,oid,'MEMBER')
              ORDER BY rolname`,
      values: [expected.role, ENGAGEMENT_FORBIDDEN_MEMBERSHIPS],
      rowMode: "array",
    });
    forbiddenMemberships = memberships.rows.map(([name]) => name);
  }
  const policyResult = await client.query({
    text: `SELECT policy.polname,policy.polcmd,policy.polpermissive,
                  ARRAY(SELECT role.rolname::text FROM unnest(policy.polroles) role_oid
                        JOIN pg_catalog.pg_roles role ON role.oid=role_oid ORDER BY role.rolname)::text[],
                  pg_get_expr(policy.polqual,policy.polrelid),
                  pg_get_expr(policy.polwithcheck,policy.polrelid)
             FROM pg_catalog.pg_policy policy
             JOIN pg_catalog.pg_class relation ON relation.oid=policy.polrelid
             JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
            WHERE namespace.nspname='public' AND relation.relname='nda_signatures' AND policy.polname=$1
            ORDER BY policy.polname`,
    values: [expected.rlsPolicy],
    rowMode: "array",
  });
  const policy = policyResult.rows.map((row) => ({
    name: row[0],
    command: row[1],
    permissive: row[2],
    roles: row[3],
    qual: row[4],
    withCheck: row[5],
  }));
  return assessEngagementNdaBoundary({ role, selectColumns, tableWideSelect, publicDml, forbiddenMemberships, policy }, expected);
}

async function verify() {
  if (process.env.HUSHH_TECH_SCHEMA_DATA_VERIFY !== "true") fail("EXECUTION_GATE_FALSE");
  const expected = validateExpected(JSON.parse(await readFile(new URL("./expected-manifest.v1.json", import.meta.url), "utf8")));
  const [connectorModule, pgModule] = await Promise.all([
    import("@google-cloud/cloud-sql-connector"),
    import("pg"),
  ]);
  const { AuthTypes, Connector, IpAddressTypes } = connectorModule;
  const pg = pgModule.default;
  const connector = new Connector();
  let pool;
  let client;
  try {
    const options = await connector.getOptions({
      instanceConnectionName: `${TARGET.project}:${TARGET.region}:${TARGET.instance}`,
      ipType: IpAddressTypes.PRIVATE,
      authType: AuthTypes.IAM,
    });
    pool = new pg.Pool({
      stream: options.stream,
      user: TARGET.auditUser,
      database: TARGET.database,
      password: () => undefined,
      max: 1,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 1_000,
      allowExitOnIdle: true,
    });
    client = await pool.connect();
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='8min'");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='9min'");

    const boundary = await client.query({
      text: "SELECT current_database(), current_setting('transaction_read_only'), current_setting('server_version_num')::integer",
      rowMode: "array",
    });
    if (
      boundary.rows.length !== 1 ||
      boundary.rows[0][0] !== TARGET.database ||
      boundary.rows[0][1] !== "on" ||
      Math.floor(Number(boundary.rows[0][2]) / 10_000) !== 17
    ) fail("TARGET_BOUNDARY_INVALID");

    const targetTables = [];
    for (const [index, table] of expected.sourceManifest.tables.entries()) {
      targetTables.push(await fetchTable(client, table, expected.sourceKeys.tables[index]));
    }
    const rowCount = targetTables.reduce((sum, table) => sum + table.rowCount, 0);
    if (rowCount !== 45_042 || targetTables.some((table) => !table.parity)) fail("ROW_HASH_PARITY_FAILED");

    const identity = await client.query({
      text: "SELECT count(*)::integer, count(*) FILTER (WHERE status='ACTIVE')::integer, count(*) FILTER (WHERE status='UNCLAIMED_LEGACY_PRINCIPAL')::integer FROM hushh_identity.identity_links",
      rowMode: "array",
    });
    if (identity.rows[0]?.join(":") !== "369:369:0") fail("IDENTITY_PARITY_FAILED");

    const migrationRun = await client.query({
      text: "SELECT encode(source_inventory_hash,'hex'),encode(mapping_input_hash,'hex'),status,completed_at IS NOT NULL FROM hushh_migration.migration_runs WHERE replay_key=decode($1,'hex')",
      values: [expected.replayKey],
      rowMode: "array",
    });
    if (
      migrationRun.rowCount !== 1 ||
      migrationRun.rows[0][0] !== expected.sourceManifest.manifestSha256 ||
      migrationRun.rows[0][1] !== expected.identity.artifactSha256 ||
      migrationRun.rows[0][2] !== "SUCCEEDED" ||
      migrationRun.rows[0][3] !== true
    ) fail("MIGRATION_RUN_BINDING_FAILED");

    const mappingResult = await client.query({
      text: `SELECT links.legacy_project,links.legacy_user_uuid::text,links.firebase_uid,links.provider_id,
                    encode(links.provider_subject_hash,'hex'),links.mapping_basis::text,links.status::text,
                    dispositions.terminal_disposition::text,dispositions.provider_evidence_count,dispositions.access_allowed,
                    links.provenance->>'artifactSha256'
               FROM hushh_migration.migration_runs runs
               JOIN hushh_migration.identity_migration_dispositions dispositions ON dispositions.migration_run_id=runs.id
               JOIN hushh_identity.identity_links links
                 ON links.legacy_project=dispositions.legacy_project
                AND links.legacy_user_uuid=dispositions.legacy_user_uuid
              WHERE runs.replay_key=decode($1,'hex')
              ORDER BY links.legacy_user_uuid`,
      values: [expected.replayKey],
      rowMode: "array",
    });
    if (mappingResult.rowCount !== 369 || mappingResult.rows.some((row) => row[10] !== expected.identity.artifactSha256)) {
      fail("IDENTITY_MAPPING_BINDING_FAILED");
    }
    const mappingRows = mappingResult.rows.map((row) => ({
      legacyProject: row[0],
      legacyUserUuid: row[1],
      firebaseUid: row[2],
      providerId: row[3],
      providerSubjectHash: row[4],
      mappingBasis: row[5],
      linkStatus: row[6],
      terminalDisposition: row[7],
      providerEvidenceCount: Number(row[8]),
      accessAllowed: row[9],
    }));
    const identityMappingSha256 = canonicalHash(mappingRows);
    if (identityMappingSha256 !== expected.identity.mappingSha256) fail("IDENTITY_MAPPING_DIGEST_FAILED");

    const fkResult = await client.query({
      text: `SELECT child.relname, child_column.attname, con.convalidated
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class child ON child.oid=con.conrelid
        JOIN pg_catalog.pg_namespace child_ns ON child_ns.oid=child.relnamespace
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY child_key(attnum,ord) ON true
        JOIN LATERAL unnest(con.confkey) WITH ORDINALITY parent_key(attnum,ord) ON parent_key.ord=child_key.ord
        JOIN pg_catalog.pg_attribute child_column ON child_column.attrelid=child.oid AND child_column.attnum=child_key.attnum
        JOIN pg_catalog.pg_attribute parent_column ON parent_column.attrelid=con.confrelid AND parent_column.attnum=parent_key.attnum
       WHERE con.contype='f' AND child_ns.nspname='public'
         AND con.confrelid='hushh_identity.identity_links'::regclass
         AND parent_column.attname='legacy_user_uuid'
       ORDER BY child.relname, child_column.attname`,
      rowMode: "array",
    });
    if (fkResult.rowCount !== 37 || fkResult.rows.some((row) => row[2] !== true)) fail("IDENTITY_FK_PARITY_FAILED");
    let referencedRows = 0;
    for (const [table, column] of fkResult.rows) {
      referencedRows += Number(await scalar(
        client,
        `SELECT count(*)::integer FROM public.${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL`,
      ));
    }
    if (referencedRows !== 2_363) fail("IDENTITY_REFERENCE_PARITY_FAILED");

    const catalog = {
      publicTables: Number(await scalar(client, "SELECT count(*)::integer FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")),
      publicSequences: Number(await scalar(client, "SELECT count(*)::integer FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'")),
      forcedRlsTables: Number(await scalar(client, "SELECT count(*)::integer FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity AND c.relforcerowsecurity")),
      publicPolicies: Number(await scalar(client, "SELECT count(*)::integer FROM pg_catalog.pg_policies WHERE schemaname='public' AND NOT (tablename='nda_signatures' AND policyname=$1)", [expected.expectedAccess.engagementNdaAdminFetch.rlsPolicy])),
      operationalPolicies: Number(await scalar(client, "SELECT count(*)::integer FROM pg_catalog.pg_policies WHERE schemaname IN ('hushh_identity','hushh_migration')")),
      executorPolicies: Number(await scalar(client, "SELECT count(*)::integer FROM pg_catalog.pg_policies WHERE policyname LIKE '%executor_owner_all'")),
      publicTriggers: Number(await scalar(client, "SELECT count(*)::integer FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal")),
      explicitIndexes: Number(await scalar(client, "SELECT count(*)::integer FROM pg_catalog.pg_index ix JOIN pg_catalog.pg_class idx ON idx.oid=ix.indexrelid JOIN pg_catalog.pg_class tbl ON tbl.oid=ix.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=tbl.relnamespace WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con WHERE con.conindid=idx.oid)")),
      triggerFunctions: Number(await scalar(client, "SELECT count(*)::integer FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[])", [TRIGGER_FUNCTIONS])),
      identityFunctions: Number(await scalar(client, "SELECT count(*)::integer FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hushh_identity' AND p.proname IN ('current_firebase_uid','current_legacy_user_uuid')")),
      migrationFunctions: Number(await scalar(client, "SELECT count(*)::integer FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hushh_migration' AND p.proname='reject_audit_mutation'")),
      reviewedExtensions: Number(await scalar(client, "SELECT count(*)::integer FROM pg_catalog.pg_extension WHERE extname IN ('pgcrypto','uuid-ossp','vector')")),
    };
    if (canonicalHash(catalog) !== canonicalHash(expected.expectedCatalog)) fail("CATALOG_PARITY_FAILED");

    const engagementNdaAdminFetch = await inspectEngagementNdaBoundary(
      client,
      expected.expectedAccess.engagementNdaAdminFetch,
    );
    const totalPublicPolicies = Number(await scalar(client, "SELECT count(*)::integer FROM pg_catalog.pg_policies WHERE schemaname='public'"));
    if (!engagementNdaAdminFetch.ready || totalPublicPolicies !== expected.expectedAccess.engagementNdaAdminFetch.expectedTotalPublicPolicies) {
      fail("ENGAGEMENT_BOUNDARY_NOT_READY");
    }

    const roles = await client.query({
      text: `SELECT owner.rolname, member.rolname, membership.admin_option, membership.inherit_option, membership.set_option
        FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles owner ON owner.oid=membership.roleid
        JOIN pg_catalog.pg_roles member ON member.oid=membership.member
       WHERE member.rolname IN ('postgres',$1)
         AND owner.rolname IN ('hushh_tech_schema_owner','hushh_tech_migration','hushh_tech_runtime','hushh_tech_audit','hushh_tech_rollback')
       ORDER BY owner.rolname, member.rolname`,
      values: [TARGET.webUser],
      rowMode: "array",
    });
    if (
      roles.rowCount !== 1 ||
      roles.rows[0][0] !== "hushh_tech_runtime" ||
      roles.rows[0][1] !== TARGET.webUser ||
      roles.rows[0][2] !== false ||
      roles.rows[0][3] !== true ||
      roles.rows[0][4] !== true
    ) fail("ROLE_MEMBERSHIP_PARITY_FAILED");
    const runtimeBoundary = await client.query({
      text: `SELECT
        has_database_privilege($1,current_database(),'CREATE'),
        has_database_privilege($1,current_database(),'TEMPORARY'),
        has_schema_privilege($1,'public','CREATE'),
        has_schema_privilege($1,'hushh_identity','CREATE'),
        has_schema_privilege($1,'hushh_migration','CREATE'),
        has_table_privilege($1,'hushh_identity.identity_links','SELECT'),
        (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND has_table_privilege($1,c.oid,'SELECT'))::integer`,
      values: [TARGET.webUser],
      rowMode: "array",
    });
    if (runtimeBoundary.rows[0]?.slice(0, 6).some(Boolean) || Number(runtimeBoundary.rows[0]?.[6]) !== 70) {
      fail("RUNTIME_BOUNDARY_FAILED");
    }

    await client.query("ROLLBACK");
    const payload = {
      version: 1,
      kind: "HUSHH_TECH_UAT_SCHEMA_DATA_POST_VERIFY",
      status: "CAPTURED",
      target: {
        project: TARGET.project,
        region: TARGET.region,
        instance: TARGET.instance,
        database: TARGET.database,
      },
      verifierExpectedSha256: expected.expectedSha256,
      sourceManifestSha256: expected.sourceManifest.manifestSha256,
      tableCount: targetTables.length,
      rowCount,
      rowHashParity: true,
      keyHashParity: true,
      sourceKeyManifestSha256: expected.sourceKeys.manifestSha256,
      tableParity: targetTables.map(({ name, rowCount: count, rowSha256, keySha256 }) => ({ name, rowCount: count, rowSha256, keySha256 })),
      tableParitySha256: canonicalHash(targetTables.map(({ name, rowCount: count, rowSha256, keySha256 }) => ({ name, rowCount: count, rowSha256, keySha256 }))),
      identity: { total: 369, active: 369, unclaimed: 0, foreignKeys: 37, referencedRows, mappingSha256: identityMappingSha256, importEvidenceSha256: expected.identity.importEvidenceSha256, authority: {
        projectIdSha256: expected.identity.firebaseProjectIdSha256,
        issuerSha256: expected.identity.firebaseIssuerSha256,
        audienceSha256: expected.identity.firebaseAudienceSha256,
      } },
      catalog,
      access: { engagementNdaAdminFetch, totalPublicPolicies },
      runtime: { webRuntimeMembership: true, adminOption: false, tableSelectCount: 70, elevatedPrivileges: false },
    };
    payload.evidenceSha256 = canonicalHash(payload);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } finally {
    if (client) client.release(true);
    if (pool) await pool.end();
    await connector.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await verify();
  } catch (error) {
    const code = error instanceof VerifyError ? error.code : "VERIFY_FAILED";
    process.stderr.write(`${JSON.stringify({ kind: "HUSHH_TECH_UAT_SCHEMA_DATA_POST_VERIFY", status: "BLOCKED", code })}\n`);
    process.exitCode = 1;
  }
}
