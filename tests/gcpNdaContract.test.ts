import { describe, expect, it, vi } from 'vitest';
import { NDA_DOCUMENTS, NDA_VERSION, executeNdaRequest, validateNdaRequest } from '../api/shared/gcpNdaRuntime.js';
import { prepareIdentityEvidence } from '../api/shared/gcpIdentityProvisioning.js';
import { compileTableQuery, RPC_NAMES } from '../api/shared/gcpDataRuntime.js';
import { FUND_DOCUMENTS, NDA_CONSENT_VERSION } from '../src/services/nda/ndaDocuments';

const signing = { signerName: 'Test Signer', ndaVersion: 'v1.0', consentVersion: 'v1.0', consentAccepted: true, documentsAcknowledged: [...NDA_DOCUMENTS], pdfUrl: null };
const request = (patch = {}) => ({ kind: 'nda', operation: 'sign', signing: { ...signing, ...patch } });
const actor = { uid: 'fixture', sub: 'fixture', aud: 'hushh-tech-uat', iss: 'https://securetoken.google.com/hushh-tech-uat' };
const readAccount = async () => ({ uid: 'fixture', disabled: false, metadata: { creationTime: '2026-09-01Z' }, providerData: [{ providerId: 'google.com', uid: 'subject' }] });

describe('explicit server-owned NDA contract', () => {
  it('matches the existing UI document set and version exactly', () => {
    expect(NDA_DOCUMENTS).toEqual(FUND_DOCUMENTS.map((doc) => doc.fullName));
    expect(NDA_VERSION).toBe(NDA_CONSENT_VERSION);
    expect(validateNdaRequest(request(), 'fixture').documents).toEqual(NDA_DOCUMENTS);
  });
  it.each([
    { signerName: '' }, { signerName: 'x' }, { signerName: 'x'.repeat(101) }, { signerName: 'bad\0name' },
    { consentAccepted: false }, { consentAccepted: 'true' }, { consentVersion: null }, { consentVersion: 'v0' }, { ndaVersion: 'v2' },
    { documentsAcknowledged: [] }, { documentsAcknowledged: [...NDA_DOCUMENTS, 'extra'] },
    { documentsAcknowledged: Array(4).fill(NDA_DOCUMENTS[0]) }, { signerEmail: 'other@example.invalid' },
    { firebaseUid: 'other' }, { applicationUserId: 'other' }, { provenance: {} },
  ])('rejects malformed, incomplete or client-owned evidence: %j', (patch) => {
    expect(() => validateNdaRequest(request(patch), 'fixture')).toThrow();
  });
  it('rejects cross-user selectors before accessing Firebase or the DB', async () => {
    const read = vi.fn();
    await expect(executeNdaRequest({ kind: 'nda', operation: 'status', userId: 'victim' }, actor, {}, { readAccount: read })).rejects.toMatchObject({ status: 400 });
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['https://example.invalid/nda.pdf', 'blob:fake', '/api/gcp/storage/assets/other/signed-ndas/nda_x_1.pdf', '/api/gcp/storage/assets/fixture/signed-ndas/../secret', '/api/gcp/storage/assets/fixture/signed-ndas/nda_fixture_1.pdf?token=bad'])('rejects untrusted PDF reference %s', (pdfUrl) => {
    expect(() => validateNdaRequest(request({ pdfUrl }), 'fixture')).toThrow('PDF reference');
  });
  it('accepts only the existing caller-owned PDF storage namespace or no PDF', () => {
    const pdfUrl = '/api/gcp/storage/assets/fixture/signed-ndas/nda_fixture_1.pdf';
    expect(validateNdaRequest(request({ pdfUrl }), 'fixture').pdfUrl).toBe(pdfUrl);
    expect(validateNdaRequest(request(), 'fixture').pdfUrl).toBeNull();
  });
  it.each(['insert', 'update', 'upsert', 'delete'])('blocks generic NDA %s', (operation) => {
    expect(() => compileTableQuery({ kind: 'table', table: 'nda_signatures', operation, values: { signer_name: 'Forged' }, filters: [{ column: 'user_id', operator: 'eq', value: 'victim' }] })).toThrow();
  });
  it.each(['check_user_nda_status', 'sign_global_nda'])('blocks the retired %s RPC', async (rpc) => {
    expect(RPC_NAMES.has(rpc)).toBe(false);
  });
  it.each([{ uid: 'other' }, { sub: 'other' }, { aud: 'not-uat' }, { iss: 'other' }, { firebase: { tenant: 'other' } }])('rejects wrong verified authority: %j', async (patch) => {
    await expect(prepareIdentityEvidence({ ...actor, ...patch }, { readAccount })).rejects.toMatchObject({ code: 'AUTH_INVALID', status: 401 });
  });
  it('derives fingerprints from Admin provider subjects, not email or request fields', async () => {
    const evidence = await prepareIdentityEvidence(actor, { readAccount });
    expect(evidence.providers[0]).toEqual({ providerId: 'google.com', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(evidence.providers)).not.toContain('subject');
    expect(evidence.createdAt).toBe('2026-09-01T00:00:00.000Z');
  });
  it('fails closed for deleted, disabled and unavailable Firebase accounts', async () => {
    await expect(prepareIdentityEvidence(actor, { readAccount: async () => ({ ...await readAccount(), disabled: true }) })).rejects.toMatchObject({ status: 401 });
    await expect(prepareIdentityEvidence(actor, { readAccount: async () => { throw { code: 'auth/user-not-found' }; } })).rejects.toMatchObject({ status: 401 });
    await expect(prepareIdentityEvidence(actor, { readAccount: async () => { throw new Error('provider down'); } })).rejects.toMatchObject({ status: 503 });
  });
});
