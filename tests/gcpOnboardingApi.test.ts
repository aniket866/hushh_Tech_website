import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), onboarding: vi.fn(), postAuth: vi.fn(), data: vi.fn(), nda: vi.fn() }));
vi.mock('../api/shared/gcpDataRuntime.js', async (importOriginal) => ({
  ...await importOriginal(),
  verifyFirebaseBearer: mocks.verify,
  executeCurrentUserOnboardingRead: mocks.onboarding,
  executeCurrentUserPostAuthRequest: mocks.postAuth,
  executeDataRequest: mocks.data,
}));
vi.mock('../api/shared/gcpNdaRuntime.js', () => ({ executeNdaRequest: mocks.nda }));
import handler from '../api/gcp-data.js';
const response = () => ({ setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() });
beforeEach(() => vi.resetAllMocks());

describe('callback onboarding API dispatch', () => {
  it.each(['IDENTITY_CREATION_DISABLED', 'IDENTITY_EVIDENCE_UNAVAILABLE'].flatMap(code => ['onboarding', 'nda-status'].map(operation => ({ code, operation }))))('reports $code safely for $operation while preserving the failure status', async ({ code, operation }) => {
    mocks.verify.mockResolvedValue({ uid: 'verified' });
    (operation === 'onboarding' ? mocks.onboarding : mocks.nda).mockRejectedValue({ status: 503, code, message: 'private SQL/provider detail' });
    const res = response();
    const body = operation === 'onboarding' ? { kind: 'table', table: 'onboarding_data', operation: 'select' } : { kind: 'nda', operation: 'status' };
    await handler({ method: 'POST', headers: {}, body }, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: { code, message: expect.stringContaining('Your sign-in succeeded') } });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('private SQL');
    expect(mocks.data).not.toHaveBeenCalled();
  });
  it.each(['onboarding_data', 'user_financial_data'])('uses the verified actor for %s reads', async (table) => {
    const actor = { uid: 'verified', sub: 'verified', aud: 'hushh-tech-uat' };
    const body = { kind: 'table', table, operation: 'select', actor: { uid: 'forged' } };
    mocks.verify.mockResolvedValue(actor);
    mocks.onboarding.mockResolvedValue({ data: null, count: 0 });
    const res = response();
    await handler({ method: 'POST', headers: { authorization: 'Bearer fixture' }, body }, res);
    expect(mocks.verify).toHaveBeenCalledWith('Bearer fixture');
    expect(mocks.onboarding).toHaveBeenCalledWith(body, actor);
    expect(mocks.data).not.toHaveBeenCalled();
    expect(mocks.nda).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: null, count: 0 });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it.each(['auth/id-token-revoked', 'auth/id-token-expired', 'auth/invalid-id-token', 'auth/user-disabled'])(
    'rejects %s before onboarding/provisioning', async (code) => {
      mocks.verify.mockRejectedValue({ code });
      const res = response();
      await handler({ method: 'POST', headers: {}, body: { kind: 'table', table: 'onboarding_data', operation: 'select' } }, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(mocks.onboarding).not.toHaveBeenCalled();
      expect(mocks.data).not.toHaveBeenCalled();
    });

  it('preserves a denied identity as an error, not empty onboarding success', async () => {
    mocks.verify.mockResolvedValue({ uid: 'verified' });
    mocks.onboarding.mockRejectedValue({ status: 409, code: 'IDENTITY_REVIEW_REQUIRED', message: 'Application identity could not be verified.' });
    const res = response();
    await handler({ method: 'POST', headers: {}, body: { kind: 'table', table: 'onboarding_data', operation: 'select' } }, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: { code: 'IDENTITY_REVIEW_REQUIRED', message: 'Application identity could not be verified.' } });
  });

  it.each([
    { kind: 'table', table: 'investor_profiles', operation: 'select' },
    { kind: 'table', table: 'app_config', operation: 'select' },
  ])('leaves unrelated data contracts on the existing executor', async (body) => {
    mocks.verify.mockResolvedValue({ uid: 'verified' });
    mocks.data.mockResolvedValue({ data: [] });
    await handler({ method: 'POST', headers: {}, body }, response());
    expect(mocks.data).toHaveBeenCalledWith(body, 'verified');
    expect(mocks.onboarding).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'table', table: 'onboarding_data', operation: 'insert', values: { user_id: 'verified' } },
    ...['investor_profiles', 'ceo_meeting_payments'].map((table) => ({ kind: 'table', table, operation: 'select', filters: [{ column: 'user_id', operator: 'eq', value: 'verified' }] })),
    ...['onboarding_parties', 'onboarding_invites'].map((table) => ({ kind: 'table', table, operation: 'select', filters: [{ column: 'primary_user_id', operator: 'eq', value: 'verified' }] })),
  ])('routes post-auth self requests through the verified actor boundary', async (body) => {
    const actor = { uid: 'verified' };
    mocks.verify.mockResolvedValue(actor);
    mocks.postAuth.mockResolvedValue({ data: null, count: 0 });
    const res = response();
    await handler({ method: 'POST', headers: {}, body: { ...body, actor: { uid: 'forged' } } }, res);
    expect(mocks.postAuth).toHaveBeenCalledWith({ ...body, actor: { uid: 'forged' } }, actor);
    expect(mocks.data).not.toHaveBeenCalled();
    expect(mocks.nda).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
