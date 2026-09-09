import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import {
  assertUatOrigin, createUatOAuthEvidence, safeLocation, verifyFirebaseHelper,
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

describe('UAT workflow auth-domain contract', () => {
  const source = readFileSync(new URL('../.github/workflows/deploy-uat.yml', import.meta.url), 'utf8');
  const workflow = yaml.safeLoad(source) as {env: Record<string, string>; jobs: {deploy: {steps: {name?: string; run?: string}[]}}};
  const steps = workflow.jobs.deploy.steps;
  const validation = steps.find(step => step.name === 'Validate client auth env')!.run!;

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
    ['VITE_GCP_AUTH_REDIRECT_URL', 'https://hushhtech.com/auth/callback'],
  ])('fails before build on %s drift without printing values', (name, value) => {
    const result = validate({ [name]: value });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('reviewed UAT configuration');
    expect(result.stdout).not.toContain(value);
  });
});
