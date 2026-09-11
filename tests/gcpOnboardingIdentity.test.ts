import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeCurrentUserOnboardingRead, executeDataRequest } from '../api/shared/gcpDataRuntime.js';

const principal = '00000000-0000-4000-8000-000000000123';
const actor = {
  uid: 'native-firebase-uid', sub: 'native-firebase-uid', aud: 'hushh-tech-uat',
  iss: 'https://securetoken.google.com/hushh-tech-uat',
};
const request = (table = 'onboarding_data', uid = actor.uid) => ({
  kind: 'table', table, operation: 'select',
  columns: table === 'onboarding_data'
    ? 'current_step, is_completed, financial_link_status, fund_payment_status, fund_investor_verification_status'
    : 'status',
  filters: [{ column: 'user_id', operator: 'eq', value: uid }],
  cardinality: 'maybe-single',
});

function fixture({ rows = [], provider = 'google.com', uid = actor.uid, created = false, disabled = false }:
  { rows?: unknown[]; provider?: string; uid?: string; created?: boolean; disabled?: boolean } = {}) {
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const query = vi.fn(async (sql: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
    const item = typeof sql === 'string' ? { text: sql, values } : sql;
    statements.push(item);
    if (item.text.includes('ensure_current_application_principal')) {
      return { rows: [{ application_user_id: principal, created }], rowCount: 1 };
    }
    if (item.text.includes('FROM public.')) {
      // Model PostgreSQL's UUID input contract: raw Firebase UIDs must never
      // reach either post-auth query, even when the user has no onboarding row.
      if (item.values?.[0] !== principal) throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' });
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: null };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const readAccount = vi.fn(async () => ({
    uid, disabled, metadata: { creationTime: '2026-01-01T00:00:00Z' },
    providerData: [{ providerId: provider, uid: 'server-verified-provider-subject' }],
  }));
  return { statements, query, release, connect, readAccount, dependencies: { pool: { connect }, readAccount } };
}

beforeEach(() => {
  vi.stubEnv('GCP_DATA_RUNTIME_ENABLED', 'true');
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'hushh-tech-uat');
  vi.stubEnv('FIREBASE_PROJECT_ID', 'hushh-tech-uat');
  vi.stubEnv('CLOUD_SQL_INSTANCE_CONNECTION_NAME', 'hushh-tech-uat:us-central1:hushh-tech-app-pg-uat');
  vi.stubEnv('CLOUD_SQL_DATABASE', 'hushh_tech_app');
  vi.stubEnv('CLOUD_SQL_IAM_USER', 'hushh-tech-web-uat@hushh-tech-uat.iam');
  vi.stubEnv('GCP_STORAGE_BUCKET_PREFIX', 'hushh-tech-uat');
});
afterEach(() => vi.unstubAllEnvs());

describe('post-auth onboarding identity boundary', () => {
  it('reproduces 22P02 with the previous generic execution path and the actual callback query', async () => {
    const f = fixture();
    await expect(executeDataRequest(request(), actor.uid, f.dependencies)).rejects.toMatchObject({ code: '22P02' });
    expect(f.statements.find((s) => s.text.includes('FROM public.'))?.values).toEqual([actor.uid]);
    expect(f.statements.map((s) => s.text)).toContain('ROLLBACK');
  });

  it.each(['google.com', 'apple.com'])('resolves a new %s user before both callback reads', async (provider) => {
    const f = fixture({ provider, created: true });
    for (const table of ['onboarding_data', 'user_financial_data']) {
      const body = request(table);
      await expect(executeCurrentUserOnboardingRead(body, actor, f.dependencies)).resolves.toEqual({ data: null, count: 0 });
      expect(body.filters[0].value).toBe(actor.uid);
    }
    expect(f.readAccount).toHaveBeenCalledWith(actor.uid);
    const config = f.statements.find((s) => s.text.includes('set_config'));
    expect(config?.values).toEqual([actor.uid, 'hushh-tech-uat']);
    expect(f.statements.filter((s) => s.text.includes('FROM public.')).every((s) => s.values?.[0] === principal)).toBe(true);
    expect(f.statements.filter((s) => s.text === 'COMMIT')).toHaveLength(2);
    const evidence = f.statements.find((s) => s.text.includes('ensure_current_application_principal'))!;
    expect(JSON.parse(evidence.values![0] as string)).toMatchObject({
      fingerprintScheme: 'sha256-provider-nul-subject-nfc-v1',
      providers: [{ providerId: provider, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }],
    });
    expect(f.release).toHaveBeenCalledWith(false);
  });

  it.each([actor.uid, principal])('preserves existing mapped progress for UID %s', async (uid) => {
    const row = { current_step: 7, is_completed: false, fund_payment_status: 'paid' };
    const f = fixture({ uid, rows: [row] });
    const verified = { ...actor, uid, sub: uid };
    await expect(executeCurrentUserOnboardingRead(request('onboarding_data', uid), verified, f.dependencies))
      .resolves.toEqual({ data: row, count: 1 });
    expect(f.statements.find((s) => s.text.includes('FROM public.'))?.values).toEqual([principal]);
  });

  it.each(['IDENTITY_REVIEW_REQUIRED', 'IDENTITY_DENIED', 'IDENTITY_CREATION_DISABLED', 'IDENTITY_EVIDENCE_UNAVAILABLE'])(
    'preserves %s instead of pretending the user has no progress', async (code) => {
      const f = fixture();
      f.query.mockImplementation(async (sql) => {
        const text = typeof sql === 'string' ? sql : sql.text;
        if (text.includes('ensure_current_application_principal')) throw Object.assign(new Error(code), { code: 'P0001' });
        return { rows: [], rowCount: null };
      });
      await expect(executeCurrentUserOnboardingRead(request(), actor, f.dependencies)).rejects.toMatchObject({ code });
      const sql = f.query.mock.calls.map(([q]) => typeof q === 'string' ? q : q.text);
      expect(sql).toContain('ROLLBACK');
      expect(sql).not.toContain('COMMIT');
      expect(sql.some((s) => s.includes('FROM public.'))).toBe(false);
    });

  it.each([
    { ...actor, sub: 'other' }, { ...actor, aud: 'hushh-tech-prod' },
    { ...actor, firebase: { tenant: 'other' } },
  ])('rejects invalid verified-actor authority before DB access', async (invalidActor) => {
    const f = fixture();
    await expect(executeCurrentUserOnboardingRead(request(), invalidActor, f.dependencies)).rejects.toMatchObject({ status: 401 });
    expect(f.connect).not.toHaveBeenCalled();
  });

  it.each([
    { ...request(), filters: [] },
    { ...request(), filters: [{ column: 'user_id', operator: 'eq', value: 'another-user' }] },
    { ...request(), filters: [{ column: 'user_id', operator: 'in', value: [actor.uid] }] },
    { ...request(), operation: 'update', values: { is_completed: true } },
    { ...request(), table: 'nda_signatures' },
  ])('rejects requests outside the current-user read contract', async (body) => {
    const f = fixture();
    await expect(executeCurrentUserOnboardingRead(body, actor, f.dependencies)).rejects.toMatchObject({ status: 403 });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.readAccount).not.toHaveBeenCalled();
  });

  it('denies a disabled account before provisioning', async () => {
    const f = fixture({ disabled: true });
    await expect(executeCurrentUserOnboardingRead(request(), actor, f.dependencies)).rejects.toMatchObject({ status: 401 });
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('rolls back provisioning and preserves the real DB error when the read fails', async () => {
    const f = fixture();
    const implementation = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, values) => {
      if (typeof sql !== 'string' && sql.text.includes('FROM public.')) throw Object.assign(new Error('denied'), { code: '42501' });
      return implementation(sql, values);
    });
    await expect(executeCurrentUserOnboardingRead(request(), actor, f.dependencies)).rejects.toMatchObject({ code: '42501' });
    expect(f.statements.map((s) => s.text)).toContain('ROLLBACK');
    expect(f.statements.map((s) => s.text)).not.toContain('COMMIT');
  });

  it('rolls back ambiguous progress rather than silently choosing a record', async () => {
    const f = fixture({ rows: [{ current_step: 1 }, { current_step: 2 }] });
    await expect(executeCurrentUserOnboardingRead(request(), actor, f.dependencies)).rejects.toMatchObject({ code: 'CARDINALITY_MISMATCH' });
    expect(f.statements.map((s) => s.text)).toContain('ROLLBACK');
    expect(f.statements.map((s) => s.text)).not.toContain('COMMIT');
  });

  it('retains parameterized additional filters and single/many response cardinality', async () => {
    const row = { current_step: 4 };
    const f = fixture({ rows: [row] });
    const body = { ...request(), filters: [...request().filters, { column: 'account_type', operator: 'eq', value: 'individual' }] };
    await expect(executeCurrentUserOnboardingRead({ ...body, cardinality: 'single' }, actor, f.dependencies))
      .resolves.toEqual({ data: row, count: 1 });
    await expect(executeCurrentUserOnboardingRead({ ...body, cardinality: 'many' }, actor, f.dependencies))
      .resolves.toEqual({ data: [row], count: 1 });
    expect(f.statements.find((s) => s.text.includes('FROM public.'))?.values).toEqual([principal, 'individual']);
  });
});
