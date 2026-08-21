import { OAuth2Client } from "google-auth-library";

import { RuntimeError } from "../errors.js";

const GOOGLE_ISSUERS = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
]);
const TOKEN_LIMIT = 8_192;

function authorizationToken(request) {
  const raw = String(request.headers?.authorization ?? "").trim();
  const match = /^Bearer\s+([^\s]+)$/i.exec(raw);
  if (!match || match[1].length < 32 || match[1].length > TOKEN_LIMIT) {
    throw new RuntimeError(
      "INTERNAL_CALLER_UNAUTHENTICATED",
      "Service authentication required.",
      401,
    );
  }
  return match[1];
}

function rejected() {
  return new RuntimeError(
    "INTERNAL_CALLER_UNAUTHENTICATED",
    "Service authentication required.",
    401,
  );
}

export function createGoogleServiceVerifier({
  config,
  client = new OAuth2Client(),
  now = Date.now,
} = {}) {
  if (!config || typeof client?.verifyIdToken !== "function") {
    throw new Error("Google service verifier configuration is required.");
  }
  const allowed = new Set(config.allowedGoogleCallers);

  return async function verifyGoogleServiceRequest(request) {
    const token = authorizationToken(request);
    let ticket;
    try {
      ticket = await client.verifyIdToken({
        idToken: token,
        audience: config.serviceAudience,
      });
    } catch (error) {
      throw new RuntimeError(
        "INTERNAL_CALLER_UNAUTHENTICATED",
        "Service authentication required.",
        401,
        { cause: error },
      );
    }

    const payload = ticket?.getPayload?.();
    const nowSeconds = Math.floor(now() / 1_000);
    const email = String(payload?.email ?? "").trim().toLowerCase();
    const subject = String(payload?.sub ?? "").trim();
    if (
      !payload ||
      payload.aud !== config.serviceAudience ||
      !GOOGLE_ISSUERS.has(payload.iss) ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= nowSeconds ||
      !Number.isFinite(payload.iat) ||
      payload.iat > nowSeconds + 300 ||
      !subject ||
      !email ||
      payload.email_verified !== true ||
      !allowed.has(email)
    ) {
      throw rejected();
    }

    return Object.freeze({ kind: "google-service", email, subject });
  };
}
