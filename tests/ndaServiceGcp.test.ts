import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), fetch: vi.fn() }));
vi.mock('../src/resources/config/config', () => ({ default: { GCP_API_BASE_URL: '/api/gcp', gcpBackendClient: { auth: { getSession: mocks.session } } } }));
vi.mock('../src/services/runtime/mainWeb', () => ({ getNdaGenerationUrl: () => 'https://pdf.example.invalid/generate-nda' }));
import { checkNDAStatus, getNDARecord, signNDA, generateNDAPdf, sendNDANotification } from '../src/services/nda/ndaService';
import { FUND_DOCUMENTS } from '../src/services/nda/ndaDocuments';
import { checkAccessStatus, NDA_REQUIRED_STATUS } from '../src/services/access/accessControlApi';
const documents = FUND_DOCUMENTS.map((doc) => doc.fullName);
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.session.mockResolvedValue({ data: { session: { access_token: 'synthetic-test-token' } }, error: null });
});
afterEach(() => vi.unstubAllGlobals());
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
describe('actual NDA browser service GCP contract', () => {
  it('uses the authenticated explicit status operation and never submits a user selector', async () => {
    const status = { hasSignedNda: false, signedAt: null, ndaVersion: null, signerName: null };
    mocks.fetch.mockResolvedValue(json({ data: status }));
    expect(await checkNDAStatus('not-a-database-uuid')).toEqual(status);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe('/api/gcp/data');
    expect(options.headers.Authorization).toBe('Bearer synthetic-test-token');
    expect(JSON.parse(options.body)).toEqual({ kind: 'nda', operation: 'status' });
  });
  it('uses the same identity boundary for record lookup', async () => {
    mocks.fetch.mockResolvedValue(json({ data: null }));
    expect(await getNDARecord('ignored-uid')).toBeNull();
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ kind: 'nda', operation: 'record' });
  });
  it('uses native status for protected content with the caller session, never REST or an identity selector', async () => {
    mocks.fetch.mockResolvedValue(json({ data: { hasSignedNda: true, signedAt: '2026-09-01T00:00:00Z', ndaVersion: 'v1.0', signerName: 'Test Signer' } }));
    expect(await checkAccessStatus('synthetic-caller-token')).toBe('Approved');
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith('/api/gcp/data', expect.objectContaining({
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-caller-token' },
      body: JSON.stringify({ kind: 'nda', operation: 'status' }),
    }));
    mocks.fetch.mockResolvedValue(json({ data: { hasSignedNda: false, signedAt: null, ndaVersion: null, signerName: null } }));
    expect(await checkAccessStatus('synthetic-caller-token')).toBe(NDA_REQUIRED_STATUS);
  });
  it.each([null, [], {}, { hasSignedNda: 'true' }, { hasSignedNda: true, signedAt: null, ndaVersion: 'v1.0', signerName: 'Test' }])('rejects malformed status %j rather than granting access or pretending unsigned', async (data) => {
    mocks.fetch.mockImplementation(async () => json({ data }));
    await expect(checkAccessStatus('synthetic-caller-token')).rejects.toThrow('Invalid NDA status');
    await expect(checkNDAStatus('fixture')).rejects.toThrow('Invalid NDA status');
  });
  it('keeps backend identity outages as errors in the protected-content caller', async () => {
    mocks.fetch.mockResolvedValue(json({ error: { code: 'IDENTITY_CREATION_DISABLED', message: 'NDA service unavailable' } }, 503));
    await expect(checkAccessStatus('synthetic-caller-token')).rejects.toThrow('NDA service unavailable');
    mocks.fetch.mockClear();
    await expect(checkAccessStatus('')).rejects.toThrow('sign in again');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('does not turn identity/status errors into unsigned or missing records', async () => {
    mocks.fetch.mockImplementation(async () => json({ error: { code: 'IDENTITY_REVIEW_REQUIRED', message: 'Identity requires review.' } }, 409));
    await expect(checkNDAStatus('fixture')).rejects.toThrow('Identity requires review');
    await expect(getNDARecord('fixture')).rejects.toThrow('Identity requires review');
  });
  it('fails before HTTP if no authenticated session exists', async () => {
    mocks.session.mockResolvedValue({ data: { session: null }, error: null });
    await expect(checkNDAStatus('fixture')).rejects.toThrow('sign in again');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('sends explicit consent and preserves scalar durable signing response', async () => {
    const result = { success: true, signedAt: '2026-09-01T00:00:00Z', signerName: 'Test Signer', ndaVersion: 'v1.0', shouldNotify: false };
    mocks.fetch.mockResolvedValue(json({ data: result }));
    expect(await signNDA('Test Signer', 'v1.0', undefined, documents, 'v1.0', true)).toEqual(result);
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ kind: 'nda', operation: 'sign', signing: { signerName: 'Test Signer', ndaVersion: 'v1.0', pdfUrl: null, documentsAcknowledged: documents, consentVersion: 'v1.0', consentAccepted: true } });
  });
  it('keeps PDF and notification failures separate from durable consent', async () => {
    mocks.fetch.mockImplementation(async (url) => url === '/api/gcp/data'
      ? json({ data: { success: true, shouldNotify: true, signedAt: '2026-09-01T00:00:00Z' } })
      : json({ error: 'Independent service unavailable' }, 503));
    expect((await generateNDAPdf({}, 'synthetic-test-token')).success).toBe(false);
    const signed = await signNDA('Test Signer', 'v1.0', undefined, documents, 'v1.0', true);
    expect(signed.success).toBe(true);
    expect((await sendNDANotification('Test Signer', signed.signedAt!, 'v1.0')).success).toBe(false);
    expect(signed.success).toBe(true);
  });
});
