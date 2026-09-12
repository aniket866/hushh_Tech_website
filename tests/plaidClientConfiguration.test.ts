import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/auth/session', () => ({
  getAuthenticatedSession: vi.fn(),
}));

vi.mock('../src/resources/config/config', () => ({
  default: { gcpBackendClient: undefined },
}));

describe('Plaid client build configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('fails before creating a network request when the Vite API base is absent', async () => {
    vi.stubEnv('VITE_GCP_API_BASE_URL', '');
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'public-test-key');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { createLinkToken } = await import('../src/services/plaid/plaidService');

    await expect(createLinkToken('user-123')).rejects.toThrow(
      'VITE_GCP_API_BASE_URL is not configured',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creates the same-origin UAT link-token request when the build base is present', async () => {
    vi.stubEnv('VITE_GCP_API_BASE_URL', 'https://uat.hushhtech.com');
    vi.stubEnv('VITE_FIREBASE_API_KEY', 'public-test-key');
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        link_token: 'link-sandbox-token',
        expiration: '2030-01-01T00:00:00.000Z',
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { createLinkToken } = await import('../src/services/plaid/plaidService');

    await expect(createLinkToken('user-123', 'user@example.test')).resolves.toEqual({
      link_token: 'link-sandbox-token',
      expiration: '2030-01-01T00:00:00.000Z',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://uat.hushhtech.com/functions/v1/create-link-token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer public-test-key',
        }),
      }),
    );
  });

});
