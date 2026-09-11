import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), onboarding: vi.fn(), data: vi.fn(), nda: vi.fn() }));
vi.mock('../api/shared/gcpDataRuntime.js', async (importOriginal) => ({
  ...await importOriginal(),
  verifyFirebaseBearer: mocks.verify,
  executeCurrentUserOnboardingRead: mocks.onboarding,
  executeDataRequest: mocks.data,
}));
vi.mock('../api/shared/gcpNdaRuntime.js', () => ({ executeNdaRequest: mocks.nda }));
import handler from '../api/gcp-data.js';
const response = () => ({ setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() });
beforeEach(() => vi.resetAllMocks());

describe('callback onboarding API dispatch', () => {
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
    { kind: 'table', table: 'onboarding_data', operation: 'upsert' },
    { kind: 'table', table: 'investor_profiles', operation: 'select' },
  ])('leaves unrelated data contracts on the existing executor', async (body) => {
    mocks.verify.mockResolvedValue({ uid: 'verified' });
    mocks.data.mockResolvedValue({ data: [] });
    await handler({ method: 'POST', headers: {}, body }, response());
    expect(mocks.data).toHaveBeenCalledWith(body, 'verified');
    expect(mocks.onboarding).not.toHaveBeenCalled();
  });
});
