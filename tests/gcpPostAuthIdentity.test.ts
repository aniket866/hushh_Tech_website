import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeCurrentUserPostAuthRequest, executeDataRequest, isCurrentUserPostAuthRequest } from '../api/shared/gcpDataRuntime.js';

const principal = '10000000-0000-4000-8000-000000000123';
const actor = { uid: 'firebase-native-uid', sub: 'firebase-native-uid', aud: 'hushh-tech-uat', iss: 'https://securetoken.google.com/hushh-tech-uat' };
const read = (table = 'investor_profiles', column = 'user_id') => ({
  kind: 'table', table, operation: 'select', columns: '*', cardinality: 'maybe-single',
  filters: [{ column, operator: 'eq', value: actor.uid }],
});
function fixture(code?: string) {
  const query = vi.fn(async (sql: string | { text: string; values?: unknown[] }) => {
    const text = typeof sql === 'string' ? sql : sql.text;
    if (text.includes('ensure_current_application_principal')) {
      if (code) throw Object.assign(new Error(code), { code: 'P0001' });
      return { rows: [{ application_user_id: principal, created: false }], rowCount: 1 };
    }
    if (typeof sql !== 'string' && sql.values?.includes(actor.uid)) throw Object.assign(new Error('invalid UUID'), { code: '22P02' });
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const readAccount = vi.fn(async () => ({ uid: actor.uid, disabled: false, metadata: { creationTime: '2026-09-01T00:00:00Z' }, providerData: [{ providerId: 'google.com', uid: 'verified-subject' }] }));
  return { query, connect, release, readAccount, dependencies: { pool: { connect }, readAccount } };
}
beforeEach(() => {
  for (const [key, value] of Object.entries({ GCP_DATA_RUNTIME_ENABLED: 'true', GOOGLE_CLOUD_PROJECT: 'hushh-tech-uat', FIREBASE_PROJECT_ID: 'hushh-tech-uat', CLOUD_SQL_INSTANCE_CONNECTION_NAME: 'hushh-tech-uat:us-central1:hushh-tech-app-pg-uat', CLOUD_SQL_DATABASE: 'hushh_tech_app', CLOUD_SQL_IAM_USER: 'hushh-tech-web-uat@hushh-tech-uat.iam', GCP_STORAGE_BUCKET_PREFIX: 'hushh-tech-uat' })) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

describe('shared post-auth application identity', () => {
  it.each(['investor_profiles', 'ceo_meeting_payments'])('reproduces the old %s raw-UID failure', async (table) => {
    const f = fixture();
    await expect(executeDataRequest(read(table), actor.uid, f.dependencies)).rejects.toMatchObject({ code: '22P02' });
  });
  it.each([
    ['investor_profiles', 'user_id'], ['ceo_meeting_payments', 'user_id'],
    ['onboarding_parties', 'primary_user_id'], ['onboarding_invites', 'primary_user_id'],
  ])('resolves %s.%s using the same authenticated transaction', async (table, column) => {
    const f = fixture();
    const body = read(table, column);
    await expect(executeCurrentUserPostAuthRequest(body, actor, f.dependencies)).resolves.toEqual({ data: null, count: 0 });
    expect(f.query).toHaveBeenCalledWith(expect.objectContaining({ values: [principal] }));
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining("set_config('app.firebase_uid'"), [actor.uid, 'hushh-tech-uat']);
    expect(body.filters[0].value).toBe(actor.uid);
    expect(f.release).toHaveBeenCalledWith(false);
  });
  it.each(['insert', 'update', 'upsert'])('translates onboarding %s ownership without changing saved fields', async (operation) => {
    const f = fixture();
    const body = { ...read('onboarding_data'), operation, values: { user_id: actor.uid, current_step: 2 }, filters: operation === 'update' ? read().filters : [], options: { onConflict: 'user_id' } };
    await executeCurrentUserPostAuthRequest(body, actor, f.dependencies);
    const sql = f.query.mock.calls.map(([q]) => q).find((q) => typeof q !== 'string') as { text: string; values: unknown[] };
    expect(sql.values).toEqual(operation === 'update' ? [principal, 2, principal] : [principal, 2]);
    expect(body.values.user_id).toBe(actor.uid);
    expect(f.query).toHaveBeenCalledWith('COMMIT');
  });
  it('keeps profile-by-other-application-UUID requests on their original RLS path', () => {
    expect(isCurrentUserPostAuthRequest({ ...read(), filters: [{ column: 'user_id', operator: 'eq', value: principal }] }, actor)).toBe(false);
  });
  it.each([
    { operation: 'insert', values: { user_id: 'another-user' }, filters: [] },
    { operation: 'insert', values: { current_step: 1 }, filters: [] },
    { operation: 'update', values: { user_id: 'another-user' } },
    { operation: 'update', values: { current_step: 1 }, filters: [] },
    { operation: 'upsert', values: { user_id: actor.uid }, filters: [], options: { onConflict: 'id' } },
    { operation: 'insert', values: [{ user_id: actor.uid }, { user_id: 'another-user' }], filters: [] },
  ])('rejects unsafe onboarding ownership before provisioning', async (invalid) => {
    const f = fixture();
    await expect(executeCurrentUserPostAuthRequest({ ...read('onboarding_data'), ...invalid }, actor, f.dependencies)).rejects.toThrow();
    expect(f.readAccount).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(['IDENTITY_CREATION_DISABLED', 'IDENTITY_EVIDENCE_UNAVAILABLE', 'IDENTITY_DENIED', 'IDENTITY_REVIEW_REQUIRED'])('preserves %s as a real failure', async (code) => {
    const f = fixture(code);
    await expect(executeCurrentUserPostAuthRequest(read(), actor, f.dependencies)).rejects.toMatchObject({ code });
    expect(f.query).toHaveBeenCalledWith('ROLLBACK');
    expect(f.query.mock.calls.some(([q]) => typeof q !== 'string')).toBe(false);
  });
  it('rejects mismatched Firebase authority and disabled accounts before DB access', async () => {
    const f = fixture();
    await expect(executeCurrentUserPostAuthRequest(read(), { ...actor, sub: 'other' }, f.dependencies)).rejects.toMatchObject({ status: 401 });
    f.readAccount.mockResolvedValueOnce({ uid: actor.uid, disabled: true, metadata: { creationTime: '2026-09-01T00:00:00Z' }, providerData: [] });
    await expect(executeCurrentUserPostAuthRequest(read(), actor, f.dependencies)).rejects.toMatchObject({ status: 401 });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('rolls back a failed onboarding save rather than committing provisioning or fake success', async () => {
    const f = fixture();
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (q) => {
      if (typeof q !== 'string') throw Object.assign(new Error('RLS denied'), { code: '42501' });
      return original(q);
    });
    await expect(executeCurrentUserPostAuthRequest({ ...read('onboarding_data'), operation: 'update', values: { current_step: 2 } }, actor, f.dependencies)).rejects.toMatchObject({ code: '42501' });
    expect(f.query).toHaveBeenCalledWith('ROLLBACK');
    expect(f.query).not.toHaveBeenCalledWith('COMMIT');
  });
  it.each(['nda_signatures', 'delete_requests', 'users'])('does not expand the %s contract', async (table) => {
    const f = fixture();
    await expect(executeCurrentUserPostAuthRequest(read(table), actor, f.dependencies)).rejects.toMatchObject({ status: 403 });
    expect(f.connect).not.toHaveBeenCalled();
  });
});
