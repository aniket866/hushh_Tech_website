import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verify: vi.fn(), data: vi.fn(), nda: vi.fn() }));
vi.mock('../api/shared/gcpDataRuntime.js', () => ({ verifyFirebaseBearer: mocks.verify, executeDataRequest: mocks.data }));
vi.mock('../api/shared/gcpNdaRuntime.js', () => ({ executeNdaRequest: mocks.nda }));
import handler from '../api/gcp-data.js';
const response = () => ({ setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() });
beforeEach(() => vi.resetAllMocks());
describe('NDA API Firebase verification boundary', () => {
  it.each(['auth/id-token-revoked', 'auth/id-token-expired', 'auth/invalid-id-token', 'auth/user-disabled'])('denies %s before database operations', async (code) => {
    mocks.verify.mockRejectedValue({ code, message: 'private provider details' });
    const res = response();
    await handler({ method: 'POST', headers: { authorization: 'Bearer synthetic' }, body: { kind: 'nda', operation: 'sign' } }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: { code: 'AUTH_INVALID', message: 'Please sign in again.' } });
    expect(mocks.nda).not.toHaveBeenCalled();
    expect(mocks.data).not.toHaveBeenCalled();
  });
  it('forwards only verified actor identity and bounded server evidence to explicit operations', async () => {
    const actor = { uid: 'verified' };
    const body = { kind: 'nda', operation: 'status' };
    mocks.verify.mockResolvedValue(actor);
    mocks.nda.mockResolvedValue({ data: { hasSignedNda: false } });
    const res = response();
    await handler({ method: 'POST', headers: { authorization: 'Bearer synthetic', 'user-agent': 'test', 'x-forwarded-for': 'untrusted' }, body }, res);
    expect(mocks.verify).toHaveBeenCalledWith('Bearer synthetic');
    expect(mocks.nda).toHaveBeenCalledWith(body, actor, { userAgent: 'test' });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.json).toHaveBeenCalledWith({ data: { hasSignedNda: false } });
  });
  it('does not disclose SQL/provider details on service failure', async () => {
    mocks.verify.mockResolvedValue({ uid: 'verified' });
    mocks.nda.mockRejectedValue(new Error('sensitive SQL details'));
    const res = response();
    await handler({ method: 'POST', headers: {}, body: { kind: 'nda' } }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: { code: 'GCP_DATA_ERROR', message: 'GCP data service unavailable.' } });
  });
});
