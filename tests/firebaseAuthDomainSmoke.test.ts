import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import {
  assertProdOrigin, assertUatOrigin, createProdGoogleOAuthEvidence,
  createUatOAuthEvidence, safeLocation, verifyFirebaseHelper, verifyProdGoogleOAuthAllowlist,
} from '../scripts/shared/firebaseAuthSmoke.mjs';

const origin = 'https://uat.hushhtech.com';
const iframe = '<html><head><script src="iframe.js"></script></head><body></body></html>';
const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };

describe('UAT helper readiness', () => {
  it('requires the managed iframe script, not just an HTTP 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(iframe, { headers }));
    await expect(verifyFirebaseHelper(origin, fetchMock)).resolves.toMatchObject({ helperDocument: true, noStore: true });
    expect(fetchMock).toHaveBeenCalledWith(`${origin}/__/auth/iframe`, expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }));
  });

  it.each([
    ['SPA', '<div id="root"></div>', 200, headers],
    ['SPA with a helper-like string', iframe + '<div id="root"></div>', 200, headers],
    ['wrong MIME', iframe, 200, { ...headers, 'content-type': 'text/plain' }],
    ['cached', iframe, 200, { ...headers, 'cache-control': 'public, max-age=60' }],
    ['missing noindex', iframe, 200, { ...headers, 'x-robots-tag': '' }],
    ['redirect', iframe, 302, { ...headers, location: 'https://example.invalid/?token=synthetic-secret' }],
    ['upstream error', iframe, 502, headers],
    ['too large', iframe + 'x'.repeat(65536), 200, headers],
  ])('rejects %s without exposing response details', async (_name, body, status, responseHeaders) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status, headers: responseHeaders }));
    await expect(verifyFirebaseHelper(origin, fetchMock)).rejects.toThrow('UAT Firebase helper readiness failed (transport, response or SPA fallback).');
  });

  it('sanitizes transport failures', async () => {
    await expect(verifyFirebaseHelper(origin, vi.fn().mockRejectedValue(new Error('secret=synthetic-secret'))))
      .rejects.toThrow(/^UAT Firebase helper readiness failed \(transport, response or SPA fallback\).$/);
  });

  it.each(['https://hushhtech.com', 'https://uat.hushhtech.com.evil.test', 'http://uat.hushhtech.com', `${origin}/login`, `${origin}/?token=secret`, 'https://user:secret@uat.hushhtech.com'])('refuses noncanonical smoke target %s', (target) => {
    expect(() => assertUatOrigin(target)).toThrow();
  });
});

describe('UAT OAuth startup evidence', () => {
  function observe(evidence: ReturnType<typeof createUatOAuthEvidence>, provider: string, redirect = `${origin}/__/auth/handler`) {
    evidence.observe(`${origin}/__/auth/handler?providerId=${provider}.com&authType=signInViaRedirect&state=synthetic-secret`);
    const host = provider === 'google' ? 'accounts.google.com' : 'appleid.apple.com';
    evidence.observe(`https://${host}/authorize?redirect_uri=${encodeURIComponent(redirect)}&response_mode=form_post&state=synthetic-secret`);
  }

  it.each(['google', 'apple'])('verifies %s callback domain without claiming authentication', (provider) => {
    const evidence = createUatOAuthEvidence(provider);
    observe(evidence, provider);
    expect(evidence.verify()).toEqual({ provider, sameOriginHelper: true, providerCallbackVerified: true, legacyAuthDomainUsed: false, authenticated: false });
    expect(JSON.stringify(evidence.verify())).not.toContain('synthetic-secret');
  });

  it('rejects the old domain even if the provider is eventually reached', () => {
    const evidence = createUatOAuthEvidence('google');
    evidence.observe('https://hushh-tech-uat.firebaseapp.com/__/auth/iframe');
    observe(evidence, 'google');
    expect(() => evidence.verify()).toThrow();
  });

  it.each(['https://hushh-tech-uat.firebaseapp.com/__/auth/handler', `${origin}/auth/callback`, `${origin}/__/auth/handler?unexpected=1`])('rejects incorrect provider callback %s', (redirect) => {
    const evidence = createUatOAuthEvidence('google');
    observe(evidence, 'google', redirect);
    expect(() => evidence.verify()).toThrow();
  });

  it('does not accept a helper or provider landing page alone', () => {
    const evidence = createUatOAuthEvidence('google');
    evidence.observe(`${origin}/__/auth/handler?providerId=google.com&authType=signInViaRedirect`);
    evidence.observe('https://accounts.google.com/');
    expect(() => evidence.verify()).toThrow();
  });

  it('requires Apple form_post', () => {
    const evidence = createUatOAuthEvidence('apple');
    observe(evidence, 'apple');
    evidence.observe(`https://appleid.apple.com/auth/authorize?redirect_uri=${encodeURIComponent(`${origin}/__/auth/handler`)}&response_mode=query`);
    expect(() => evidence.verify()).toThrow();
  });

  it('excludes query, fragment and URL credentials from reports', () => {
    expect(safeLocation('https://user:synthetic-secret@accounts.google.com/authorize?state=synthetic-secret#token=synthetic-secret'))
      .toEqual({ origin: 'https://accounts.google.com', pathname: '/authorize' });
  });
});

describe('production Google OAuth startup evidence', () => {
  const firebaseOrigin = 'https://hushh-tech-prod.firebaseapp.com';
  const clientId = '123-test.apps.googleusercontent.com';

  it('runs the strict production callback probe from the deploy workflow', () => {
    const source = readFileSync(new URL('../.github/workflows/deploy-prod.yml', import.meta.url), 'utf8');
    const workflow = yaml.safeLoad(source) as {env: Record<string, string>; jobs: {deploy: {steps: {name?: string; run?: string}[]}}};
    const smoke = workflow.jobs.deploy.steps.find(step => step.name === 'Smoke OAuth startup on deployed host');
    expect(workflow.env.SMOKE_BASE_URL).toBe('https://hushhtech.com');
    expect(smoke?.run).toContain('scripts/smoke-oauth-start.mjs "$SMOKE_BASE_URL" --prod-auth-domain');
  });

  function observe(redirect = `${firebaseOrigin}/__/auth/handler`) {
    const evidence = createProdGoogleOAuthEvidence();
    evidence.observe(`${firebaseOrigin}/__/auth/handler?providerId=google.com&authType=signInViaRedirect&state=synthetic-secret`);
    evidence.observe(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&state=synthetic-secret`);
    return evidence;
  }

  it('requires the exact Firebase callback sent to Google', () => {
    expect(observe().verify()).toEqual({
      provider: 'google', firebaseHandlerVerified: true, providerCallbackVerified: true, authenticated: false,
    });
    expect(JSON.stringify(observe().verify())).not.toContain('synthetic-secret');
    expect(observe().getClientId()).toBe(clientId);
  });

  it.each([
    'https://uat.hushhtech.com/__/auth/handler',
    'https://hushhtech.com/__/auth/handler',
    `${firebaseOrigin}/auth/callback`,
  ])('rejects a mismatched redirect URI: %s', (redirect) => {
    expect(() => observe(redirect).verify()).toThrow('Production Google OAuth callback contract failed.');
  });

  it('requires the Firebase handler request and canonical production target', () => {
    const evidence = createProdGoogleOAuthEvidence();
    evidence.observe(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(`${firebaseOrigin}/__/auth/handler`)}`);
    expect(() => evidence.verify()).toThrow();
    expect(() => assertProdOrigin('https://hushhtech.com/')).not.toThrow();
    expect(() => assertProdOrigin('https://uat.hushhtech.com/')).toThrow();
  });

  it('probes Google without cookies or sign-in and accepts only a redirect to the exact callback', async () => {
    const location = `${firebaseOrigin}/__/auth/handler?state=probe-only&error=interaction_required`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    await expect(verifyProdGoogleOAuthAllowlist(clientId, fetchMock)).resolves.toEqual({
      googleCallbackAllowlisted: true, authenticated: false,
    });
    const [requestUrl, options] = fetchMock.mock.calls[0];
    const request = new URL(requestUrl);
    expect(request.origin).toBe('https://accounts.google.com');
    expect(request.searchParams.get('client_id')).toBe(clientId);
    expect(request.searchParams.get('redirect_uri')).toBe(`${firebaseOrigin}/__/auth/handler`);
    expect(request.searchParams.get('prompt')).toBe('none');
    expect(options).toMatchObject({ redirect: 'manual', credentials: 'omit' });
  });

  it.each([
    'https://accounts.google.com/signin/oauth/error?authError=synthetic-secret',
    `${firebaseOrigin}/__/auth/handler?state=wrong&error=interaction_required`,
    `${firebaseOrigin}/__/auth/handler?state=probe-only&code=synthetic-secret`,
  ])('rejects an unallowlisted or unsafe Google probe response', async (location) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    await expect(verifyProdGoogleOAuthAllowlist(clientId, fetchMock))
      .rejects.toThrow('Production Google OAuth redirect allowlist probe failed.');
  });

  it('sanitizes a transport failure from the probe', async () => {
    await expect(verifyProdGoogleOAuthAllowlist(clientId, vi.fn().mockRejectedValue(new Error('secret=synthetic-secret'))))
      .rejects.toThrow(/^Production Google OAuth redirect allowlist probe failed\.$/);
  });
});

describe('UAT workflow auth-domain contract', () => {
  const source = readFileSync(new URL('../.github/workflows/deploy-uat.yml', import.meta.url), 'utf8');
  const workflow = yaml.safeLoad(source) as {env: Record<string, string>; jobs: {deploy: {steps: {name?: string; run?: string}[]}}};
  const steps = workflow.jobs.deploy.steps;
  const validation = steps.find(step => step.name === 'Validate client auth env')!.run!;

  it('keeps both UAT build paths aligned with the reviewed client configuration', () => {
    // Read the constants without importing the executable deployment script.
    const deploySource = readFileSync(new URL('../scripts/deploy/uat-deploy.mjs', import.meta.url), 'utf8');
    const dockerfile = readFileSync(new URL('../Dockerfile.gcp', import.meta.url), 'utf8');
    const buildArgs = deploySource.match(/const BUILD_ARGS = \{([\s\S]*?)\n\};/)?.[1];
    expect(buildArgs).toBeDefined();
    expect(workflow.env.VITE_GCP_API_BASE_URL).toBe(origin);
    expect(validation).toContain('VITE_GCP_API_BASE_URL');
    expect(deploySource).toContain('--build-arg ${name}=${JSON.stringify(value)}');
    expect(dockerfile).toContain('ARG VITE_GCP_API_BASE_URL');
    for (const name of ['VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_GCP_API_BASE_URL', 'VITE_GCP_AUTH_REDIRECT_URL']) {
      const value = buildArgs!.match(new RegExp(`${name}:\\s*"([^"]+)"`))?.[1];
      expect(value, `${name} must match the governed UAT workflow`).toBe(workflow.env[name]);
    }
  });

  it('uses one UAT domain source and preserves the existing secret sources and release gates', () => {
    expect(workflow.env.VITE_FIREBASE_AUTH_DOMAIN).toBe('uat.hushhtech.com');
    expect(source).toContain('firebase_auth_domain="$VITE_FIREBASE_AUTH_DOMAIN"');
    expect(source).not.toContain('hushh-tech-uat.firebaseapp.com');
    expect(source).toContain('--project=hushh-tech-uat --secret=hushh-tech-firebase-web-api-key');
    expect(source).toContain('--project=hushh-tech-uat --secret=hushh-tech-firebase-web-app-id');
    expect(source).toContain('REQUIRED_CHECK_NAME: Main Post-Merge Smoke Gate');
    expect(source).toContain('--to-revisions="${captured_revision}=100"');
    expect(steps.find(step => step.name === 'Smoke OAuth startup on deployed host')!.run).toContain('--uat-auth-domain');
  });

  function validate(overrides: Record<string, string> = {}) {
    return spawnSync('bash', ['-c', validation], {
      encoding: 'utf8', env: { ...process.env, ...workflow.env, HUSHH_RESEARCH_CLIENT_ENABLED: 'false', ...overrides },
    });
  }

  it('accepts the intended build configuration', () => expect(validate().status).toBe(0));
  it.each([
    ['VITE_FIREBASE_AUTH_DOMAIN', 'hushh-tech-uat.firebaseapp.com'],
    ['VITE_FIREBASE_PROJECT_ID', 'wrong-project'],
    ['VITE_GCP_API_BASE_URL', 'https://hushhtech.com'],
    ['VITE_GCP_AUTH_REDIRECT_URL', 'https://hushhtech.com/auth/callback'],
  ])('fails before build on %s drift without printing values', (name, value) => {
    const result = validate({ [name]: value });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('reviewed UAT configuration');
    expect(result.stdout).not.toContain(value);
  });
});
