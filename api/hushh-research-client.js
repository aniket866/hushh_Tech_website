import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  publicHushhResearchConfig,
  readHushhResearchServerConfig,
} from "./shared/hushhResearchConfig.js";
import {
  decryptHushhResearchExport,
  HushhResearchCryptoError,
} from "./shared/hushhResearchCrypto.js";
import {
  HushhResearchAuthError,
  readFirebaseBearer,
  verifyHushhResearchFirebaseToken,
} from "./shared/hushhResearchFirebase.js";
import {
  createHushhResearchExportReplayStore,
  HushhResearchReplayStoreError,
} from "./shared/hushhResearchReplayStore.js";
import { createHushhResearchSyntheticProof } from "./fixtures/hushhResearchSyntheticFixtures.js";

const LAUNCH_COOKIE = "__Host-hushh_research_launch";
const LAUNCH_TTL_SECONDS = 60;
const MAX_UPSTREAM_BYTES = 14 * 1024 * 1024;
const CONSENT_SCOPE = "attr.identity.name";
const SYNTHETIC_LEGACY_PROJECT = "hushh-tech-uat-synthetic";
const LINK_ID_PATTERN = /^htl_[a-f0-9]{32}$/;
const REQUEST_ID_PATTERN = /^req_[a-f0-9]{28}$/;
const CONSENT_STATUSES = new Set([
  "already_granted",
  "cancelled",
  "denied",
  "denied_recently",
  "expired",
  "granted",
  "not_found",
  "pending",
  "requires_reconsent",
  "revoked",
]);
const UPSTREAM_ERROR_CONTRACT = Object.freeze({
  UNAUTHENTICATED: Object.freeze({
    upstreamStatuses: Object.freeze([401]),
    statusCode: 401,
    message: "Sign-in required.",
  }),
  LINK_REQUIRED: Object.freeze({
    upstreamStatuses: Object.freeze([403, 409]),
    statusCode: 409,
    message: "Link the product account first.",
  }),
  LINK_CONFLICT: Object.freeze({
    upstreamStatuses: Object.freeze([409]),
    statusCode: 409,
    message: "This product account has a link conflict.",
  }),
  CONSENT_REQUIRED: Object.freeze({
    upstreamStatuses: Object.freeze([403, 409]),
    statusCode: 409,
    message: "Consent is required.",
  }),
  STALE_SHADOW: Object.freeze({
    upstreamStatuses: Object.freeze([503]),
    statusCode: 503,
    message: "Research data is not ready.",
  }),
  FEATURE_DISABLED: Object.freeze({
    upstreamStatuses: Object.freeze([403, 404]),
    statusCode: 404,
    message: "Research access is not enabled.",
  }),
  UPSTREAM_UNAVAILABLE: Object.freeze({
    upstreamStatuses: Object.freeze([502, 503, 504]),
    statusCode: 503,
    message: "Research service unavailable.",
  }),
});
const COMPATIBILITY_RECORDS = new Set([
  "profile",
  "onboarding",
  "access_state",
  "report_asset",
]);
const COMPATIBILITY_PAYLOAD_KEYS = Object.freeze({
  profile: {
    allowed: new Set(["display_name", "avatar_asset_id", "locale"]),
    required: new Set(["display_name"]),
  },
  onboarding: {
    allowed: new Set(["status", "current_step", "completed_steps"]),
    required: new Set(["status", "completed_steps"]),
  },
  access_state: {
    allowed: new Set(["state", "reason_code", "last_evaluated_at_ms"]),
    required: new Set(["state", "last_evaluated_at_ms"]),
  },
  report_asset: {
    allowed: new Set([
      "asset_id",
      "report_type",
      "storage_state",
      "generated_at_ms",
    ]),
    required: new Set([
      "asset_id",
      "report_type",
      "storage_state",
      "generated_at_ms",
    ]),
  },
});

class GatewayError extends Error {
  constructor(statusCode, state, message) {
    super(message);
    this.name = "GatewayError";
    this.statusCode = statusCode;
    this.state = state;
  }
}

function setNoStore(res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
}

function sendJson(res, statusCode, payload) {
  setNoStore(res);
  return res.status(statusCode).json(payload);
}

function sendTypedError(res, statusCode, state, message) {
  return sendJson(res, statusCode, {
    state,
    message,
    detail: { code: state, message },
  });
}

function requestPath(req) {
  if (typeof req.path === "string") return req.path;
  try {
    return new URL(String(req.url ?? ""), "https://hushhtech.local").pathname;
  } catch {
    return "";
  }
}

function requireMethod(req, expected) {
  if (String(req.method ?? "").toUpperCase() !== expected) {
    throw new GatewayError(405, "INVALID_REQUEST", "Method not allowed.");
  }
}

function requireRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(400, "INVALID_REQUEST", "Request is incomplete.");
  }
  return value;
}

function requiredString(value, key, { min = 1, max = 4096 } = {}) {
  const result = typeof value?.[key] === "string" ? value[key].trim() : "";
  if (result.length < min || result.length > max) {
    throw new GatewayError(400, "INVALID_REQUEST", "Request is incomplete.");
  }
  return result;
}

function optionalString(value, key, max) {
  if (value?.[key] === undefined || value?.[key] === null) return undefined;
  if (typeof value[key] !== "string" || value[key].trim().length > max) {
    throw new GatewayError(400, "INVALID_REQUEST", "Request is incomplete.");
  }
  const result = value[key].trim();
  return result || undefined;
}

function rejectClientIdentity(value) {
  const forbidden = ["user_id", "userId", "uid", "email", "phone"];
  if (forbidden.some((key) => Object.hasOwn(value, key))) {
    throw new GatewayError(
      400,
      "INVALID_REQUEST",
      "User identity comes from sign-in.",
    );
  }
}

function cookieSigningKey(developerToken) {
  return createHmac("sha256", developerToken)
    .update("hushh-tech-research-launch-cookie-v1", "utf8")
    .digest();
}

function createLaunchCookie(config, now, randomBytesImpl) {
  const issuedAt = Math.floor(now() / 1000);
  const payload = {
    exp: issuedAt + LAUNCH_TTL_SECONDS,
    iat: issuedAt,
    state: randomBytesImpl(32).toString("base64url"),
    verifier: randomBytesImpl(32).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", cookieSigningKey(config.developerToken))
    .update(encoded, "ascii")
    .digest("base64url");
  return { payload, value: `${encoded}.${signature}` };
}

function setLaunchCookie(res, value) {
  res.setHeader(
    "Set-Cookie",
    `${LAUNCH_COOKIE}=${value}; Max-Age=${LAUNCH_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
}

function clearLaunchCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${LAUNCH_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
}

function readCookie(req, name) {
  const raw = String(req.headers?.cookie ?? req.headers?.Cookie ?? "");
  for (const item of raw.split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function verifyLaunchCookie(req, config, expectedState, now) {
  const raw = readCookie(req, LAUNCH_COOKIE);
  const [encoded, signature, extra] = raw.split(".");
  if (!encoded || !signature || extra) {
    throw new GatewayError(400, "UNAUTHENTICATED", "Launch expired.");
  }
  const expectedSignature = createHmac(
    "sha256",
    cookieSigningKey(config.developerToken),
  )
    .update(encoded, "ascii")
    .digest();
  let suppliedSignature;
  try {
    suppliedSignature = Buffer.from(signature, "base64url");
  } catch {
    throw new GatewayError(400, "UNAUTHENTICATED", "Launch expired.");
  }
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new GatewayError(400, "UNAUTHENTICATED", "Launch expired.");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new GatewayError(400, "UNAUTHENTICATED", "Launch expired.");
  }
  const nowSeconds = Math.floor(now() / 1000);
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.state !== "string" ||
    typeof payload.verifier !== "string" ||
    payload.verifier.length < 43 ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp - payload.iat !== LAUNCH_TTL_SECONDS ||
    payload.iat > nowSeconds ||
    payload.exp <= nowSeconds ||
    payload.state !== expectedState
  ) {
    throw new GatewayError(400, "UNAUTHENTICATED", "Launch expired.");
  }
  return {
    ...payload,
    replayKey: createHash("sha256").update(raw, "ascii").digest("hex"),
  };
}

function consumeLaunchCookieOnce(cache, launch, nowMs) {
  for (const [key, expiry] of cache) {
    if (expiry <= nowMs) cache.delete(key);
  }
  if (cache.has(launch.replayKey)) {
    throw new GatewayError(401, "UNAUTHENTICATED", "Launch expired.");
  }
  while (cache.size >= 2048) cache.delete(cache.keys().next().value);
  cache.set(launch.replayKey, launch.exp * 1000);
}

function buildResearchLaunchUrl(config, launch) {
  const target = new URL(config.launchPath, config.webBaseUrl);
  target.searchParams.set("audience", config.audience);
  target.searchParams.set("redirect_uri", config.redirectUri);
  target.searchParams.set("state", launch.state);
  target.searchParams.set(
    "code_challenge",
    createHash("sha256").update(launch.verifier, "ascii").digest("base64url"),
  );
  target.searchParams.set("code_challenge_method", "S256");
  return target.toString();
}

async function requestResearch(
  config,
  path,
  options,
  { fetchImpl, timeoutMs = 10000 },
) {
  const target = new URL(path, `${config.apiBaseUrl}/`);
  if (target.origin !== new URL(config.apiBaseUrl).origin) {
    throw new GatewayError(
      503,
      "UPSTREAM_UNAVAILABLE",
      "Research service unavailable.",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(target.toString(), {
      ...options,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options.headers,
      },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new GatewayError(
      503,
      "UPSTREAM_UNAVAILABLE",
      "Research service unavailable.",
    );
  } finally {
    clearTimeout(timer);
  }

  const contentLength = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPSTREAM_BYTES) {
    throw new GatewayError(
      502,
      "UPSTREAM_UNAVAILABLE",
      "Research service returned an invalid response.",
    );
  }
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    throw new GatewayError(
      502,
      "UPSTREAM_UNAVAILABLE",
      "Research service returned an invalid response.",
    );
  }
  return { ok: response.ok, status: response.status, payload };
}

function upstreamError(result) {
  const detail =
    result.payload?.detail && typeof result.payload.detail === "object"
      ? result.payload.detail
      : result.payload;
  const code = String(
    detail?.code ?? detail?.error_code ?? result.payload?.state ?? "",
  ).trim();
  const contract = Object.hasOwn(UPSTREAM_ERROR_CONTRACT, code)
    ? UPSTREAM_ERROR_CONTRACT[code]
    : null;
  if (!contract || !contract.upstreamStatuses.includes(result.status)) {
    return new GatewayError(
      502,
      "UPSTREAM_UNAVAILABLE",
      "Research service unavailable.",
    );
  }
  return new GatewayError(contract.statusCode, code, contract.message);
}

function requireSuccessful(result) {
  if (!result.ok) throw upstreamError(result);
  if (result.status !== 200) throw invalidUpstreamResponse();
  return result.payload;
}

function productHeaders(config, idToken) {
  return {
    Authorization: `Bearer ${idToken}`,
    "X-Hushh-Developer-Token": config.developerToken,
  };
}

function developerHeaders(config) {
  return { Authorization: `Bearer ${config.developerToken}` };
}

function optionalSafeInteger(value, { min = 0 } = {}) {
  if (value === undefined || value === null) return null;
  return Number.isSafeInteger(value) && value >= min ? value : undefined;
}

function projectConsentResponse(payload, { expectedRequestId, expectedScope } = {}) {
  const status = String(payload.status ?? "").toLowerCase();
  const scopeValue = payload.scope ?? payload.requested_scope ?? expectedScope ?? null;
  const requestId = payload.request_id ?? expectedRequestId ?? null;
  const expiresAt = optionalSafeInteger(payload.expires_at);
  const approvalTimeoutAt = optionalSafeInteger(payload.approval_timeout_at);
  const exportRevision = optionalSafeInteger(payload.export_revision, { min: 1 });
  if (
    !CONSENT_STATUSES.has(status) ||
    (scopeValue !== null && scopeValue !== CONSENT_SCOPE) ||
    (payload.requested_scope !== undefined &&
      payload.requested_scope !== null &&
      payload.requested_scope !== CONSENT_SCOPE) ||
    (payload.granted_scope !== undefined &&
      payload.granted_scope !== null &&
      payload.granted_scope !== CONSENT_SCOPE) ||
    (requestId !== null &&
      (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId))) ||
    (expectedRequestId !== undefined && requestId !== expectedRequestId) ||
    expiresAt === undefined ||
    approvalTimeoutAt === undefined ||
    exportRevision === undefined
  ) {
    throw invalidUpstreamResponse();
  }
  return Object.freeze({
    state:
      status === "granted" || status === "already_granted"
        ? "READY"
        : "CONSENT_REQUIRED",
    status,
    scope: scopeValue,
    request_id: requestId,
    expires_at: expiresAt,
    approval_timeout_at: approvalTimeoutAt,
    export_revision: exportRevision,
  });
}

function invalidUpstreamResponse() {
  return new GatewayError(
    502,
    "UPSTREAM_UNAVAILABLE",
    "Research service returned an invalid response.",
  );
}

function projectLinkStatus(payload) {
  if (payload?.state === "LINK_REQUIRED" && payload.linked === false) {
    return Object.freeze({ state: "LINK_REQUIRED", linked: false });
  }
  if (
    payload?.state !== "READY" ||
    payload.linked !== true ||
    typeof payload.link_id !== "string" ||
    !LINK_ID_PATTERN.test(payload.link_id) ||
    payload.legacy_project !== SYNTHETIC_LEGACY_PROJECT ||
    !Number.isSafeInteger(payload.linked_at_ms) ||
    payload.linked_at_ms < 1
  ) {
    throw invalidUpstreamResponse();
  }
  return Object.freeze({
    state: "READY",
    linked: true,
    link_id: payload.link_id,
    legacy_project: SYNTHETIC_LEGACY_PROJECT,
    linked_at_ms: payload.linked_at_ms,
  });
}

function projectLinkVerification(payload) {
  if (
    payload?.state !== "READY" ||
    payload.linked !== true ||
    typeof payload.reused !== "boolean" ||
    typeof payload.recovered !== "boolean" ||
    typeof payload.link_id !== "string" ||
    !LINK_ID_PATTERN.test(payload.link_id) ||
    payload.legacy_project !== SYNTHETIC_LEGACY_PROJECT
  ) {
    throw invalidUpstreamResponse();
  }
  return Object.freeze({
    state: "READY",
    linked: true,
    reused: payload.reused,
    recovered: payload.recovered,
    link_id: payload.link_id,
    legacy_project: SYNTHETIC_LEGACY_PROJECT,
  });
}

function projectLinkRevocation(payload) {
  if (
    payload?.state !== "LINK_REQUIRED" ||
    payload.linked !== false ||
    typeof payload.revoked !== "boolean"
  ) {
    throw invalidUpstreamResponse();
  }
  return Object.freeze({
    state: "LINK_REQUIRED",
    linked: false,
    revoked: payload.revoked,
  });
}

function assertDeveloperBinding(payload, uid, config) {
  if (
    (payload.user_id !== undefined && payload.user_id !== uid) ||
    (payload.app_id !== undefined && payload.app_id !== config.developerAppId)
  ) {
    throw new GatewayError(
      502,
      "UPSTREAM_UNAVAILABLE",
      "Research service returned an invalid response.",
    );
  }
}

function shortString(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function validateCompatibilityPayload(recordType, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const contract = COMPATIBILITY_PAYLOAD_KEYS[recordType];
  const keys = Object.keys(payload);
  if (
    keys.some((key) => !contract.allowed.has(key)) ||
    [...contract.required].some((key) => !Object.hasOwn(payload, key)) ||
    Buffer.byteLength(JSON.stringify(payload), "utf8") > 16_384
  ) {
    return false;
  }
  if (recordType === "profile") {
    return (
      shortString(payload.display_name, 120) &&
      (payload.avatar_asset_id === undefined || shortString(payload.avatar_asset_id, 128)) &&
      (payload.locale === undefined || shortString(payload.locale, 32))
    );
  }
  if (recordType === "onboarding") {
    return (
      ["not_started", "in_progress", "complete"].includes(payload.status) &&
      (payload.current_step === undefined || shortString(payload.current_step, 64)) &&
      Array.isArray(payload.completed_steps) &&
      payload.completed_steps.length <= 32 &&
      payload.completed_steps.every((step) => shortString(step, 64))
    );
  }
  if (recordType === "access_state") {
    return (
      ["enabled", "blocked", "review_required"].includes(payload.state) &&
      (payload.reason_code === undefined || shortString(payload.reason_code, 128)) &&
      Number.isSafeInteger(payload.last_evaluated_at_ms) &&
      payload.last_evaluated_at_ms >= 0
    );
  }
  return (
    shortString(payload.asset_id, 128) &&
    shortString(payload.report_type, 128) &&
    ["available", "pending", "unavailable"].includes(payload.storage_state) &&
    Number.isSafeInteger(payload.generated_at_ms) &&
    payload.generated_at_ms >= 0
  );
}

function validatedCompatibilityResponse(payload, recordType) {
  const exactKeys = ["payload", "record_type", "source_hash", "state", "updated_at_ms"];
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).sort().join("\0") !== exactKeys.sort().join("\0") ||
    payload.state !== "READY" ||
    payload.record_type !== recordType ||
    typeof payload.source_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.source_hash) ||
    !Number.isSafeInteger(payload.updated_at_ms) ||
    payload.updated_at_ms < 1 ||
    !validateCompatibilityPayload(recordType, payload.payload)
  ) {
    throw new GatewayError(
      502,
      "UPSTREAM_UNAVAILABLE",
      "Research service returned an invalid response.",
    );
  }
  return {
    state: "READY",
    record_type: recordType,
    payload: payload.payload,
    source_hash: payload.source_hash,
    updated_at_ms: payload.updated_at_ms,
  };
}

export function createHushhResearchHandler({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  randomBytesImpl = randomBytes,
  verifyFirebase = verifyHushhResearchFirebaseToken,
  replayStore,
  launchReplayCache = new Map(),
} = {}) {
  const exportReplayStore =
    replayStore ?? createHushhResearchExportReplayStore({ env });

  async function authenticate(req, config) {
    const idToken = readFirebaseBearer(req);
    const actor = await verifyFirebase(idToken, config, { fetchImpl, now });
    if (!config.allowlistedUids.includes(actor.uid)) {
      throw new GatewayError(
        404,
        "FEATURE_DISABLED",
        "Research access is not enabled.",
      );
    }
    return actor;
  }

  async function consentStatus(config, actor, { scope, requestId }) {
    const query = new URLSearchParams({ user_id: actor.uid });
    if (scope) query.set("scope", scope);
    if (requestId) query.set("request_id", requestId);
    const result = await requestResearch(
      config,
      `/api/v1/consent-status?${query.toString()}`,
      { method: "GET", headers: developerHeaders(config) },
      { fetchImpl },
    );
    const payload = requireSuccessful(result);
    if (
      payload.user_id !== actor.uid ||
      payload.app_id !== config.developerAppId
    ) {
      throw invalidUpstreamResponse();
    }
    return payload;
  }

  return async function hushhResearchHandler(req, res) {
    const path = requestPath(req);
    try {
      if (path === "/api/hushh-research/config") {
        requireMethod(req, "GET");
        return sendJson(res, 200, publicHushhResearchConfig(env));
      }

      const config = readHushhResearchServerConfig(env);
      if (!config) {
        throw new GatewayError(
          404,
          "FEATURE_DISABLED",
          "Research access is not enabled.",
        );
      }

      if (path === "/api/hushh-research/launch/start") {
        requireMethod(req, "POST");
        const body = requireRecord(req.body);
        if (
          Object.keys(body).length !== 1 ||
          body.source !== "hushh-research"
        ) {
          throw new GatewayError(400, "INVALID_REQUEST", "Launch source is invalid.");
        }
        const launch = createLaunchCookie(config, now, randomBytesImpl);
        setLaunchCookie(res, launch.value);
        return sendJson(res, 200, {
          launch_url: buildResearchLaunchUrl(config, launch.payload),
          expires_in: LAUNCH_TTL_SECONDS,
        });
      }

      if (path === "/api/hushh-research/launch/exchange") {
        requireMethod(req, "POST");
        clearLaunchCookie(res);
        const body = requireRecord(req.body);
        const code = requiredString(body, "code", { min: 20, max: 256 });
        const state = requiredString(body, "state", { min: 20, max: 256 });
        if (requiredString(body, "source", { min: 1, max: 64 }) !== "hushh-research") {
          throw new GatewayError(400, "INVALID_REQUEST", "Launch source is invalid.");
        }
        const launch = verifyLaunchCookie(req, config, state, now);
        consumeLaunchCookieOnce(launchReplayCache, launch, now());
        const result = await requestResearch(
          config,
          "/api/v1/products/hushh-tech/launch/exchange",
          {
            method: "POST",
            body: JSON.stringify({
              code,
              verifier: launch.verifier,
              audience: config.audience,
              redirect_uri: config.redirectUri,
            }),
          },
          { fetchImpl },
        );
        const payload = requireSuccessful(result);
        if (
          typeof payload.firebase_custom_token !== "string" ||
          !payload.firebase_custom_token ||
          !Number.isSafeInteger(payload.expires_in) ||
          payload.expires_in < 1 ||
          payload.audience !== config.audience ||
          typeof payload.canonical_user_id !== "string" ||
          !["READY", "LINK_REQUIRED"].includes(payload.state)
        ) {
          throw new GatewayError(
            502,
            "UPSTREAM_UNAVAILABLE",
            "Research service returned an invalid response.",
          );
        }
        if (!config.allowlistedUids.includes(payload.canonical_user_id)) {
          throw new GatewayError(
            404,
            "FEATURE_DISABLED",
            "Research access is not enabled.",
          );
        }
        return sendJson(res, 200, {
          firebase_custom_token: payload.firebase_custom_token,
          expires_in: payload.expires_in,
          canonical_user_id: payload.canonical_user_id,
          audience: payload.audience,
          state,
          link_state: payload.state,
        });
      }

      const actor = await authenticate(req, config);

      if (path === "/api/hushh-research/link/status") {
        requireMethod(req, "GET");
        const result = await requestResearch(
          config,
          "/api/v1/products/hushh-tech/link/status",
          { method: "GET", headers: productHeaders(config, actor.idToken) },
          { fetchImpl },
        );
        return sendJson(
          res,
          200,
          projectLinkStatus(requireSuccessful(result)),
        );
      }

      if (path === "/api/hushh-research/link/verify") {
        requireMethod(req, "POST");
        const body = requireRecord(req.body);
        if (Object.keys(body).length !== 0) {
          throw new GatewayError(
            400,
            "INVALID_REQUEST",
            "Link proof is server-owned.",
          );
        }
        const legacySessionProof = createHushhResearchSyntheticProof({
          uid: actor.uid,
          appId: config.developerAppId,
          audience: config.audience,
          developerToken: config.developerToken,
          now,
          randomBytesImpl,
        });
        if (!legacySessionProof) {
          throw new GatewayError(
            404,
            "FEATURE_DISABLED",
            "Synthetic linking is not enabled for this user.",
          );
        }
        const result = await requestResearch(
          config,
          "/api/v1/products/hushh-tech/link/verify",
          {
            method: "POST",
            headers: productHeaders(config, actor.idToken),
            body: JSON.stringify({ legacy_session_proof: legacySessionProof }),
          },
          { fetchImpl },
        );
        return sendJson(
          res,
          200,
          projectLinkVerification(requireSuccessful(result)),
        );
      }

      if (path === "/api/hushh-research/link/revoke") {
        requireMethod(req, "POST");
        const result = await requestResearch(
          config,
          "/api/v1/products/hushh-tech/link/revoke",
          {
            method: "POST",
            headers: productHeaders(config, actor.idToken),
            body: JSON.stringify({}),
          },
          { fetchImpl },
        );
        return sendJson(
          res,
          200,
          projectLinkRevocation(requireSuccessful(result)),
        );
      }

      if (path.startsWith("/api/hushh-research/compatibility/")) {
        requireMethod(req, "GET");
        const recordType = path.slice(
          "/api/hushh-research/compatibility/".length,
        );
        if (!COMPATIBILITY_RECORDS.has(recordType)) {
          throw new GatewayError(
            404,
            "FEATURE_DISABLED",
            "This Research record is not enabled.",
          );
        }
        const result = await requestResearch(
          config,
          `/api/v1/products/hushh-tech/compatibility/${recordType}`,
          { method: "GET", headers: productHeaders(config, actor.idToken) },
          { fetchImpl },
        );
        const payload = requireSuccessful(result);
        return sendJson(
          res,
          200,
          validatedCompatibilityResponse(payload, recordType),
        );
      }

      if (path === "/api/hushh-research/consent/request") {
        requireMethod(req, "POST");
        const body = requireRecord(req.body);
        rejectClientIdentity(body);
        const scope = requiredString(body, "scope", { min: 1, max: 200 });
        if (scope !== CONSENT_SCOPE) {
          throw new GatewayError(
            404,
            "FEATURE_DISABLED",
            "This Research scope is not enabled.",
          );
        }
        const reason = optionalString(body, "reason", 1000);
        const expiryHours = body.expiry_hours ?? 24;
        const approvalTimeoutMinutes = body.approval_timeout_minutes ?? 1440;
        const refreshPolicy = body.refresh_policy ?? "snapshot";
        if (
          !Number.isSafeInteger(expiryHours) ||
          expiryHours < 24 ||
          expiryHours > 2160 ||
          !Number.isSafeInteger(approvalTimeoutMinutes) ||
          approvalTimeoutMinutes < 5 ||
          approvalTimeoutMinutes > 1440 ||
          !["snapshot", "continuous_until_expiry"].includes(refreshPolicy)
        ) {
          throw new GatewayError(400, "INVALID_REQUEST", "Request is incomplete.");
        }
        const result = await requestResearch(
          config,
          "/api/v1/request-consent",
          {
            method: "POST",
            headers: developerHeaders(config),
            body: JSON.stringify({
              user_id: actor.uid,
              scope,
              ...(reason ? { reason } : {}),
              expiry_hours: expiryHours,
              approval_timeout_minutes: approvalTimeoutMinutes,
              refresh_policy: refreshPolicy,
            }),
          },
          { fetchImpl },
        );
        const payload = requireSuccessful(result);
        if (payload.app_id !== config.developerAppId) {
          throw invalidUpstreamResponse();
        }
        return sendJson(
          res,
          200,
          projectConsentResponse(payload, { expectedScope: scope }),
        );
      }

      if (path === "/api/hushh-research/consent/status") {
        requireMethod(req, "GET");
        const scope = optionalString(req.query ?? {}, "scope", 200);
        const requestId = optionalString(req.query ?? {}, "request_id", 200);
        if (!scope && !requestId) {
          throw new GatewayError(400, "INVALID_REQUEST", "Request is incomplete.");
        }
        if (requestId && !REQUEST_ID_PATTERN.test(requestId)) {
          throw new GatewayError(400, "INVALID_REQUEST", "Request is incomplete.");
        }
        if (scope && scope !== CONSENT_SCOPE) {
          throw new GatewayError(
            404,
            "FEATURE_DISABLED",
            "This Research scope is not enabled.",
          );
        }
        const payload = await consentStatus(config, actor, { scope, requestId });
        return sendJson(
          res,
          200,
          projectConsentResponse(payload, {
            expectedRequestId: requestId,
            expectedScope: scope,
          }),
        );
      }

      if (path === "/api/hushh-research/export/decrypt") {
        requireMethod(req, "POST");
        const body = requireRecord(req.body);
        rejectClientIdentity(body);
        const scope = requiredString(body, "scope", { min: 1, max: 200 });
        if (scope !== CONSENT_SCOPE) {
          throw new GatewayError(
            404,
            "FEATURE_DISABLED",
            "This Research scope is not enabled.",
          );
        }
        const requestId = optionalString(body, "request_id", 200);
        if (requestId && !REQUEST_ID_PATTERN.test(requestId)) {
          throw new GatewayError(400, "INVALID_REQUEST", "Request is incomplete.");
        }
        const statusPayload = await consentStatus(config, actor, {
          scope,
          requestId,
        });
        projectConsentResponse(statusPayload, {
          expectedRequestId: requestId,
          expectedScope: scope,
        });
        if (
          String(statusPayload.status ?? "").toLowerCase() !== "granted" ||
          typeof statusPayload.consent_token !== "string" ||
          !statusPayload.consent_token
        ) {
          throw new GatewayError(
            409,
            "CONSENT_REQUIRED",
            "Consent is required.",
          );
        }
        const exportResult = await requestResearch(
          config,
          "/api/v1/scoped-export",
          {
            method: "POST",
            headers: developerHeaders(config),
            body: JSON.stringify({
              user_id: actor.uid,
              consent_token: statusPayload.consent_token,
              expected_scope: scope,
            }),
          },
          { fetchImpl },
        );
        const scopedExport = requireSuccessful(exportResult);
        assertDeveloperBinding(scopedExport, actor.uid, config);
        const decrypted = decryptHushhResearchExport(
          scopedExport,
          config,
          { uid: actor.uid, scope },
          { now },
        );
        await exportReplayStore.consume(
          JSON.stringify([
            actor.uid,
            decrypted.exportId,
            decrypted.revision,
            scopedExport.export_envelope.ciphertext_sha256,
          ]),
          decrypted.expiresAt,
          now(),
        );
        return sendJson(res, 200, {
          state: "READY",
          data: decrypted.data,
          export: {
            id: decrypted.exportId,
            revision: decrypted.revision,
            scope: decrypted.scope,
            expiresAt: decrypted.expiresAt,
          },
        });
      }

      throw new GatewayError(404, "FEATURE_DISABLED", "Route not found.");
    } catch (error) {
      if (error instanceof HushhResearchAuthError) {
        return sendTypedError(
          res,
          error.statusCode,
          error.state,
          error.message,
        );
      }
      if (error instanceof HushhResearchCryptoError) {
        const replay = error.code === "export_replay_detected";
        return sendTypedError(
          res,
          replay ? 409 : 502,
          replay ? "STALE_SHADOW" : "UPSTREAM_UNAVAILABLE",
          replay
            ? "This Research export was already used."
            : "Encrypted Research data could not be verified.",
        );
      }
      if (error instanceof HushhResearchReplayStoreError) {
        const replay = error.code === "export_replay_detected";
        return sendTypedError(
          res,
          replay ? 409 : 502,
          replay ? "STALE_SHADOW" : "UPSTREAM_UNAVAILABLE",
          replay
            ? "This Research export was already used."
            : "Research service unavailable.",
        );
      }
      if (error instanceof GatewayError) {
        return sendTypedError(
          res,
          error.statusCode,
          error.state,
          error.message,
        );
      }
      return sendTypedError(
        res,
        500,
        "UPSTREAM_UNAVAILABLE",
        "Research service unavailable.",
      );
    }
  };
}

export default createHushhResearchHandler();
