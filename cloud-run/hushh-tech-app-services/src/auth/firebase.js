import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

import { RuntimeError } from "../errors.js";

const TOKEN_LIMIT = 8_192;
// The generated inventory records these legacy browser functions as
// recent-auth routes, but the source Supabase implementation accepted any
// valid Firebase session. Keep the exception exact and local so recent-auth
// remains mandatory for every unrelated sensitive route.
const LEGACY_FINANCIAL_LINK_SLUGS = new Set([
  "asset-report-create",
  "create-link-token",
  "exchange-public-token",
  "plaid-data-sync",
  "plaid-data-sync-product",
  "plaid-data-sync-start",
  "plaid-diagnostics-log",
]);

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value.join(",") : String(value ?? "").trim();
}

function readBearer(headers, name) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(headerValue(headers, name));
  if (!match || match[1].length < 32 || match[1].length > TOKEN_LIMIT) {
    throw new RuntimeError("UNAUTHENTICATED", "Sign-in required.", 401);
  }
  return match[1];
}

function invalidToken() {
  return new RuntimeError("UNAUTHENTICATED", "Sign-in required.", 401);
}

function requiresRecentFirebaseAuth(entry) {
  return (
    entry?.auth_mode?.includes("recent_auth") &&
    !(
      entry.owner_group === "financial-api-worker" &&
      LEGACY_FINANCIAL_LINK_SLUGS.has(entry.slug)
    )
  );
}

function assertFirebaseClaims(decoded, config, nowMs, recentAuthRequired, entry) {
  const nowSeconds = Math.floor(nowMs / 1_000);
  const uid = String(decoded?.uid ?? decoded?.sub ?? "").trim();
  const authTime = Number(decoded?.auth_time);
  const issuedAt = Number(decoded?.iat);
  const expiresAt = Number(decoded?.exp);
  const launchAuthorizationId = String(
    decoded?.product_launch_authorization_id ?? "",
  ).trim();
  const launchValidAfterMs = Number(decoded?.product_launch_valid_after_ms);
  // The existing UAT website issues ordinary Firebase sessions, not Research
  // product-launch sessions. Accept that same session contract only for the
  // seven legacy Finance Link routes. Explicit product claims still require
  // the complete, matching product context; unrelated routes are unchanged.
  const ordinaryFinanceSession =
    config.firebaseProjectId === "hushh-tech-uat" &&
    entry?.owner_group === "financial-api-worker" &&
    entry.auth_mode === "firebase_bearer_recent_auth_or_google_service_identity" &&
    LEGACY_FINANCIAL_LINK_SLUGS.has(entry.slug) &&
    [
      "product_client",
      "product_client_app_id",
      "product_audience",
      "product_launch_authorization_id",
      "product_launch_valid_after_ms",
    ].every((key) => !Object.hasOwn(decoded ?? {}, key));

  if (
    !uid ||
    uid.length > 128 ||
    decoded?.sub !== uid ||
    decoded?.aud !== config.firebaseProjectId ||
    decoded?.iss !==
      `https://securetoken.google.com/${config.firebaseProjectId}` ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= nowSeconds ||
    !Number.isFinite(issuedAt) ||
    issuedAt > nowSeconds + 300 ||
    !Number.isFinite(authTime) ||
    authTime > nowSeconds + 300 ||
    (!ordinaryFinanceSession &&
      (decoded?.product_client !== config.productClient ||
        decoded?.product_client_app_id !== config.productClientAppId ||
        decoded?.product_audience !== config.productAudience ||
        !launchAuthorizationId ||
        launchAuthorizationId.length > 128 ||
        !Number.isSafeInteger(launchValidAfterMs) ||
        launchValidAfterMs < 0 ||
        launchValidAfterMs > nowMs ||
        issuedAt * 1_000 < launchValidAfterMs))
  ) {
    throw invalidToken();
  }

  if (
    recentAuthRequired &&
    nowSeconds - authTime > config.recentAuthSeconds
  ) {
    throw new RuntimeError(
      "RECENT_AUTH_REQUIRED",
      "Sign in again.",
      401,
    );
  }

  const email =
    typeof decoded?.email === "string" ? decoded.email.trim().toLowerCase() : "";

  return Object.freeze({
    kind: "firebase",
    uid,
    authTime,
    launchAuthorizationId: ordinaryFinanceSession ? null : launchAuthorizationId,
    fundAdmin: decoded?.fund_admin === true,
    email:
      email && email.length <= 320 && !/[\u0000-\u001f\u007f]/.test(email)
        ? email
        : null,
  });
}

function isExpectedTokenRejection(error) {
  const code = String(error?.code ?? "");
  return (
    code.startsWith("auth/argument") ||
    code.includes("id-token") ||
    code.includes("token-revoked") ||
    code.includes("user-disabled") ||
    code.includes("invalid-credential")
  );
}

export function createFirebaseAdminAuth(projectId) {
  const name = `hushh-tech-app-services-${projectId}`;
  const app =
    getApps().find((candidate) => candidate.name === name) ??
    initializeApp({ projectId }, name);
  return getAuth(app);
}

export function createFirebaseProductVerifier({
  config,
  auth = createFirebaseAdminAuth(config.firebaseProjectId),
  now = Date.now,
} = {}) {
  if (!config || typeof auth?.verifyIdToken !== "function") {
    throw new Error("Firebase verifier configuration is required.");
  }

  return async function verifyFirebaseProductRequest(request, entry) {
    const token = readBearer(
      request.headers,
      "x-hushh-firebase-authorization",
    );
    let decoded;
    try {
      decoded = await auth.verifyIdToken(token, true);
    } catch (error) {
      if (isExpectedTokenRejection(error)) throw invalidToken();
      throw new RuntimeError(
        "AUTHORITY_UNAVAILABLE",
        "Sign-in service unavailable.",
        503,
        { cause: error },
      );
    }

    const actor = assertFirebaseClaims(
      decoded,
      config,
      now(),
      requiresRecentFirebaseAuth(entry),
      entry,
    );
    const forwardedUid = headerValue(
      request.headers,
      "x-hushh-firebase-uid",
    );
    const forwardedAuthTime = headerValue(
      request.headers,
      "x-hushh-firebase-auth-time",
    );
    if (
      forwardedUid !== actor.uid ||
      forwardedAuthTime !== String(actor.authTime)
    ) {
      throw invalidToken();
    }
    return actor;
  };
}
