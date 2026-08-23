#!/usr/bin/env node

import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { canonicalHash, canonicalJson } from "./canonical-hash.mjs";
import { PUBLIC_TABLES, SOURCE_CONTRACT, assertSqlIdentifier } from "./contract.mjs";
import { hashRowObjects, SOURCE_BOUNDARY, UatMigrationError } from "./uat-schema-data-executor.mjs";

const ENDPOINT = "https://api.supabase.com/v1/projects/ibsisfnjxeowvdtvgzff/database/query/read-only";
const PAGE_SIZE = 1_000;

function fail(code, cause = null) {
  throw new UatMigrationError(code, cause);
}

function privateDirectory(path) {
  if (!isAbsolute(path ?? "")) fail("PRIVATE_CAPTURE_DIRECTORY_REQUIRED");
  const absolute = resolve(path);
  const repository = resolve(process.cwd());
  if (absolute === repository || absolute.startsWith(`${repository}/`)) fail("PRIVATE_CAPTURE_DIRECTORY_REQUIRED");
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  chmodSync(absolute, 0o700);
  if ((lstatSync(absolute).mode & 0o077) !== 0) fail("PRIVATE_CAPTURE_DIRECTORY_MODE_INVALID");
  return absolute;
}

function writePrivateJson(path, value) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${canonicalJson(value)}\n`, "utf8");
    chmodSync(path, 0o600);
  } finally {
    closeSync(fd);
  }
}

function selectOnly(sql) {
  const normalized = sql.trim();
  if (
    !/^(?:SELECT|WITH)\b/i.test(normalized) ||
    /\b(?:INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|SET|RESET)\b/i.test(normalized) ||
    /;\s*\S/.test(normalized)
  ) {
    fail("SOURCE_QUERY_NOT_READ_ONLY");
  }
  return normalized;
}

export function createSupabaseReadOnlyQueryClient({ accessToken, fetchImpl = fetch }) {
  if (typeof accessToken !== "string" || accessToken.length < 20 || typeof fetchImpl !== "function") {
    fail("SOURCE_ACCESS_TOKEN_REQUIRED");
  }
  return async function query(sql) {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: selectOnly(sql) }),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status !== 201) fail("SOURCE_READ_ONLY_QUERY_FAILED");
    const rows = await response.json();
    if (!Array.isArray(rows)) fail("SOURCE_READ_ONLY_RESPONSE_INVALID");
    return rows;
  };
}

export function buildTableMetadataSql() {
  const allowlist = PUBLIC_TABLES.map((table) => `'${table}'`).join(",");
  return `WITH primary_columns AS (
  SELECT cls.relname AS table_name, att.attname AS column_name
  FROM pg_catalog.pg_index idx
  JOIN pg_catalog.pg_class cls ON cls.oid = idx.indrelid
  JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
  JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY keys(attnum, ordinal) ON true
  JOIN pg_catalog.pg_attribute att ON att.attrelid = cls.oid AND att.attnum = keys.attnum
  WHERE ns.nspname = 'public' AND idx.indisprimary
)
SELECT cols.table_name, cols.column_name, cols.ordinal_position,
       cols.is_generated <> 'NEVER' AS generated,
       EXISTS (SELECT 1 FROM primary_columns pk WHERE pk.table_name=cols.table_name AND pk.column_name=cols.column_name) AS primary_key
FROM information_schema.columns cols
WHERE cols.table_schema='public' AND cols.table_name IN (${allowlist})
ORDER BY cols.table_name, cols.ordinal_position`;
}

export function buildTablePageSql(table, limit, offset) {
  assertSqlIdentifier(table, "source table");
  if (!PUBLIC_TABLES.includes(table) || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE || !Number.isSafeInteger(offset) || offset < 0) {
    fail("SOURCE_PAGE_BOUNDARY_INVALID");
  }
  return `SELECT to_jsonb(t)::text AS row_json FROM public."${table}" AS t ORDER BY to_jsonb(t)::text LIMIT ${limit} OFFSET ${offset}`;
}

export function buildAuthForeignKeySql() {
  return "SELECT child.relname AS table_name, child_att.attname AS column_name " +
    "FROM pg_catalog.pg_constraint con " +
    "JOIN pg_catalog.pg_class child ON child.oid=con.conrelid " +
    "JOIN pg_catalog.pg_namespace ns ON ns.oid=child.relnamespace " +
    "JOIN LATERAL unnest(con.conkey) WITH ORDINALITY ck(attnum,ord) ON true " +
    "JOIN LATERAL unnest(con.confkey) WITH ORDINALITY fk(attnum,ord) ON fk.ord=ck.ord " +
    "JOIN pg_catalog.pg_attribute child_att ON child_att.attrelid=child.oid AND child_att.attnum=ck.attnum " +
    "JOIN pg_catalog.pg_attribute parent_att ON parent_att.attrelid=con.confrelid AND parent_att.attnum=fk.attnum " +
    "WHERE con.contype='f' AND ns.nspname='public' AND con.confrelid='auth.users'::regclass AND parent_att.attname='id' " +
    "ORDER BY child.relname, child_att.attname";
}

export function buildUnclaimedPrincipalsSql(foreignKeys) {
  if (!Array.isArray(foreignKeys) || foreignKeys.length !== 37) fail("AUTH_FOREIGN_KEY_SET_MISMATCH");
  const unions = foreignKeys.map(({ table_name: table, column_name: column }) => {
    assertSqlIdentifier(table, "Auth child table");
    assertSqlIdentifier(column, "Auth child column");
    if (!PUBLIC_TABLES.includes(table)) fail("AUTH_FOREIGN_KEY_SET_MISMATCH");
    return `SELECT "${column}"::uuid AS legacy_user_uuid FROM public."${table}" WHERE "${column}" IS NOT NULL`;
  });
  return `WITH referenced AS (${unions.join(" UNION ")}) SELECT DISTINCT referenced.legacy_user_uuid::text AS legacy_user_uuid FROM referenced LEFT JOIN auth.users source_user ON source_user.id=referenced.legacy_user_uuid WHERE source_user.id IS NULL ORDER BY legacy_user_uuid`;
}

export function buildAuthForeignKeyParitySql(foreignKeys) {
  if (!Array.isArray(foreignKeys) || foreignKeys.length !== 37) fail("AUTH_FOREIGN_KEY_SET_MISMATCH");
  return foreignKeys.map(({ table_name: table, column_name: column }) => {
    assertSqlIdentifier(table, "Auth child table");
    assertSqlIdentifier(column, "Auth child column");
    if (!PUBLIC_TABLES.includes(table)) fail("AUTH_FOREIGN_KEY_SET_MISMATCH");
    return `SELECT '${table}'::text AS table_name, '${column}'::text AS column_name, count(*) FILTER (WHERE child."${column}" IS NOT NULL)::integer AS referenced_rows, count(*) FILTER (WHERE child."${column}" IS NOT NULL AND source_user.id IS NULL)::integer AS orphan_rows FROM public."${table}" child LEFT JOIN auth.users source_user ON source_user.id=child."${column}"`;
  }).join(" UNION ALL ");
}

export function buildAuthUsersSql() {
  return `SELECT jsonb_build_object(
  'legacyUserUuid', source_user.id::text,
  'email', source_user.email,
  'emailVerified', source_user.email_confirmed_at IS NOT NULL,
  'disabled', source_user.deleted_at IS NOT NULL OR source_user.banned_until > clock_timestamp(),
  'passwordAlgorithm', CASE WHEN source_user.encrypted_password ~ '^\\$2[aby]\\$' THEN 'BCRYPT' ELSE NULL END,
  'passwordHashBase64', CASE WHEN source_user.encrypted_password ~ '^\\$2[aby]\\$' THEN replace(encode(convert_to(source_user.encrypted_password, 'UTF8'), 'base64'), E'\\n', '') ELSE NULL END,
  'providerSubjects', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'providerId', CASE source_identity.provider WHEN 'google' THEN 'google.com' WHEN 'apple' THEN 'apple.com' ELSE source_identity.provider END,
      'subject', source_identity.provider_id
    ) ORDER BY source_identity.provider, source_identity.provider_id)
    FROM auth.identities source_identity
    WHERE source_identity.user_id=source_user.id AND source_identity.provider <> 'email'
  ), '[]'::jsonb)
)::text AS row_json
FROM auth.users source_user
ORDER BY source_user.id`;
}

async function captureIdentityPass(query, foreignKeys) {
  const [authRows, unclaimedRows] = await Promise.all([
    query(buildAuthUsersSql()),
    query(buildUnclaimedPrincipalsSql(foreignKeys)),
  ]);
  const authUsers = authRows.map(({ row_json: rowJson }) => {
    if (typeof rowJson !== "string") fail("AUTH_USER_ENVELOPE_INVALID");
    try {
      return JSON.parse(rowJson);
    } catch (error) {
      fail("AUTH_USER_ENVELOPE_INVALID", error);
    }
  });
  const unclaimedLegacyPrincipals = unclaimedRows.map(({ legacy_user_uuid: legacyUserUuid }) => ({ legacyUserUuid }));
  return {
    authUsers,
    unclaimedLegacyPrincipals,
    hash: canonicalHash({ authUsers, unclaimedLegacyPrincipals }),
  };
}

export async function captureSupabaseIdentityInputs({ query, outputDirectory }) {
  if (typeof query !== "function") fail("SOURCE_CAPTURE_ADAPTER_REQUIRED");
  const output = privateDirectory(outputDirectory);
  const foreignKeys = await query(buildAuthForeignKeySql());
  const [first, foreignKeyParity] = await Promise.all([
    captureIdentityPass(query, foreignKeys),
    query(buildAuthForeignKeyParitySql(foreignKeys)),
  ]);
  const second = await captureIdentityPass(query, foreignKeys);
  if (first.hash !== second.hash) fail("IDENTITY_DOUBLE_PASS_DRIFT");
  if (
    first.authUsers.length !== 369 ||
    first.unclaimedLegacyPrincipals.length !== 0 ||
    foreignKeyParity.length !== 37 ||
    foreignKeyParity.some((entry) => Number(entry.orphan_rows) !== 0)
  ) {
    fail("IDENTITY_SOURCE_COUNT_MISMATCH");
  }
  const normalizedForeignKeyParity = foreignKeyParity.map((entry) => ({
    table: entry.table_name,
    column: entry.column_name,
    referencedRows: Number(entry.referenced_rows),
    orphanRows: Number(entry.orphan_rows),
  }));
  writePrivateJson(resolve(output, "identity-source-inputs.private.json"), {
    version: 1,
    source: SOURCE_BOUNDARY,
    capture: { passes: 2, converged: true, transactionReadOnly: true },
    authUsers: first.authUsers,
    unclaimedLegacyPrincipals: first.unclaimedLegacyPrincipals,
    authForeignKeyParity: normalizedForeignKeyParity,
    contractDrift: "CONTRACT_DRIFT_65_TO_0",
    captureSha256: first.hash,
  });
  return Object.freeze({
    authUsers: first.authUsers.length,
    unclaimedLegacyPrincipals: first.unclaimedLegacyPrincipals.length,
    captureSha256: first.hash,
    foreignKeyCount: foreignKeys.length,
    foreignKeyParitySha256: canonicalHash(normalizedForeignKeyParity),
    referencedRows: normalizedForeignKeyParity.reduce((total, entry) => total + entry.referencedRows, 0),
    contractDrift: "CONTRACT_DRIFT_65_TO_0",
  });
}

async function captureTablePass(query, table) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await query(buildTablePageSql(table.name, PAGE_SIZE, offset));
    for (const entry of page) {
      if (!entry || typeof entry.row_json !== "string") fail("SOURCE_ROW_ENVELOPE_INVALID");
      let row;
      try {
        row = JSON.parse(entry.row_json);
      } catch (error) {
        fail("SOURCE_ROW_JSON_INVALID", error);
      }
      if (!row || typeof row !== "object" || Array.isArray(row)) fail("SOURCE_ROW_JSON_INVALID");
      rows.push(row);
    }
    if (page.length < PAGE_SIZE) break;
  }
  return { rows, rowCount: rows.length, rowSha256: hashRowObjects(rows) };
}

function normalizeMetadata(rows) {
  const byTable = new Map(PUBLIC_TABLES.map((name) => [name, []]));
  for (const row of rows) {
    if (
      !row ||
      !PUBLIC_TABLES.includes(row.table_name) ||
      typeof row.column_name !== "string" ||
      !Number.isSafeInteger(Number(row.ordinal_position)) ||
      typeof row.generated !== "boolean" ||
      typeof row.primary_key !== "boolean"
    ) {
      fail("SOURCE_METADATA_INVALID");
    }
    assertSqlIdentifier(row.column_name, "source column");
    byTable.get(row.table_name).push({
      name: row.column_name,
      ordinal: Number(row.ordinal_position),
      generated: row.generated,
      primaryKey: row.primary_key,
    });
  }
  return PUBLIC_TABLES.map((name) => {
    const columns = byTable.get(name).sort((left, right) => left.ordinal - right.ordinal);
    if (columns.length === 0 || new Set(columns.map(({ name: column }) => column)).size !== columns.length) {
      fail("SOURCE_METADATA_TABLE_SET_MISMATCH");
    }
    return {
      name,
      rowColumns: columns.map(({ name: column }) => column),
      insertColumns: columns.filter(({ generated }) => !generated).map(({ name: column }) => column),
      primaryKey: columns.filter(({ primaryKey }) => primaryKey).map(({ name: column }) => column),
    };
  });
}

export async function captureSupabaseData({ query, outputDirectory, onProgress = () => {} }) {
  if (typeof query !== "function" || typeof onProgress !== "function") fail("SOURCE_CAPTURE_ADAPTER_REQUIRED");
  const output = privateDirectory(outputDirectory);
  const boundaryRows = await query("SELECT current_database() AS database, current_setting('transaction_read_only') AS read_only, current_setting('server_version_num')::integer AS version_num, (SELECT count(*)::integer FROM auth.users) AS auth_users");
  if (
    boundaryRows.length !== 1 ||
    boundaryRows[0].database !== "postgres" ||
    boundaryRows[0].read_only !== "on" ||
    Math.floor(Number(boundaryRows[0].version_num) / 10_000) !== 17 ||
    Number(boundaryRows[0].auth_users) !== SOURCE_CONTRACT.expected.authUsers
  ) {
    fail("SOURCE_BOUNDARY_MISMATCH");
  }
  const tables = normalizeMetadata(await query(buildTableMetadataSql()));
  const manifestTables = [];
  for (const [index, table] of tables.entries()) {
    const first = await captureTablePass(query, table);
    const second = await captureTablePass(query, table);
    if (first.rowCount !== second.rowCount || first.rowSha256 !== second.rowSha256) {
      fail("SOURCE_DOUBLE_PASS_DRIFT");
    }
    const fileName = `${String(index + 1).padStart(2, "0")}-${table.name}.rows.json`;
    writePrivateJson(resolve(output, fileName), first.rows);
    manifestTables.push({
      schema: "public",
      ...table,
      rowCount: first.rowCount,
      rowSha256: first.rowSha256,
      privateFile: fileName,
      plaintextSha256: canonicalHash(first.rows),
    });
    onProgress({ completed: index + 1, total: tables.length, table: table.name, rowCount: first.rowCount, rowSha256: first.rowSha256 });
  }
  const totalRowCount = manifestTables.reduce((total, table) => total + table.rowCount, 0);
  const payload = {
    version: 1,
    kind: "HUSHH_TECH_SUPABASE_READ_ONLY_DATA_CAPTURE_DRAFT",
    source: SOURCE_BOUNDARY,
    capture: {
      transactionReadOnly: true,
      passes: 2,
      converged: true,
      rawRowsLogged: false,
      rawRowsPersistedOutsidePrivateDirectory: false,
    },
    baselineRowCount: SOURCE_CONTRACT.expected.baselineRowCount,
    observedDelta: totalRowCount - SOURCE_CONTRACT.expected.baselineRowCount,
    totalRowCount,
    tables: manifestTables,
  };
  const manifest = { ...payload, manifestSha256: canonicalHash(payload) };
  writePrivateJson(resolve(output, "source-capture-draft.manifest.json"), manifest);
  return Object.freeze({
    outputDirectory: output,
    tableCount: manifestTables.length,
    totalRowCount,
    manifestSha256: manifest.manifestSha256,
    tableParitySha256: canonicalHash(manifestTables.map(({ name, rowCount, rowSha256 }) => ({ name, rowCount, rowSha256 }))),
  });
}

export function sealSourceCaptureManifest({ draft, bundle }) {
  if (
    draft?.kind !== "HUSHH_TECH_SUPABASE_READ_ONLY_DATA_CAPTURE_DRAFT" ||
    draft.manifestSha256 !== canonicalHash(Object.fromEntries(Object.entries(draft).filter(([key]) => key !== "manifestSha256"))) ||
    bundle?.encryption !== "CLOUD_KMS" ||
    !/^[a-f0-9]{64}$/.test(bundle.objectSha256 ?? "") ||
    !/^[1-9][0-9]{0,19}$/.test(String(bundle.generation ?? "")) ||
    bundle.kmsKeyVersion !== "projects/hushh-tech-uat/locations/us-central1/keyRings/hushh-tech-cutover-uat/cryptoKeys/migration-archive/cryptoKeyVersions/1" ||
    bundle.bucket !== "hushh-tech-migration-evidence-uat" ||
    !/^source-data\/uat\/[a-f0-9]{64}(?:-rows)?\.tar\.gz$/.test(bundle.object ?? "")
  ) fail("SOURCE_BUNDLE_BINDING_INVALID");
  const tables = draft.tables.map(({ privateFile, plaintextSha256, ...table }) => ({
    ...table,
    artifact: {
      encryption: "CLOUD_KMS",
      ciphertextSha256: bundle.objectSha256,
      generation: String(bundle.generation),
      containsRows: true,
      bucket: bundle.bucket,
      object: bundle.object,
      member: privateFile,
      memberSha256: plaintextSha256,
      kmsKeyVersion: bundle.kmsKeyVersion,
    },
  }));
  const payload = {
    version: 1,
    kind: "HUSHH_TECH_SUPABASE_READ_ONLY_DATA_CAPTURE",
    source: draft.source,
    capture: draft.capture,
    baselineRowCount: draft.baselineRowCount,
    observedDelta: draft.observedDelta,
    totalRowCount: draft.totalRowCount,
    tables,
    contractDrift: "CONTRACT_DRIFT_65_TO_0",
    sourceDraftManifestSha256: draft.manifestSha256,
    bundle: { ...bundle, generation: String(bundle.generation) },
  };
  return Object.freeze({ ...payload, manifestSha256: canonicalHash(payload) });
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((arg) => {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) fail("CAPTURE_ARGUMENT_INVALID");
    return [match[1], match[2]];
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tokenFile = resolve(args["access-token-file"] ?? "");
  if (!isAbsolute(args["access-token-file"] ?? "") || (lstatSync(tokenFile).mode & 0o077) !== 0) {
    fail("SOURCE_ACCESS_TOKEN_FILE_MODE_INVALID");
  }
  const accessToken = readFileSync(tokenFile, "utf8").trim();
  const query = createSupabaseReadOnlyQueryClient({ accessToken });
  const result = await captureSupabaseData({
    query,
    outputDirectory: args["output-directory"],
    onProgress: ({ completed, total, table, rowCount, rowSha256 }) => {
      process.stdout.write(`${JSON.stringify({ status: "TABLE_CAPTURED", completed, total, table, rowCount, rowSha256 })}\n`);
    },
  });
  process.stdout.write(`${JSON.stringify({ status: "CAPTURED", tableCount: result.tableCount, totalRowCount: result.totalRowCount, manifestSha256: result.manifestSha256, tableParitySha256: result.tableParitySha256 })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    const code = error instanceof UatMigrationError ? error.code : "SOURCE_CAPTURE_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "BLOCKED", blocker: code })}\n`);
    process.exitCode = 1;
  });
}
