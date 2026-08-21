const METADATA_IDENTITY_ENDPOINT =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

export class GcpServiceIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "GcpServiceIdentityError";
  }
}

function canonicalAudience(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new GcpServiceIdentityError("Invalid internal service audience.");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    throw new GcpServiceIdentityError("Invalid internal service audience.");
  }

  return parsed.origin;
}

function tokenExpiryMs(token) {
  const segments = String(token).split(".");
  if (segments.length !== 3) return 0;

  try {
    const payload = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    );
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function createMetadataIdentityTokenProvider({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 3000,
} = {}) {
  const cache = new Map();

  return async function getIdentityToken(audienceValue) {
    const audience = canonicalAudience(audienceValue);
    const cached = cache.get(audience);
    if (cached && cached.expiresAtMs - 60_000 > now()) {
      return cached.token;
    }

    const url = new URL(METADATA_IDENTITY_ENDPOINT);
    url.searchParams.set("audience", audience);
    url.searchParams.set("format", "full");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { "Metadata-Flavor": "Google" },
        signal: controller.signal,
      });
    } catch {
      throw new GcpServiceIdentityError(
        "Internal service identity is unavailable.",
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new GcpServiceIdentityError(
        "Internal service identity is unavailable.",
      );
    }

    const token = (await response.text()).trim();
    if (
      token.length < 32 ||
      token.length > 8192 ||
      token.split(".").length !== 3
    ) {
      throw new GcpServiceIdentityError(
        "Internal service identity is unavailable.",
      );
    }

    const expiresAtMs = tokenExpiryMs(token) || now() + 60_000;
    cache.set(audience, { token, expiresAtMs });
    return token;
  };
}
