const IDENTITY_LOOKUP_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts:lookup";

export class HushhResearchAuthError extends Error {
  constructor(state, message, statusCode) {
    super(message);
    this.name = "HushhResearchAuthError";
    this.state = state;
    this.statusCode = statusCode;
  }
}

function decodeJwtPart(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new HushhResearchAuthError(
      "UNAUTHENTICATED",
      "Sign-in required.",
      401,
    );
  }
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new HushhResearchAuthError(
      "UNAUTHENTICATED",
      "Sign-in required.",
      401,
    );
  }
}

export function readFirebaseBearer(req) {
  const raw = String(
    req.headers?.authorization ?? req.headers?.Authorization ?? "",
  ).trim();
  const match = /^Bearer\s+([^\s]+)$/i.exec(raw);
  if (!match || match[1].length > 8192) {
    throw new HushhResearchAuthError(
      "UNAUTHENTICATED",
      "Sign-in required.",
      401,
    );
  }
  return match[1];
}

function assertClaims(payload, projectId, nowSeconds) {
  const uid = typeof payload.sub === "string" ? payload.sub.trim() : "";
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;
  if (
    !uid ||
    uid.length > 128 ||
    payload.aud !== projectId ||
    payload.iss !== expectedIssuer ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= nowSeconds ||
    !Number.isFinite(payload.iat) ||
    payload.iat > nowSeconds + 300 ||
    !Number.isFinite(payload.auth_time) ||
    payload.auth_time > nowSeconds + 300
  ) {
    throw new HushhResearchAuthError(
      "UNAUTHENTICATED",
      "Sign-in required.",
      401,
    );
  }
  return { uid, authTime: payload.auth_time };
}

function assertProductClaims(payload, config) {
  const launchAuthorizationId =
    typeof payload.product_launch_authorization_id === "string"
      ? payload.product_launch_authorization_id.trim()
      : "";
  if (
    payload.product_client !== "hushh-tech" ||
    payload.product_client_app_id !== config.developerAppId ||
    payload.product_audience !== config.audience ||
    !launchAuthorizationId ||
    launchAuthorizationId.length > 128 ||
    !Number.isSafeInteger(payload.product_launch_valid_after_ms) ||
    payload.product_launch_valid_after_ms < 0
  ) {
    throw new HushhResearchAuthError(
      "UNAUTHENTICATED",
      "Sign-in required.",
      401,
    );
  }
}

export async function verifyHushhResearchFirebaseToken(
  idToken,
  config,
  { fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000 } = {},
) {
  const segments = String(idToken).split(".");
  if (segments.length !== 3) {
    throw new HushhResearchAuthError(
      "UNAUTHENTICATED",
      "Sign-in required.",
      401,
    );
  }
  const header = decodeJwtPart(segments[0]);
  const payload = decodeJwtPart(segments[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    throw new HushhResearchAuthError(
      "UNAUTHENTICATED",
      "Sign-in required.",
      401,
    );
  }
  const claims = assertClaims(
    payload,
    config.firebase.projectId,
    Math.floor(now() / 1000),
  );
  assertProductClaims(payload, config);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(
      `${IDENTITY_LOOKUP_URL}?key=${encodeURIComponent(config.firebase.apiKey)}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idToken }),
        signal: controller.signal,
      },
    );
  } catch {
    throw new HushhResearchAuthError(
      "UPSTREAM_UNAVAILABLE",
      "Sign-in service unavailable.",
      503,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new HushhResearchAuthError(
        "UNAUTHENTICATED",
        "Sign-in required.",
        401,
      );
    }
    throw new HushhResearchAuthError(
      "UPSTREAM_UNAVAILABLE",
      "Sign-in service unavailable.",
      503,
    );
  }

  const result = await response.json().catch(() => null);
  const user = Array.isArray(result?.users)
    ? result.users.find((candidate) => candidate?.localId === claims.uid)
    : null;
  const validSince = Number(user?.validSince ?? 0);
  if (
    !user ||
    user.disabled === true ||
    (Number.isFinite(validSince) && validSince > 0 && claims.authTime < validSince)
  ) {
    throw new HushhResearchAuthError(
      "UNAUTHENTICATED",
      "Sign-in required.",
      401,
    );
  }

  return { ...claims, idToken };
}
