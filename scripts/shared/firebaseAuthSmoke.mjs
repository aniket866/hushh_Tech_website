const UAT_ORIGIN = 'https://uat.hushhtech.com';
const LEGACY_HOST = 'hushh-tech-uat.firebaseapp.com';
const PROVIDER_HOSTS = { google: 'accounts.google.com', apple: 'appleid.apple.com' };

// Never include raw URLs, response bodies, cookies or transport errors in smoke
// reports: provider URLs can contain state, codes and other credentials.
export function safeLocation(value) {
  const url = new URL(value);
  return { origin: url.origin, pathname: url.pathname };
}

export function assertUatOrigin(value) {
  const url = new URL(value);
  if (url.origin !== UAT_ORIGIN || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('UAT OAuth smoke requires the canonical UAT origin.');
  }
}

export async function verifyFirebaseHelper(baseUrl, fetchImpl = fetch) {
  assertUatOrigin(baseUrl);
  try {
    const response = await fetchImpl(`${UAT_ORIGIN}/__/auth/iframe`, {
      redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { 'Cache-Control': 'no-cache' },
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    let body = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) throw new Error();
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      await reader.cancel();
    }
    // The managed iframe document references the helper script. A successful
    // HTTP status alone also matches our SPA fallback and is not proof.
    const helperScript = /<script\b[^>]*\bsrc\s*=\s*["'](?:iframe\.js|\/__\/auth\/iframe\.js)["']/i.test(body);
    const spaShell = /\bid\s*=\s*["']root["']|\/assets\/index[-.]|\/src\/main\./i.test(body);
    if (response.status !== 200 || response.redirected ||
        !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '') ||
        response.headers.get('cache-control') !== 'no-store' ||
        response.headers.get('x-robots-tag') !== 'noindex' || !helperScript || spaShell) {
      throw new Error();
    }
    return { status: 'passed', pathname: '/__/auth/iframe', httpStatus: 200, helperDocument: true, noStore: true };
  } catch {
    throw new Error('UAT Firebase helper readiness failed (transport, response or SPA fallback).');
  }
}

// Store only boolean evidence, not an OAuth network trace. Observe both the
// same-origin Firebase handler and the provider's actual redirect_uri.
export function createUatOAuthEvidence(provider) {
  if (!Object.hasOwn(PROVIDER_HOSTS, provider)) throw new Error('Unsupported OAuth smoke provider.');
  let helperSeen = false;
  let providerSeen = false;
  let invalid = false;
  return {
    observe(value) {
      try {
        const url = new URL(value);
        if (url.hostname === LEGACY_HOST) invalid = true;
        if (url.origin === UAT_ORIGIN && url.pathname === '/__/auth/handler' &&
            url.searchParams.get('providerId') === `${provider}.com` &&
            url.searchParams.get('authType') === 'signInViaRedirect') helperSeen = true;
        if (url.protocol === 'https:' && url.hostname === PROVIDER_HOSTS[provider] && url.searchParams.has('redirect_uri')) {
          providerSeen = true;
          if (url.searchParams.get('redirect_uri') !== `${UAT_ORIGIN}/__/auth/handler`) invalid = true;
          if (provider === 'apple' && url.searchParams.get('response_mode') !== 'form_post') invalid = true;
        }
      } catch { invalid = true; }
    },
    verify() {
      if (invalid || !helperSeen || !providerSeen) throw new Error('UAT OAuth startup domain contract failed.');
      return { provider, sameOriginHelper: true, providerCallbackVerified: true, legacyAuthDomainUsed: false, authenticated: false };
    },
  };
}
