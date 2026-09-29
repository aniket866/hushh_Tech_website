const UAT_ORIGIN = 'https://uat.hushhtech.com';
const LEGACY_HOST = 'hushh-tech-uat.firebaseapp.com';
const PROD_ORIGIN = 'https://hushhtech.com';
const PROD_FIREBASE_ORIGIN = PROD_ORIGIN;
const PROD_GOOGLE_CALLBACK = `${PROD_FIREBASE_ORIGIN}/__/auth/handler`;
const PROD_APPLE_CALLBACK = `${PROD_ORIGIN}/__/auth/handler`;
const PROD_APPLE_SERVICE_ID = 'com.hushh.app.signin';
const INVALID_APPLE_CALLBACK = 'https://example.invalid/__/auth/handler';
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

export function assertProdOrigin(value) {
  const url = new URL(value);
  if (url.origin !== PROD_ORIGIN || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Production OAuth smoke requires the canonical production origin.');
  }
}

export async function verifyFirebaseHelper(baseUrl, fetchImpl = fetch) {
  const helperOrigin = new URL(baseUrl).origin;
  if (helperOrigin === PROD_ORIGIN) assertProdOrigin(baseUrl);
  else assertUatOrigin(baseUrl);
  try {
    const response = await fetchImpl(`${helperOrigin}/__/auth/iframe`, {
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
    throw new Error('Firebase helper readiness failed (transport, response or SPA fallback).');
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

// Production uses the same-origin Firebase helper transport. Verify the
// exact URI emitted for Google from both login and signup; reaching Google alone
// does not prove that the OAuth client's allowlist accepts this URI.
export function createProdGoogleOAuthEvidence() {
  let firebaseHandlerSeen = false;
  let providerSeen = false;
  let clientId = null;
  let invalid = false;
  return {
    observe(value) {
      try {
        const url = new URL(value);
        if (url.origin === PROD_FIREBASE_ORIGIN && url.pathname === '/__/auth/handler' &&
            url.searchParams.get('providerId') === 'google.com' &&
            url.searchParams.get('authType') === 'signInViaRedirect') firebaseHandlerSeen = true;
        if (url.protocol === 'https:' && url.hostname === PROVIDER_HOSTS.google && url.searchParams.has('redirect_uri')) {
          providerSeen = true;
          const observedClientId = url.searchParams.get('client_id');
          if (url.searchParams.get('redirect_uri') !== PROD_GOOGLE_CALLBACK ||
              !observedClientId || (clientId && clientId !== observedClientId)) invalid = true;
          else clientId = observedClientId;
        }
      } catch { invalid = true; }
    },
    verify() {
      if (invalid || !firebaseHandlerSeen || !providerSeen || !clientId) throw new Error('Production Google OAuth callback contract failed.');
      return { provider: 'google', firebaseHandlerVerified: true, providerCallbackVerified: true, authenticated: false };
    },
    getClientId() { return clientId; },
  };
}

// Google validates registered redirect URIs before returning to the callback.
// prompt=none makes this a no-cookie, no-login probe. Never expose Google's
// Location header, which can contain OAuth state or account information.
export async function verifyProdGoogleOAuthAllowlist(clientId, fetchImpl = fetch) {
  try {
    if (!/^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId || '')) throw new Error();
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', PROD_GOOGLE_CALLBACK);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', 'probe-only');
    url.searchParams.set('prompt', 'none');
    const response = await fetchImpl(url.toString(), {
      redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(15000),
      headers: { 'Cache-Control': 'no-cache' },
    });
    const location = new URL(response.headers.get('location'));
    if (response.status !== 302 || location.origin !== PROD_FIREBASE_ORIGIN ||
        location.pathname !== '/__/auth/handler' || location.username || location.password ||
        location.hash || location.searchParams.get('state') !== 'probe-only' ||
        !['interaction_required', 'login_required'].includes(location.searchParams.get('error')) ||
        location.searchParams.has('code')) throw new Error();
    return { googleCallbackAllowlisted: true, authenticated: false };
  } catch {
    throw new Error('Production Google OAuth redirect allowlist probe failed.');
  }
}

// Apple serves HTTP 200 for both its sign-in page and a rejected Return URL.
// Compare the production callback with a deliberately invalid control so an
// ordinary 200 or a generic sign-in shell cannot falsely pass the release gate.
export async function verifyProdAppleOAuthAllowlist(serviceId, fetchImpl = fetch) {
  try {
    if (serviceId !== PROD_APPLE_SERVICE_ID) throw new Error();
    async function probe(callback) {
      const url = new URL('https://appleid.apple.com/auth/authorize');
      url.searchParams.set('client_id', serviceId);
      url.searchParams.set('redirect_uri', callback);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('response_mode', 'form_post');
      url.searchParams.set('scope', 'name email');
      url.searchParams.set('state', 'probe-only');
      const response = await fetchImpl(url.toString(), {
        redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(15000),
        headers: { 'Cache-Control': 'no-cache', 'Accept-Language': 'en-US' },
      });
      if (response.status !== 200 || response.redirected ||
          !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error();
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const decoder = new TextDecoder();
      let body = '';
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 256 * 1024) throw new Error();
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      } finally {
        await reader.cancel();
      }
      return body;
    }
    const [accepted, rejected] = await Promise.all([
      probe(PROD_APPLE_CALLBACK), probe(INVALID_APPLE_CALLBACK),
    ]);
    if (!accepted.includes('Sign In with Apple') || !accepted.includes('idmsa.apple.com') ||
        accepted.includes('"errorCode":"invalid_request"') ||
        !rejected.includes('"errorCode":"invalid_request"') ||
        !rejected.includes('Invalid web redirect url.') ||
        rejected.includes('Sign In with Apple')) throw new Error();
    return { appleCallbackAllowlisted: true, authenticated: false };
  } catch {
    throw new Error('Production Apple OAuth redirect allowlist probe failed.');
  }
}


export function createProdAppleOAuthEvidence() {
  let helperSeen = false;
  let providerSeen = false;
  let invalid = false;
  return {
    observe(value) {
      try {
        const url = new URL(value);
        if (url.origin === PROD_ORIGIN && url.pathname === '/__/auth/handler' &&
            url.searchParams.get('providerId') === 'apple.com' &&
            url.searchParams.get('authType') === 'signInViaRedirect') helperSeen = true;
        if (url.origin === 'https://appleid.apple.com' && url.searchParams.has('redirect_uri')) {
          providerSeen = true;
          if (url.searchParams.get('redirect_uri') !== `${PROD_ORIGIN}/__/auth/handler` ||
              url.searchParams.get('response_mode') !== 'form_post') invalid = true;
        }
      } catch { invalid = true; }
    },
    verify() {
      if (invalid || !helperSeen || !providerSeen) throw new Error('Production Apple OAuth callback contract failed.');
      return { provider: 'apple', sameOriginHelper: true, providerCallbackVerified: true, authenticated: false };
    },
  };
}
