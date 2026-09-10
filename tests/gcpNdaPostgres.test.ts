import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { executeNdaRequest, NDA_DOCUMENTS } from '../api/shared/gcpNdaRuntime.js';
import { ensureApplicationPrincipal, prepareIdentityEvidence } from '../api/shared/gcpIdentityProvisioning.js';
import { withFirebaseTransaction } from '../api/shared/gcpDataRuntime.js';
import { preflight, runRelease } from '../scripts/gcp/migration/nda-release.mjs';

// Explicit local binaries only; never accepts a remote DATABASE_URL. Requires
// PG17 like UAT. Set HUSHH_TEST_POSTGRES_BIN in CI/developer environments.
const bin = process.env.HUSHH_TEST_POSTGRES_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const available = existsSync(join(bin, 'initdb'));
if (process.env.REQUIRE_NDA_POSTGRES === 'true' && !available) throw new Error('PostgreSQL 17 binaries are required');
const webRole = 'hushh-tech-web-uat@hushh-tech-uat.iam';
const fingerprint = (provider: string, subject: string) => createHash('sha256').update(`${provider}\0${subject.normalize('NFC')}`).digest('hex');
const actor = (uid: string) => ({ uid, sub: uid, aud: 'hushh-tech-uat', iss: 'https://securetoken.google.com/hushh-tech-uat', email: 'fixture@example.invalid' });
const account = (uid: string, subject = uid, provider = 'google.com', createdAt = '2026-09-01T00:00:00.000Z') => ({ uid, disabled: false, metadata: { creationTime: createdAt }, providerData: [{ providerId: provider, uid: subject }] });
const signing = { kind: 'nda', operation: 'sign', signing: { signerName: 'Test Signer', ndaVersion: 'v1.0', consentVersion: 'v1.0', consentAccepted: true, documentsAcknowledged: [...NDA_DOCUMENTS], pdfUrl: null } };

describe.skipIf(!available)('real PostgreSQL 17 identity + NDA boundary (disposable local catalog)', () => {
  let directory: string;
  let admin: pg.Pool;
  let runtime: pg.Pool;
  let started = false;
  const deps = (uid: string, subject = uid, provider = 'google.com') => ({ pool: runtime, readAccount: async () => account(uid, subject, provider) });
  const bootstrap = async (uid: string, subject = uid, provider = 'google.com') => {
    const evidence = await prepareIdentityEvidence(actor(uid), deps(uid, subject, provider));
    return withFirebaseTransaction(uid, (client: pg.PoolClient) => ensureApplicationPrincipal(client, evidence), { pool: runtime });
  };
  beforeAll(async () => {
    expect(execFileSync(join(bin, 'postgres'), ['--version'], { encoding: 'utf8' })).toMatch(/PostgreSQL\) 17\./);
    directory = mkdtempSync(join(tmpdir(), 'hushh-nda-pg-'));
    execFileSync(join(bin, 'initdb'), ['-D', join(directory, 'data'), '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'], { stdio: 'pipe' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', join(directory, 'data'), '-l', join(directory, 'postgres.log'), '-o', `-k ${directory} -h '' -p 55439`, '-w', 'start'], { stdio: 'pipe' });
    started = true;
    const config = { host: directory, port: 55439, user: 'postgres' };
    const initial = new pg.Client({ ...config, database: 'postgres' });
    await initial.connect();
    await initial.query('CREATE DATABASE hushh_tech_app');
    await initial.end();
    admin = new pg.Pool({ ...config, database: 'hushh_tech_app' });
    for (const file of ['migration/sql/001_identity_migration_foundation.sql', 'tests/fixtures/ndaUatCatalog.sql']) {
      await admin.query(readFileSync(file, 'utf8'));
    }
    await admin.query(`INSERT INTO hushh_identity.identity_links(legacy_project,legacy_user_uuid,firebase_uid,provider_id,provider_subject_hash,mapping_basis,status,provenance)
      VALUES ('ibsisfnjxeowvdtvgzff','10000000-0000-4000-8000-000000000001','existing','google.com',decode($1,'hex'),'PROVIDER_SUBJECT','ACTIVE','{"artifactSha256":"synthetic-fixture"}')`, [fingerprint('google.com', 'existing')]);
    await admin.query(`INSERT INTO public.users(id) VALUES ('10000000-0000-4000-8000-000000000001')`);
    const originalIdentity = (await admin.query('SELECT to_jsonb(l) AS evidence FROM hushh_identity.identity_links l')).rows;
    const executor = await admin.connect();
    try {
      // Reproduce the newly observed UAT drift in this LOCAL fixture only.
      await executor.query(`GRANT hushh_tech_schema_owner TO "${webRole}"`);
      expect((await preflight(executor)).blockers).toContain('SEALED_ROLE_DRIFT');
      await expect(runRelease(executor, { mode: 'apply', releaseSha: 'd'.repeat(40) })).rejects.toThrow('SEALED_ROLE_DRIFT');
      expect((await executor.query("SELECT to_regclass('hushh_migration.nda_release_migrations') AS ledger")).rows[0].ledger).toBeNull();
      await executor.query(`REVOKE hushh_tech_schema_owner FROM "${webRole}"`);
      expect((await runRelease(executor)).ready).toBe(true);
      await executor.query(`CREATE FUNCTION public.fixture_block_004() RETURNS event_trigger LANGUAGE plpgsql AS $$
        BEGIN IF EXISTS(SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE object_identity='hushh_identity.runtime_admission')
          THEN RAISE EXCEPTION 'synthetic 004 failure'; END IF; END $$;
        CREATE EVENT TRIGGER fixture_block_004 ON ddl_command_end EXECUTE FUNCTION public.fixture_block_004()`);
      await expect(runRelease(executor, { mode: 'apply', releaseSha: 'd'.repeat(40) })).rejects.toThrow('synthetic 004 failure');
      expect((await executor.query('SELECT migration_id FROM hushh_migration.nda_release_migrations')).rows).toEqual([{ migration_id: '003' }]);
      expect((await executor.query("SELECT to_regclass('hushh_identity.runtime_admission') AS admission")).rows[0].admission).toBeNull();
      expect((await preflight(executor)).ready).toBe(true);
      await executor.query('DROP EVENT TRIGGER fixture_block_004; DROP FUNCTION public.fixture_block_004()');
      await runRelease(executor, { mode: 'apply', releaseSha: 'd'.repeat(40) });
      const firstLedger = (await executor.query('SELECT * FROM hushh_migration.nda_release_migrations ORDER BY migration_id')).rows;
      expect(firstLedger.map((r) => r.migration_id)).toEqual(['003', '004']);
      await runRelease(executor, { mode: 'apply', releaseSha: 'd'.repeat(40) });
      expect((await executor.query('SELECT * FROM hushh_migration.nda_release_migrations ORDER BY migration_id')).rows).toEqual(firstLedger);
      expect((await executor.query("SELECT to_jsonb(l)-'firebase_project' AS evidence FROM hushh_identity.identity_links l")).rows).toEqual(originalIdentity);
    } finally { executor.release(); }
    runtime = new pg.Pool({ host: directory, port: 55439, user: webRole, database: 'hushh_tech_app', max: 1 });
    for (const [key, value] of Object.entries({ GCP_DATA_RUNTIME_ENABLED: 'true', GOOGLE_CLOUD_PROJECT: 'hushh-tech-uat', GCP_PROJECT: 'hushh-tech-uat', CLOUD_SQL_INSTANCE_CONNECTION_NAME: 'hushh-tech-uat:us-central1:hushh-tech-app-pg-uat', CLOUD_SQL_DATABASE: 'hushh_tech_app', CLOUD_SQL_IAM_USER: webRole, FIREBASE_PROJECT_ID: 'hushh-tech-uat', GCP_STORAGE_BUCKET_PREFIX: 'hushh-tech-uat' })) vi.stubEnv(key, value);
  }, 60000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await runtime?.end();
    await admin?.end();
    if (started) execFileSync(join(bin, 'pg_ctl'), ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
    // Only the test-owned directory returned by mkdtemp is removed.
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('resolves a migrated user without changing UUID or provenance while creation is disabled', async () => {
    expect(await bootstrap('existing')).toEqual({ application_user_id: '10000000-0000-4000-8000-000000000001', created: false });
    expect((await admin.query(`SELECT provenance FROM hushh_identity.identity_links WHERE firebase_uid='existing'`)).rows[0].provenance).toEqual({ artifactSha256: 'synthetic-fixture' });
    expect((await executeNdaRequest({ kind: 'nda', operation: 'status' }, actor('existing'), {}, deps('existing'))).data.hasSignedNda).toBe(false);
  });
  it('proves PG17 CREATEROLE alone cannot execute the reviewed sealed-role lifecycle', async () => {
    const client = await admin.connect();
    try {
      // Local, rolled-back reproduction of the managed postgres attributes.
      // Do not mistake our bootstrap superuser's successful migrations for
      // proof that Cloud SQL postgres can administer an existing sealed role.
      await client.query('BEGIN');
      await client.query('CREATE ROLE fixture_cloudsql_postgres LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS');
      await client.query('SET SESSION AUTHORIZATION fixture_cloudsql_postgres');
      await client.query('SAVEPOINT owner_grant');
      await expect(client.query('GRANT hushh_tech_schema_owner TO fixture_cloudsql_postgres')).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK TO SAVEPOINT owner_grant');
      await client.query('CREATE ROLE fixture_provisioner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOBYPASSRLS');
      const grants = () => client.query(`SELECT m.admin_option,m.inherit_option,m.set_option,pg_get_userbyid(m.grantor) AS grantor
        FROM pg_auth_members m WHERE m.roleid='fixture_provisioner'::regrole`);
      expect((await grants()).rows).toEqual([{ admin_option: true, inherit_option: false, set_option: false, grantor: 'postgres' }]);
      await client.query('GRANT fixture_provisioner TO fixture_cloudsql_postgres');
      await client.query('SET LOCAL ROLE fixture_provisioner; RESET ROLE');
      await client.query('REVOKE fixture_provisioner FROM fixture_cloudsql_postgres');
      // The bootstrap-granted ADMIN membership survives the creator's REVOKE.
      // 004's final zero-members assertion must reject this, not ignore it.
      expect((await grants()).rows).toEqual([{ admin_option: true, inherit_option: false, set_option: false, grantor: 'postgres' }]);
    } finally {
      await client.query('ROLLBACK');
      await client.query('RESET SESSION AUTHORIZATION');
      client.release();
    }
  });
  it('denies unmapped users until governed admission and complete ownership evidence exist', async () => {
    await expect(bootstrap('new')).rejects.toMatchObject({ code: 'IDENTITY_CREATION_DISABLED' });
    await admin.query(`UPDATE hushh_identity.runtime_admission SET creation_enabled=true`);
    await expect(bootstrap('new')).rejects.toMatchObject({ code: 'IDENTITY_EVIDENCE_UNAVAILABLE' });
    await admin.query(`UPDATE hushh_identity.runtime_admission SET evidence_complete=true,new_accounts_after='2026-08-31Z',evidence_reference='synthetic-reviewed-snapshot'`);
    await expect(bootstrap('new')).rejects.toMatchObject({ code: 'IDENTITY_EVIDENCE_UNAVAILABLE' });
    await admin.query(`INSERT INTO hushh_identity.provider_ownership VALUES ('google.com',decode($1,'hex'),'10000000-0000-4000-8000-000000000001','OWNED','synthetic-reviewed-snapshot')`, [fingerprint('google.com', 'existing')]);
  });
  it('atomically provisions a native principal, minimal user, ownership and truthful provenance', async () => {
    const result = await bootstrap('new');
    expect(result.created).toBe(true);
    expect(result.application_user_id).toMatch(/^[0-9a-f-]{36}$/);
    const row = (await admin.query(`SELECT l.*,u.id AS user_id FROM hushh_identity.identity_links l JOIN public.users u ON u.id=l.legacy_user_uuid WHERE firebase_uid='new'`)).rows[0];
    expect(row.legacy_project).toBeNull();
    expect(row.mapping_basis).toBe('FIREBASE_NATIVE');
    expect(row.provenance.origin).toBe('FIREBASE_NATIVE');
    expect(row.user_id).toBe(result.application_user_id);
    expect(await bootstrap('new')).toEqual({ ...result, created: false });
  });
  it('serializes concurrent same-user provisioning on separate connections', async () => {
    const concurrentPool = new pg.Pool({ host: directory, port: 55439, user: webRole, database: 'hushh_tech_app', max: 4 });
    try {
      const evidence = await prepareIdentityEvidence(actor('concurrent'), deps('concurrent'));
      const results = await Promise.all(Array.from({ length: 4 }, () => withFirebaseTransaction('concurrent', (client: pg.PoolClient) => ensureApplicationPrincipal(client, evidence), { pool: concurrentPool })));
      expect(new Set(results.map((result) => result.application_user_id)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
    } finally { await concurrentPool.end(); }
  });
  it('supports Apple-native evidence without modifying OAuth', async () => {
    expect((await bootstrap('apple-new', 'apple-subject', 'apple.com')).created).toBe(true);
  });
  it('allows only one principal when different Firebase UIDs concurrently claim one provider', async () => {
    const concurrentPool = new pg.Pool({ host: directory, port: 55439, user: webRole, database: 'hushh_tech_app', max: 2 });
    try {
      const results = await Promise.allSettled(['provider-race-a', 'provider-race-b'].map(async (uid) => {
        const evidence = await prepareIdentityEvidence(actor(uid), deps(uid, 'shared-provider-race'));
        return withFirebaseTransaction(uid, (client: pg.PoolClient) => ensureApplicationPrincipal(client, evidence), { pool: concurrentPool });
      }));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const denied = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(denied.reason).toMatchObject({ code: 'IDENTITY_REVIEW_REQUIRED' });
      expect((await admin.query(`SELECT count(*) FROM hushh_identity.identity_links WHERE firebase_uid IN ('provider-race-a','provider-race-b')`)).rows[0].count).toBe('1');
    } finally { await concurrentPool.end(); }
  });
  it('serializes concurrent signing retries without replacing evidence', async () => {
    const concurrentPool = new pg.Pool({ host: directory, port: 55439, user: webRole, database: 'hushh_tech_app', max: 3 });
    try {
      const results = await Promise.all(Array.from({ length: 3 }, () => executeNdaRequest(signing, actor('concurrent-sign'), {}, {
        pool: concurrentPool, readAccount: async () => account('concurrent-sign'),
      })));
      expect(results.filter((result) => result.data.wasInserted)).toHaveLength(1);
      expect(results.filter((result) => result.data.shouldNotify)).toHaveLength(1);
      expect(new Set(results.map((result) => result.data.signedAt)).size).toBe(1);
    } finally { await concurrentPool.end(); }
  });
  it('denies revoked mappings, provider collisions and pre-cutoff unknown identities', async () => {
    await admin.query(`UPDATE hushh_identity.identity_links SET status='REVOKED',revoked_at=now() WHERE firebase_uid='concurrent'`);
    await expect(bootstrap('concurrent')).rejects.toMatchObject({ code: 'IDENTITY_DENIED' });
    await expect(bootstrap('other', 'existing')).rejects.toMatchObject({ code: 'IDENTITY_REVIEW_REQUIRED' });
    await expect(bootstrap('other', 'concurrent')).rejects.toMatchObject({ code: 'IDENTITY_REVIEW_REQUIRED' });
    const evidence = await prepareIdentityEvidence(actor('old-unmapped'), { readAccount: async () => account('old-unmapped', 'old-unmapped', 'google.com', '2026-08-01Z') });
    await expect(withFirebaseTransaction('old-unmapped', (client: pg.PoolClient) => ensureApplicationPrincipal(client, evidence), { pool: runtime })).rejects.toMatchObject({ code: 'IDENTITY_REVIEW_REQUIRED' });
  });
  it('denies wrong project context even with a valid existing mapping', async () => {
    await expect(withFirebaseTransaction('existing', async (client: pg.PoolClient) => {
      await client.query(`SELECT set_config('app.firebase_project','not-uat',true)`);
      return ensureApplicationPrincipal(client, {});
    }, { pool: runtime })).rejects.toMatchObject({ code: 'IDENTITY_DENIED' });
  });
  it('rolls back provisioning and user creation with a failed consent transaction', async () => {
    await admin.query(`ALTER TABLE public.nda_signatures ADD CONSTRAINT synthetic_failure CHECK (signer_name <> 'Rollback Test')`);
    await expect(executeNdaRequest({ ...signing, signing: { ...signing.signing, signerName: 'Rollback Test' } }, actor('rollback-new'), {}, deps('rollback-new'))).rejects.toMatchObject({ code: '23514' });
    expect((await admin.query(`SELECT count(*) FROM hushh_identity.identity_links WHERE firebase_uid='rollback-new'`)).rows[0].count).toBe('0');
    expect((await admin.query(`SELECT count(*) FROM hushh_identity.provider_ownership WHERE subject_hash=decode($1,'hex')`, [fingerprint('google.com', 'rollback-new')])).rows[0].count).toBe('0');
    await admin.query(`ALTER TABLE public.nda_signatures DROP CONSTRAINT synthetic_failure`);
  });
  it('persists scalar signing response, JSONB consent and immutable identical retries', async () => {
    const first = await executeNdaRequest(signing, actor('existing'), { userAgent: 'Synthetic test' }, deps('existing'));
    expect(first.data).toMatchObject({ success: true, wasInserted: true, shouldNotify: true, signerName: 'Test Signer', ndaVersion: 'v1.0' });
    expect(Array.isArray(first.data)).toBe(false);
    const before = (await admin.query('SELECT * FROM public.nda_signatures')).rows;
    expect(before[0].documents_acknowledged).toEqual(NDA_DOCUMENTS);
    const retry = await executeNdaRequest(signing, actor('existing'), { userAgent: 'Changed device' }, deps('existing'));
    expect(retry.data).toMatchObject({ signedAt: first.data.signedAt, wasInserted: false, shouldNotify: false });
    expect((await admin.query('SELECT * FROM public.nda_signatures')).rows).toEqual(before);
    expect((await executeNdaRequest({ kind: 'nda', operation: 'status' }, actor('existing'), {}, deps('existing'))).data.hasSignedNda).toBe(true);
    expect((await executeNdaRequest({ kind: 'nda', operation: 'record' }, actor('existing'), {}, deps('existing'))).data.signerName).toBe('Test Signer');
  });
  it('rejects changed consent instead of overwriting signed evidence', async () => {
    await expect(executeNdaRequest({ ...signing, signing: { ...signing.signing, signerName: 'Different Signer' } }, actor('existing'), {}, deps('existing'))).rejects.toMatchObject({ code: 'NDA_EVIDENCE_CONFLICT' });
  });
  it('enforces RLS and cleans pooled context on both success and rollback', async () => {
    expect((await runtime.query('SELECT * FROM public.nda_signatures')).rows).toHaveLength(0);
    await withFirebaseTransaction('new', async (client: pg.PoolClient) => {
      expect((await client.query('SELECT * FROM public.nda_signatures')).rows).toHaveLength(0);
    }, { pool: runtime });
    await expect(withFirebaseTransaction('new', (client: pg.PoolClient) => client.query(`INSERT INTO public.nda_signatures(user_id,signer_name) VALUES ('10000000-0000-4000-8000-000000000001','Forged')`), { pool: runtime })).rejects.toMatchObject({ code: '42501' });
    const context = (await runtime.query(`SELECT NULLIF(current_setting('app.firebase_uid',true),'') AS uid,NULLIF(current_setting('app.firebase_project',true),'') AS project`)).rows[0];
    expect(context).toEqual({ uid: null, project: null });
    expect((await runtime.query('SELECT * FROM public.nda_signatures')).rows).toHaveLength(0);
  });
  it('seals provisioning role and denies direct identity writes or public execution', async () => {
    await expect(runtime.query('INSERT INTO hushh_identity.identity_links DEFAULT VALUES')).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('SET ROLE hushh_tech_identity_provisioner')).rejects.toMatchObject({ code: '42501' });
    const row = (await admin.query(`SELECT rolsuper,rolcanlogin,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname='hushh_tech_identity_provisioner'`)).rows[0];
    expect(Object.values(row)).toEqual([false, false, false, false]);
    expect((await admin.query(`SELECT count(*) FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='hushh_tech_identity_provisioner')`)).rows[0].count).toBe('0');
    expect((await admin.query(`SELECT has_function_privilege('public','hushh_identity.ensure_current_application_principal(jsonb)','EXECUTE') AS allowed`)).rows[0].allowed).toBe(false);
  });
  it('keeps native resolution after the emergency creation switch is disabled', async () => {
    await admin.query('UPDATE hushh_identity.runtime_admission SET creation_enabled=false');
    expect((await bootstrap('new')).created).toBe(false);
    await expect(bootstrap('blocked-new')).rejects.toMatchObject({ code: 'IDENTITY_CREATION_DISABLED' });
  });

  it('denies a partial secondary-provider snapshot even if the ready flag was set', async () => {
    await admin.query(`UPDATE hushh_identity.runtime_admission SET creation_enabled=true`);
    const run = (await admin.query(`INSERT INTO hushh_migration.migration_runs(replay_key,source_inventory_hash,mapping_input_hash,source_project_ref,source_database,target_environment,target_project,target_region,target_instance,target_database)
      VALUES (decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex'),decode(repeat('03',32),'hex'),'ibsisfnjxeowvdtvgzff','postgres','uat','hushh-tech-uat','us-central1','hushh-tech-app-pg-uat','hushh_tech_app') RETURNING id`)).rows[0].id;
    await admin.query(`INSERT INTO hushh_migration.identity_migration_dispositions(migration_run_id,legacy_project,legacy_user_uuid,firebase_uid,terminal_disposition,mapping_basis,provider_evidence_count,access_allowed)
      VALUES ($1,'ibsisfnjxeowvdtvgzff','10000000-0000-4000-8000-000000000001','existing','LINKED_EXISTING_FIREBASE','PROVIDER_SUBJECT',2,true)`, [run]);
    await expect(bootstrap('secondary-gap')).rejects.toMatchObject({ code: 'IDENTITY_EVIDENCE_UNAVAILABLE' });
    await admin.query(`INSERT INTO hushh_identity.provider_ownership VALUES ('apple.com',decode($1,'hex'),'10000000-0000-4000-8000-000000000001','OWNED','synthetic-secondary-evidence')`, [fingerprint('apple.com', 'existing-secondary')]);
    await expect(bootstrap('secondary-conflict', 'existing-secondary', 'apple.com')).rejects.toMatchObject({ code: 'IDENTITY_REVIEW_REQUIRED' });
    expect((await bootstrap('secondary-gap')).created).toBe(true);
  });
  it('retains explicit denied and unresolved provider tombstones', async () => {
    for (const disposition of ['DENIED', 'REVIEW_REQUIRED']) {
      await admin.query(`INSERT INTO hushh_identity.provider_ownership VALUES ('google.com',decode($1,'hex'),NULL,$2,'synthetic-recovery-evidence')`, [fingerprint('google.com', disposition), disposition]);
      await expect(bootstrap(`user-${disposition}`, disposition)).rejects.toMatchObject({ code: 'IDENTITY_REVIEW_REQUIRED' });
    }
  });
  it('refuses an account recreated under an existing native UID', async () => {
    const evidence = await prepareIdentityEvidence(actor('new'), { readAccount: async () => account('new', 'new', 'google.com', '2026-09-02Z') });
    await expect(withFirebaseTransaction('new', (client: pg.PoolClient) => ensureApplicationPrincipal(client, evidence), { pool: runtime })).rejects.toMatchObject({ code: 'IDENTITY_REVIEW_REQUIRED' });
  });
  it('rolls back invalid consent, versions, documents and cross-user selectors before any native link', async () => {
    for (const patch of [{ consentAccepted: false }, { ndaVersion: 'v0' }, { documentsAcknowledged: [] }, { applicationUserId: '10000000-0000-4000-8000-000000000001' }]) {
      await expect(executeNdaRequest({ ...signing, signing: { ...signing.signing, ...patch } }, actor('invalid-new'), {}, deps('invalid-new'))).rejects.toMatchObject({ status: 400 });
    }
    expect((await admin.query(`SELECT count(*) FROM hushh_identity.identity_links WHERE firebase_uid='invalid-new'`)).rows[0].count).toBe('0');
  });
});
