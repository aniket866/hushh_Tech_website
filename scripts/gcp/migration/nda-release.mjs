import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Connector } from '@google-cloud/cloud-sql-connector';

// A release-specific executor, not a directory-scanning migration engine.
export const MIGRATIONS = Object.freeze([
  { id: '003', file: '003_firebase_native_mapping_basis.sql', sha256: 'a49d01391ff53f7aa6e246646df09182737b398ab5b612ff8346f1c0aa21dde5' },
  { id: '004', file: '004_firebase_native_provisioning.sql', sha256: 'bc4045b25b7d42bcf3aa286fa2619f00f53d93863e94737f717864343c8e2eea' },
]);
const OWNER = 'hushh_tech_schema_owner';
const WEB = 'hushh-tech-web-uat@hushh-tech-uat.iam';
const LEDGER = 'hushh_migration.nda_release_migrations';
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

export async function loadMigrations() {
  return Promise.all(MIGRATIONS.map(async (entry) => {
    const sql = await readFile(new URL(`../../../migration/sql/${entry.file}`, import.meta.url), 'utf8');
    if (createHash('sha256').update(sql).digest('hex') !== entry.sha256) fail('MIGRATION_BYTES_CHANGED');
    // The reviewed files own one transaction each. Only move its boundaries so
    // the completion marker and postconditions commit WITH the migration.
    if ((sql.match(/^BEGIN;$/gm) || []).length !== 1 || !sql.endsWith('COMMIT;\n')) fail('MIGRATION_BOUNDARY_CHANGED');
    return { ...entry, body: sql.replace(/^BEGIN;$/m, '').replace(/COMMIT;\n$/, '') };
  }));
}

export async function preflight(client) {
  await client.query('BEGIN READ ONLY');
  try {
    const { rows: [context] } = await client.query(`SELECT current_database() AS database, current_user AS actor,
      current_setting('server_version_num')::int AS version, rolsuper, rolcreaterole
      FROM pg_roles WHERE rolname=current_user`);
    const { rows: members } = await client.query(`SELECT r.rolname AS role, u.rolname AS member,
      pg_get_userbyid(m.grantor) AS grantor, m.admin_option, m.inherit_option, m.set_option FROM pg_auth_members m
      JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member
      WHERE r.rolname IN ('hushh_tech_schema_owner','hushh_tech_identity_provisioner')`);
    const { rows: tables } = await client.query(`SELECT c.relname, pg_get_userbyid(c.relowner) AS owner,
      c.relrowsecurity AS rls, c.relforcerowsecurity AS force FROM pg_class c
      WHERE c.oid IN ('hushh_identity.identity_links'::regclass,'public.users'::regclass,'public.nda_signatures'::regclass)`);
    const { rows: [owner] } = await client.query(`SELECT rolsuper,rolcanlogin,rolinherit,rolcreaterole,rolbypassrls
      FROM pg_roles WHERE rolname=$1`, [OWNER]);
    const { rows: [state] } = await client.query(`SELECT to_regclass('${LEDGER}')::text AS ledger,
      to_regclass('hushh_identity.runtime_admission')::text AS admission,
      to_regclass('hushh_identity.provider_ownership')::text AS ownership,
      to_regrole('hushh_tech_identity_provisioner')::text AS provisioner_role,
      to_regprocedure('hushh_identity.ensure_current_application_principal(jsonb)')::text AS provisioner_function,
      EXISTS(SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace
        WHERE n.nspname='hushh_identity' AND t.typname='identity_mapping_basis' AND e.enumlabel='FIREBASE_NATIVE') AS native_enum`);
    let applied = [];
    if (state.ledger) {
      const { rows: [acl] } = await client.query(`SELECT pg_get_userbyid(relowner) AS owner, relrowsecurity AS rls,
        relforcerowsecurity AS force FROM pg_class WHERE oid=$1::regclass`, [LEDGER]);
      if (acl.owner !== OWNER || !acl.rls || !acl.force) fail('RELEASE_LEDGER_UNTRUSTED');
      applied = (await client.query(`SELECT migration_id,sha256,release_sha FROM ${LEDGER} ORDER BY migration_id`)).rows;
    }
    const blockers = [];
    if (context.database !== 'hushh_tech_app' || context.actor !== 'postgres' || context.version < 170000 || context.version >= 180000) blockers.push('WRONG_DATABASE_ACTOR_OR_VERSION');
    if (!owner || Object.values(owner).some(Boolean) || members.length) blockers.push('SEALED_ROLE_DRIFT');
    if (tables.length !== 3 || tables.some((t) => t.owner !== OWNER || !t.rls || !t.force)) blockers.push('TABLE_SECURITY_DRIFT');
    // CREATEROLE is not ADMIN OPTION on a pre-existing role in PG17. Cloud SQL
    // postgres is not a superuser. Do NOT infer an undocumented managed-service
    // privilege or expose a boolean override to turn uncertainty into authority.
    if (!context.rolsuper) {
      blockers.push('ROLE_ADMIN_CAPABILITY_NOT_PROVEN');
      // PG17 also automatically grants a new role to its CREATEROLE creator
      // WITH ADMIN TRUE (grantor = bootstrap superuser). The creator cannot
      // remove that grant, so 004's zero-members postcondition needs a proven
      // managed administration path even AFTER existing-owner drift is fixed.
      blockers.push('PROVISIONER_SEAL_CAPABILITY_NOT_PROVEN');
    }
    if (!context.rolsuper && !context.rolcreaterole) blockers.push('CREATE_ROLE_DENIED');
    if (applied.some((r, i) => r.migration_id !== MIGRATIONS[i]?.id || r.sha256 !== MIGRATIONS[i]?.sha256)) blockers.push('RELEASE_LEDGER_MISMATCH');
    if (Boolean(state.native_enum) !== applied.some((r) => r.migration_id === '003') ||
        [state.admission, state.ownership, state.provisioner_role, state.provisioner_function]
          .some((value) => Boolean(value) !== applied.some((r) => r.migration_id === '004'))) blockers.push('UNRECORDED_OR_PARTIAL_MIGRATION');
    // A ledger entry is not sufficient proof: recheck live security even in
    // read-only preflight, not only after a caller opts into apply mode.
    if (!blockers.length) for (const row of applied) await postconditions(client, row.migration_id);
    return { ready: blockers.length === 0, blockers, context, members, applied };
  } finally { await client.query('ROLLBACK'); }
}

async function postconditions(client, id) {
  const { rows: [sealed] } = await client.query(`SELECT count(*)::int AS count FROM pg_auth_members m
    JOIN pg_roles r ON r.oid=m.roleid WHERE r.rolname IN ('hushh_tech_schema_owner','hushh_tech_identity_provisioner')`);
  if (sealed.count !== 0) fail('POSTCONDITION_ROLE_NOT_SEALED');
  if (id === '004') {
    const { rows: [fn] } = await client.query(`SELECT p.prosecdef,pg_get_userbyid(p.proowner) AS owner,p.proconfig,
      has_function_privilege($1,p.oid,'EXECUTE') AS web_execute
      FROM pg_proc p WHERE p.oid='hushh_identity.ensure_current_application_principal(jsonb)'::regprocedure`, [WEB]);
    if (!fn?.prosecdef || fn.owner !== 'hushh_tech_identity_provisioner' || !fn.web_execute ||
        JSON.stringify(fn.proconfig) !== JSON.stringify(['search_path=pg_catalog, hushh_identity, pg_temp'])) fail('POSTCONDITION_FUNCTION_INVALID');
    const { rows: [access] } = await client.query(`SELECT has_table_privilege($1,'hushh_identity.identity_links','INSERT,UPDATE,DELETE') AS identity_write,
      has_table_privilege($1,'hushh_identity.provider_ownership','INSERT,UPDATE,DELETE') AS ownership_write`, [WEB]);
    if (access.identity_write || access.ownership_write) fail('POSTCONDITION_WEB_IDENTITY_WRITE');
  }
}

async function recordCompletion(client, migration, releaseSha) {
  await client.query(`GRANT hushh_tech_schema_owner TO postgres; SET LOCAL ROLE hushh_tech_schema_owner`);
  if (migration.id === '003') {
    await client.query(`CREATE TABLE ${LEDGER} (
      migration_id text PRIMARY KEY CHECK(migration_id IN ('003','004')),
      sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
      release_sha text NOT NULL CHECK(release_sha ~ '^[0-9a-f]{40}$'), applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
      ALTER TABLE ${LEDGER} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${LEDGER} FORCE ROW LEVEL SECURITY;
      REVOKE ALL ON ${LEDGER} FROM PUBLIC;
      GRANT USAGE ON SCHEMA hushh_migration TO postgres;
      GRANT SELECT,INSERT ON ${LEDGER} TO postgres;
      CREATE POLICY nda_release_admin ON ${LEDGER} TO postgres USING(true) WITH CHECK(true)`);
  }
  await client.query('RESET ROLE; REVOKE hushh_tech_schema_owner FROM postgres');
  await client.query(`INSERT INTO ${LEDGER}(migration_id,sha256,release_sha) VALUES($1,$2,$3)`, [migration.id, migration.sha256, releaseSha]);
}

export async function runRelease(client, { mode = 'preflight', releaseSha } = {}) {
  if (!['preflight', 'apply'].includes(mode)) fail('UNSUPPORTED_MODE');
  if (mode === 'apply' && !/^[0-9a-f]{40}$/.test(releaseSha || '')) fail('APPROVED_RELEASE_SHA_REQUIRED');
  const migrations = await loadMigrations();
  if (mode === 'preflight') return preflight(client);
  // Session lock spans both committed files and also serializes retries.
  const { rows: [lock] } = await client.query("SELECT pg_try_advisory_lock(1983004) AS acquired");
  if (!lock.acquired) fail('MIGRATION_ALREADY_RUNNING');
  try {
    const report = await preflight(client);
    if (!report.ready) fail(report.blockers.join(','));
    for (const migration of migrations) {
      if (report.applied.some((r) => r.migration_id === migration.id)) {
        await postconditions(client, migration.id);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'");
        await client.query(migration.body);
        await postconditions(client, migration.id);
        await recordCompletion(client, migration, releaseSha);
        await postconditions(client, migration.id);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return { ready: true, applied: migrations.map((m) => m.id) };
  } finally { await client.query('SELECT pg_advisory_unlock(1983004)'); }
}

async function main() {
  // Bind to the existing job and metadata identity, not arbitrary DB_HOST/URL.
  const metadata = async (path) => {
    const response = await fetch(`http://metadata.google.internal/computeMetadata/v1/${path}`, {
      headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || response.headers.get('metadata-flavor') !== 'Google') fail('METADATA_UNAVAILABLE');
    return (await response.text()).trim();
  };
  if (process.env.CLOUD_RUN_JOB !== 'schema-migrator' ||
      await metadata('project/project-id') !== 'hushh-tech-uat' ||
      await metadata('instance/service-accounts/default/email') !== 'hushh-tech-migration-uat@hushh-tech-uat.iam.gserviceaccount.com') fail('EXECUTOR_TARGET_INVALID');
  if (!process.env.PGPASSWORD) fail('POSTGRES_SECRET_REQUIRED');
  const connector = new Connector();
  let client;
  try {
    const options = await connector.getOptions({ instanceConnectionName: 'hushh-tech-uat:us-central1:hushh-tech-app-pg-uat', ipType: 'PRIVATE' });
    client = new pg.Client({ ...options, user: 'postgres', password: process.env.PGPASSWORD, database: 'hushh_tech_app', connectionTimeoutMillis: 10000 });
    await client.connect();
    const report = await runRelease(client, { mode: process.env.MODE || 'preflight', releaseSha: process.env.RELEASE_SHA });
    console.log(JSON.stringify(report));
    if (!report.ready) process.exitCode = 1;
  } finally { await client?.end(); connector.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('NDA_RELEASE_FAILED: consult the sanitized preflight; raw SQL/credentials are not logged.'); process.exitCode = 1; });
}
