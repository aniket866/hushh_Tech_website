import { describe, expect, it, vi } from 'vitest';
import { loadMigrations, MIGRATIONS, runRelease } from '../scripts/gcp/migration/nda-release.mjs';

function catalogClient({ superuser = true, fail003 = false, ledgerFailure = false, partialProvisioner = false } = {}) {
  const calls: string[] = [];
  let ledgerInserts = 0;
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
    if (sql.includes('current_database() AS database')) return { rows: [{ database: 'hushh_tech_app', actor: 'postgres', version: 170010, rolsuper: superuser, rolcreaterole: true }] };
    if (sql.includes('AS role, u.rolname')) return { rows: [] };
    if (sql.includes('c.relname, pg_get_userbyid')) return { rows: ['identity_links', 'users', 'nda_signatures'].map((relname) => ({ relname, owner: 'hushh_tech_schema_owner', rls: true, force: true })) };
    if (sql.includes('rolsuper,rolcanlogin,rolinherit')) return { rows: [{ rolsuper: false, rolcanlogin: false, rolinherit: false, rolcreaterole: false, rolbypassrls: false }] };
    if (sql.includes('AS native_enum')) return { rows: [{ ledger: null, admission: null, native_enum: false, provisioner_role: partialProvisioner ? 'hushh_tech_identity_provisioner' : null }] };
    if (sql.includes('count(*)::int AS count')) return { rows: [{ count: 0 }] };
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
    const client = catalogClient({ superuser: false });
    const result = await runRelease(client);
    expect(result.blockers).toContain('ROLE_ADMIN_CAPABILITY_NOT_PROVEN');
    expect(result.blockers).toContain('PROVISIONER_SEAL_CAPABILITY_NOT_PROVEN');
    expect(client.calls.every((q) => !/^(GRANT|CREATE|INSERT)/.test(q))).toBe(true);
    await expect(runRelease(client, { mode: 'apply', releaseSha: 'd'.repeat(40) })).rejects.toThrow('ROLE_ADMIN_CAPABILITY_NOT_PROVEN');
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
    expect(client.query).not.toHaveBeenCalled();
  });
  it('rolls back 003 failure, never attempts 004, and releases its lock', async () => {
    const client = catalogClient({ fail003: true });
    await expect(runRelease(client, { mode: 'apply', releaseSha: 'd'.repeat(40) })).rejects.toThrow('synthetic enum failure');
    expect(client.calls.some((q) => q.includes('CREATE ROLE hushh_tech_identity_provisioner'))).toBe(false);
    expect(client.calls.filter((q) => q === 'COMMIT')).toHaveLength(0);
    expect(client.ledgerInserts()).toBe(0);
    expect(client.calls.at(-1)).toContain('pg_advisory_unlock');
  });
  it('does not commit SQL without its completion marker', async () => {
    const client = catalogClient({ ledgerFailure: true });
    await expect(runRelease(client, { mode: 'apply', releaseSha: 'd'.repeat(40) })).rejects.toThrow('synthetic ledger failure');
    expect(client.calls.filter((q) => q === 'COMMIT')).toHaveLength(0);
    expect(client.calls.some((q) => q.includes('CREATE ROLE hushh_tech_identity_provisioner'))).toBe(false);
  });
});
