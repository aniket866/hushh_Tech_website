import { describe, expect, it, vi } from 'vitest';
import { loadMigrations, MIGRATIONS, runRelease } from '../scripts/gcp/migration/nda-release.mjs';

function catalogClient({ superuser = true, fail003 = false, ledgerFailure = false, partialProvisioner = false,
  deniedGrant = false, leftoverMember = false, wrongActor = false, rollbackDrift = false, locked = false, missingBasis = false } = {}) {
  const calls: string[] = [];
  let ledgerInserts = 0;
  let probeActor = 'postgres';
  let probeRolledBack = false;
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: !locked }] };
    if (sql.startsWith('GRANT hushh_tech_schema_owner TO postgres')) {
      if (deniedGrant) throw Object.assign(new Error('denied'), { code: '42501' });
      probeActor = 'hushh_tech_schema_owner';
    }
    if (sql.startsWith('GRANT hushh_tech_identity_provisioner TO postgres')) probeActor = 'hushh_tech_identity_provisioner';
    if (sql.startsWith('RESET ROLE')) probeActor = 'postgres';
    if (sql === 'SELECT current_user AS probe_actor') return { rows: [{ probe_actor: wrongActor ? 'unexpected' : probeActor }] };
    if (sql === 'ROLLBACK' && calls.some((q) => q.startsWith('CREATE ROLE'))) probeRolledBack = true;
    if (sql.includes('current_database() AS database')) return { rows: [{ database: 'hushh_tech_app', actor: 'postgres', version: 170010, rolsuper: superuser, rolcreaterole: true }] };
    if (sql.includes('AS role, u.rolname')) return { rows: rollbackDrift && probeRolledBack ? [{ role: 'hushh_tech_schema_owner', member: 'postgres' }] : [] };
    if (sql.includes('c.relname, pg_get_userbyid')) return { rows: ['identity_links', 'users', 'nda_signatures'].map((relname) => ({ relname, owner: 'hushh_tech_schema_owner', rls: true, force: true })) };
    if (sql.includes('rolsuper,rolcanlogin,rolinherit')) return { rows: [{ rolsuper: false, rolcanlogin: false, rolinherit: false, rolcreaterole: false, rolbypassrls: false }] };
    if (sql.includes('AS native_enum')) return { rows: [{ ledger: null, admission: null, native_enum: false, provisioner_role: partialProvisioner ? 'hushh_tech_identity_provisioner' : null }] };
    if (sql.includes('count(*)::int AS count')) return { rows: [{ count: leftoverMember ? 1 : 0 }] };
    if (sql.includes('AS native_basis')) return { rows: [{ native_basis: !missingBasis }] };
    if (sql.includes('p.prosecdef')) return { rows: [{ prosecdef: true, owner: 'hushh_tech_identity_provisioner', web_execute: true, proconfig: ['search_path=pg_catalog, hushh_identity, pg_temp'] }] };
    if (sql.includes('AS identity_write')) return { rows: [{ identity_write: false, ownership_write: false }] };
    if (fail003 && sql.includes('ALTER TYPE hushh_identity.identity_mapping_basis')) throw new Error('synthetic enum failure');
    if (sql.startsWith('INSERT INTO hushh_migration.nda_release_migrations')) {
      ledgerInserts++;
      if (ledgerFailure) throw new Error('synthetic ledger failure');
    }
    return { rows: [] };
  });
  return { query, calls, ledgerInserts: () => ledgerInserts };
}

describe('exact NDA release executor', () => {
  it('locks the exact reviewed files and transaction boundaries', async () => {
    const files = await loadMigrations();
    expect(files.map((f) => f.id)).toEqual(['003', '004']);
    expect(files.map((f) => f.sha256)).toEqual(MIGRATIONS.map((f) => f.sha256));
    expect(files.every((f) => !/^BEGIN;$/m.test(f.body) && !/^COMMIT;$/m.test(f.body))).toBe(true);
  });
  it('does not confuse Cloud SQL CREATEROLE with proven role administration', async () => {
    const client = catalogClient({ superuser: false, deniedGrant: true });
    const result = await runRelease(client);
    expect(result.ready).toBe(true);
    expect(result.roleCapability).toBe('requires_rollback_probe');
    expect(client.calls.every((q) => !/^(GRANT|CREATE|INSERT)/.test(q))).toBe(true);
    await expect(runRelease(client, { mode: 'apply', releaseSha: 'd'.repeat(40) })).rejects.toMatchObject({
      code: 'ROLE_LIFECYCLE_PROBE_FAILED', cause: { code: '42501' },
    });
    expect(client.calls.at(-2)).toBe('ROLLBACK');
    expect(client.calls.some((q) => q.includes('ALTER TYPE'))).toBe(false);
    expect(client.ledgerInserts()).toBe(0);
  });
  it('accepts demonstrated managed capability without superuser and commits 003 before 004', async () => {
    const client = catalogClient({ superuser: false });
    expect(await runRelease(client, { mode: 'apply', releaseSha: 'd'.repeat(40) })).toEqual({ ready: true, applied: ['003', '004'] });
    const enumIndex = client.calls.findIndex((q) => q.includes('ALTER TYPE'));
    const provisionIndex = client.calls.findIndex((q) => q.includes('CREATE TABLE hushh_identity.runtime_admission'));
    expect(client.calls.slice(0, enumIndex)).toContain('ROLLBACK');
    expect(client.calls.slice(enumIndex, provisionIndex)).toContain('COMMIT');
    expect(client.calls.filter((q) => q === 'COMMIT')).toHaveLength(2);
    expect(client.ledgerInserts()).toBe(2);
  });
  it('offers an explicit rolled-back probe without applying SQL or recording completion', async () => {
    const client = catalogClient({ superuser: false });
    expect((await runRelease(client, { mode: 'probe', releaseSha: 'd'.repeat(40) })).roleCapability).toBe('proven_rolled_back');
    expect(client.calls.some((q) => q.includes('ALTER TYPE') || q === 'COMMIT')).toBe(false);
    expect(client.ledgerInserts()).toBe(0);
    expect(client.calls.at(-1)).toContain('pg_advisory_unlock');
  });
  it.each([{ leftoverMember: true }, { wrongActor: true }])('refuses an incomplete role lifecycle: %j', async (options) => {
    const client = catalogClient(options);
    await expect(runRelease(client, { mode: 'apply', releaseSha: 'd'.repeat(40) })).rejects.toThrow('ROLE_LIFECYCLE_PROBE_FAILED');
    expect(client.calls.at(-2)).toBe('ROLLBACK');
    expect(client.calls).not.toContain('COMMIT');
    expect(client.ledgerInserts()).toBe(0);
  });
  it('refuses catalog drift after probe rollback', async () => {
    const client = catalogClient({ rollbackDrift: true });
    await expect(runRelease(client, { mode: 'apply', releaseSha: 'd'.repeat(40) })).rejects.toThrow('ROLE_PROBE_ROLLBACK_DRIFT');
    expect(client.calls.some((q) => q.includes('ALTER TYPE'))).toBe(false);
    expect(client.ledgerInserts()).toBe(0);
  });
  it('does not start a probe or migration when another release holds the lock', async () => {
    const client = catalogClient({ locked: true });
    await expect(runRelease(client, { mode: 'probe', releaseSha: 'd'.repeat(40) })).rejects.toThrow('MIGRATION_ALREADY_RUNNING');
    expect(client.calls).toHaveLength(1);
  });
  it('rejects partial provisioning objects before committing 003', async () => {
    const client = catalogClient({ partialProvisioner: true });
    await expect(runRelease(client, { mode: 'apply', releaseSha: 'd'.repeat(40) })).rejects.toThrow('UNRECORDED_OR_PARTIAL_MIGRATION');
    expect(client.calls.filter((q) => q === 'BEGIN' || q === 'COMMIT')).toHaveLength(0);
    expect(client.ledgerInserts()).toBe(0);
  });
  it('rejects historical apply/grant modes and missing release identity before querying', async () => {
    const client = catalogClient();
    await expect(runRelease(client, { mode: 'grant' })).rejects.toThrow('UNSUPPORTED_MODE');
    await expect(runRelease(client, { mode: 'apply' })).rejects.toThrow('APPROVED_RELEASE_SHA_REQUIRED');
    await expect(runRelease(client, { mode: 'probe' })).rejects.toThrow('APPROVED_RELEASE_SHA_REQUIRED');
    expect(client.query).not.toHaveBeenCalled();
  });
  it('does not record or commit 003 when its native enum postcondition is missing', async () => {
    const client = catalogClient({ missingBasis: true });
    await expect(runRelease(client, { mode: 'apply', releaseSha: 'd'.repeat(40) })).rejects.toThrow('POSTCONDITION_NATIVE_BASIS_MISSING');
    expect(client.calls).not.toContain('COMMIT');
    expect(client.ledgerInserts()).toBe(0);
    expect(client.calls.some((q) => q.includes('CREATE TABLE hushh_identity.runtime_admission'))).toBe(false);
  });
  it('rolls back 003 failure, never attempts 004, and releases its lock', async () => {
    const client = catalogClient({ fail003: true });
    await expect(runRelease(client, { mode: 'apply', releaseSha: 'd'.repeat(40) })).rejects.toThrow('synthetic enum failure');
    expect(client.calls.some((q) => q.includes('CREATE TABLE hushh_identity.runtime_admission'))).toBe(false);
    expect(client.calls.filter((q) => q === 'COMMIT')).toHaveLength(0);
    expect(client.ledgerInserts()).toBe(0);
    expect(client.calls.at(-1)).toContain('pg_advisory_unlock');
  });
  it('does not commit SQL without its completion marker', async () => {
    const client = catalogClient({ ledgerFailure: true });
    await expect(runRelease(client, { mode: 'apply', releaseSha: 'd'.repeat(40) })).rejects.toThrow('synthetic ledger failure');
    expect(client.calls.filter((q) => q === 'COMMIT')).toHaveLength(0);
    expect(client.calls.some((q) => q.includes('CREATE TABLE hushh_identity.runtime_admission'))).toBe(false);
  });
});
