import { createHash, randomUUID } from "node:crypto";

import { createGcpServerClient } from "../shared/gcpServerClient.js";

const MAX_CONTENT_LENGTH_BYTES = 64 * 1024;
const MAX_EVENTS_PER_REQUEST = 50;
const MAX_PROPERTY_KEYS = 24;
const MAX_CONTEXT_KEYS = 16;
const MAX_STRING_LENGTH = 160;

const ALLOWED_EVENT_NAMES = new Set([
  "session_start",
  "page_view",
  "ui_interaction",
  "form_submit",
  "route_engagement",
  "client_error",
  "cta_click",
  "community_search",
  "community_filter_selected",
  "community_result_clicked",
  "signup_start",
  "signup_completed",
  "login_start",
  "login_completed",
  "financial_link_started",
  "financial_link_completed",
  "financial_link_skipped",
  "financial_link_failed",
  "onboarding_step_viewed",
  "onboarding_step_completed",
  "onboarding_step_skipped",
  "onboarding_step_error",
  "kyc_step_completed",
  "kyc_result",
  "investor_profile_loaded",
  "investor_profile_generated",
  "investor_profile_confirmed",
  "public_chat_opened",
  "public_chat_message_sent",
  "chat_paywall_shown",
  "chat_checkout_started",
  "chat_checkout_completed",
  "hushh_ai_chat_created",
  "hushh_ai_message_sent",
  "hushh_ai_response_completed",
  "kai_search_performed",
  "wallet_pass_started",
  "wallet_pass_succeeded",
  "wallet_pass_failed",
  "privacy_setting_changed",
]);

const SAFE_PROPERTY_KEYS = new Set([
  "surface",
  "source",
  "action",
  "status",
  "category",
  "element",
  "role",
  "controlType",
  "targetRoute",
  "outbound",
  "formId",
  "product",
  "step",
  "stepIndex",
  "result",
  "resultCount",
  "clickedResult",
  "queryHash",
  "queryLengthBucket",
  "durationMs",
  "errorCategory",
  "fileCount",
  "fileType",
  "amountBucket",
  "wallet",
  "authenticated",
  "variant",
  "language",
]);

const SAFE_CONTEXT_KEYS = new Set([
  "device",
  "platform",
  "browser",
  "referrerHost",
  "viewportBucket",
  "timezone",
  "locale",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmTerm",
  "utmContent",
]);

const SPOOFED_USER_KEYS = new Set(["userId", "user_id", "uid", "gcpBackendUserId"]);

function trimValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getGcpBackendConfig(env = process.env) {
  const gcpBackendUrl = trimValue(env.CLOUD_SQL_INSTANCE_CONNECTION_NAME) || trimValue(env.CLOUD_SQL_INSTANCE_CONNECTION_NAME);
  const serviceRoleKey = trimValue(env.GCP_SERVER_ACTOR_UID);

  if (!gcpBackendUrl || !serviceRoleKey) {
    throw new Error("CLOUD_SQL_INSTANCE_CONNECTION_NAME and GCP_SERVER_ACTOR_UID are required for analytics collection");
  }

  return { gcpBackendUrl, serviceRoleKey };
}

function getAnalyticsHashSalt(env = process.env) {
  const salt = trimValue(env.ANALYTICS_HASH_SALT);
  if (!salt) {
    const error = new Error("ANALYTICS_HASH_SALT is required for analytics collection");
    error.statusCode = 503;
    throw error;
  }

  return salt;
}

function createAdminClient(env = process.env) {
  const { gcpBackendUrl, serviceRoleKey } = getGcpBackendConfig(env);

  return createGcpServerClient(gcpBackendUrl, serviceRoleKey);
}

function isMissingAnalyticsTableError(error, tableName) {
  const message = `${error?.message || ""}`.toLowerCase();
  return (
    error?.code === "42P01" ||
    error?.code === "PGRST205" ||
    message.includes(`${tableName}`.toLowerCase())
  );
}

function getBearerToken(req) {
  const raw = trimValue(req.headers?.authorization || req.headers?.Authorization);
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length).trim() : "";
}

function hashValue(value, env = process.env) {
  const normalized = trimValue(value);
  if (!normalized) {
    return "";
  }

  const salt = getAnalyticsHashSalt(env);
  return createHash("sha256").update(`${salt}:${normalized}`).digest("hex");
}

function hasSpoofedUserKey(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  return Object.keys(value).some((key) => SPOOFED_USER_KEYS.has(key));
}

function sanitizeRoutePath(value) {
  const raw = trimValue(value);
  if (!raw) {
    return "/";
  }

  let pathname = "/";
  try {
    const parsed = raw.startsWith("http")
      ? new URL(raw)
      : new URL(raw, "https://hushhtech.local");
    pathname = parsed.pathname || "/";
  } catch {
    pathname = raw.split("?")[0].split("#")[0].slice(0, MAX_STRING_LENGTH) || "/";
  }

  return canonicalizeRoutePath(pathname);
}

function canonicalizeRoutePath(pathname) {
  const path = trimValue(pathname) || "/";
  const normalized = path.startsWith("/") ? path : `/${path}`;

  if (/^\/reports\/[^/]+$/i.test(normalized)) return "/reports/:id";
  if (/^\/profile\/[^/]+$/i.test(normalized)) return "/profile/:id";
  if (/^\/hushhid\/[^/]+$/i.test(normalized)) return "/hushhid/:id";
  if (/^\/investor\/[^/]+$/i.test(normalized)) return "/investor/:slug";
  if (/^\/community\/.+/i.test(normalized)) return "/community/:path";
  if (/^\/career\/.+/i.test(normalized)) return "/career/:path";

  const segments = normalized.split("/").map((segment, index) => {
    if (index === 0 || !segment) return segment;
    if (/^[0-9]+$/.test(segment)) return ":id";
    if (/^[0-9a-f]{12,}$/i.test(segment)) return ":id";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":id";
    if (segment.includes("@") || segment.length > 64) return ":value";
    return segment;
  });

  return segments.join("/") || "/";
}

function inferRouteGroup(routePath) {
  const path = sanitizeRoutePath(routePath);

  if (path === "/") return "home";
  if (path.startsWith("/community")) return "community";
  if (path.startsWith("/onboarding")) return "onboarding";
  if (path.startsWith("/kyc")) return "kyc";
  if (path.startsWith("/investor-profile") || path.startsWith("/investor/")) return "investor-profile";
  if (path.startsWith("/hushh-user-profile")) return "hushh-user-profile";
  if (path.startsWith("/hushh-ai")) return "hushh-ai";
  if (path.startsWith("/kai")) return "kai";
  if (path.startsWith("/studio")) return "studio";
  if (path.startsWith("/metrics") || path.startsWith("/metric")) return "metrics";
  if (path.startsWith("/login") || path.startsWith("/Login")) return "auth";
  if (path.startsWith("/signup") || path.startsWith("/Signup")) return "auth";

  return path.split("/").filter(Boolean)[0] || "other";
}

function sanitizeScalar(value) {
  if (typeof value === "string") {
    return value.trim().slice(0, MAX_STRING_LENGTH);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return null;
}

function sanitizeMap(value, allowlist, maxKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const sanitized = {};

  for (const [key, rawValue] of Object.entries(value)) {
    if (Object.keys(sanitized).length >= maxKeys) {
      break;
    }

    if (!allowlist.has(key)) {
      continue;
    }

    if (Array.isArray(rawValue)) {
      const values = rawValue
        .slice(0, 10)
        .map(sanitizeScalar)
        .filter((item) => item !== null);
      if (values.length > 0) {
        sanitized[key] = values;
      }
      continue;
    }

    const sanitizedValue = sanitizeScalar(rawValue);
    if (sanitizedValue !== null) {
      sanitized[key] = sanitizedValue;
    }
  }

  return sanitized;
}

function normalizeOccurredAt(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }

  const now = Date.now();
  const maxFutureMs = 5 * 60 * 1000;
  if (parsed.getTime() > now + maxFutureMs) {
    return new Date(now).toISOString();
  }

  return parsed.toISOString();
}

function getClientIp(req) {
  const forwardedFor = trimValue(req.headers?.["x-forwarded-for"]);
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  return trimValue(req.socket?.remoteAddress || req.ip);
}

async function deriveUserId(client, token) {
  if (!token) {
    return null;
  }

  const response = await client.auth.getUser(token);
  if (response.error || !response.data?.user?.id) {
    const message = response.error?.message || "Invalid GcpBackend bearer token";
    const error = new Error(message);
    error.statusCode = 401;
    throw error;
  }

  return response.data.user.id;
}

function validateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object";
  }

  if (hasSpoofedUserKey(body)) {
    return "Do not provide user identifiers in analytics payloads";
  }

  if (hasSpoofedUserKey(body.context)) {
    return "Do not provide user identifiers in analytics metadata";
  }

  if (!trimValue(body.anonymousId)) {
    return "anonymousId is required";
  }

  if (!Array.isArray(body.events) || body.events.length === 0) {
    return "events must be a non-empty array";
  }

  if (body.events.length > MAX_EVENTS_PER_REQUEST) {
    return `events cannot contain more than ${MAX_EVENTS_PER_REQUEST} items`;
  }

  for (const event of body.events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return "Each analytics event must be an object";
    }

    if (hasSpoofedUserKey(event)) {
      return "Do not provide user identifiers in analytics events";
    }

    if (!trimValue(event.eventId)) {
      return "Each analytics event requires eventId";
    }

    if (!ALLOWED_EVENT_NAMES.has(trimValue(event.eventName))) {
      return `Unsupported analytics event: ${trimValue(event.eventName) || "unknown"}`;
    }

    if (hasSpoofedUserKey(event.properties) || hasSpoofedUserKey(event.context)) {
      return "Do not provide user identifiers in analytics metadata";
    }
  }

  return null;
}

function normalizePayload(body, req, userId, env = process.env) {
  const anonymousIdHash = hashValue(body.anonymousId, env);
  const sessionKey = hashValue(body.sessionId || body.anonymousId, env);
  const now = new Date().toISOString();
  const firstEvent = body.events[0] || {};
  const firstPath = sanitizeRoutePath(firstEvent.routePath || body.routePath || "/");
  const firstRouteGroup = inferRouteGroup(firstPath);
  const context = sanitizeMap(body.context || firstEvent.context, SAFE_CONTEXT_KEYS, MAX_CONTEXT_KEYS);
  const referrerHost = trimValue(context.referrerHost);

  const sessionRow = {
    session_key: sessionKey,
    anonymous_id_hash: anonymousIdHash,
    user_id: userId,
    last_seen_at: now,
    exit_path: firstPath,
    exit_route_group: firstRouteGroup,
    entry_path: firstPath,
    entry_route_group: firstRouteGroup,
    referrer_host: referrerHost || null,
    utm: {
      source: context.utmSource,
      medium: context.utmMedium,
      campaign: context.utmCampaign,
      term: context.utmTerm,
      content: context.utmContent,
    },
    device: {
      device: context.device,
      platform: context.platform,
      browser: context.browser,
      viewportBucket: context.viewportBucket,
      timezone: context.timezone,
      locale: context.locale,
    },
    ip_hash: hashValue(getClientIp(req), env) || null,
    user_agent_hash: hashValue(req.headers?.["user-agent"], env) || null,
    updated_at: now,
  };

  const eventRows = body.events.map((event) => {
    const routePath = sanitizeRoutePath(event.routePath || body.routePath || "/");
    const properties = sanitizeMap(event.properties, SAFE_PROPERTY_KEYS, MAX_PROPERTY_KEYS);
    const eventContext = sanitizeMap(
      { ...context, ...(event.context || {}) },
      SAFE_CONTEXT_KEYS,
      MAX_CONTEXT_KEYS
    );
    const routeGroup = inferRouteGroup(routePath);

    return {
      event_id: trimValue(event.eventId).slice(0, 128),
      session_key: sessionKey,
      anonymous_id_hash: anonymousIdHash,
      user_id: userId,
      event_name: trimValue(event.eventName),
      occurred_at: normalizeOccurredAt(event.occurredAt),
      route_path: routePath,
      route_group: routeGroup,
      search_query_hash:
        typeof properties.queryHash === "string" ? properties.queryHash.slice(0, 128) : null,
      properties,
      context: eventContext,
    };
  });

  return {
    sessionRow,
    eventRows,
  };
}

async function persistAnalytics(client, sessionRow, eventRows) {
  const sessionResponse = await client
    .from("site_analytics_sessions")
    .upsert(sessionRow, {
      onConflict: "session_key",
    })
    .select("id")
    .single();

  if (sessionResponse.error) {
    if (isMissingAnalyticsTableError(sessionResponse.error, "site_analytics_sessions")) {
      return {
        accepted: 0,
        stored: false,
        reason: "analytics_tables_missing",
      };
    }

    throw new Error(`Failed to upsert analytics session: ${sessionResponse.error.message}`);
  }

  const rowsWithSession = eventRows.map((row) => ({
    ...row,
    session_id: sessionResponse.data.id,
  }));

  const eventResponse = await client
    .from("site_analytics_events")
    .upsert(rowsWithSession, {
      onConflict: "event_id",
      ignoreDuplicates: true,
    });

  if (eventResponse.error) {
    if (isMissingAnalyticsTableError(eventResponse.error, "site_analytics_events")) {
      return {
        accepted: 0,
        stored: false,
        reason: "analytics_tables_missing",
      };
    }

    throw new Error(`Failed to insert analytics events: ${eventResponse.error.message}`);
  }

  return {
    accepted: rowsWithSession.length,
    stored: true,
  };
}

export function __testables() {
  return {
    ALLOWED_EVENT_NAMES,
    canonicalizeRoutePath,
    hashValue,
    inferRouteGroup,
    sanitizeMap,
    sanitizeRoutePath,
    validateBody,
    normalizePayload,
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");

  const contentLength = Number.parseInt(String(req.headers?.["content-length"] || "0"), 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_CONTENT_LENGTH_BYTES) {
    return res.status(413).json({ error: "Analytics payload too large" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "Request body must be valid JSON" });
  }
  const validationError = validateBody(body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const client = createAdminClient();
    const userId = await deriveUserId(client, getBearerToken(req));
    const payload = normalizePayload(body, req, userId);
    const result = await persistAnalytics(client, payload.sessionRow, payload.eventRows);

    if (result.stored === false) {
      console.warn("analytics collect skipped:", result.reason);
      return res.status(202).json({
        success: false,
        accepted: result.accepted,
        stored: false,
        reason: result.reason,
        storedAt: null,
      });
    }

    return res.status(202).json({
      success: true,
      accepted: result.accepted,
      stored: true,
      storedAt: new Date().toISOString(),
    });
  } catch (error) {
    const statusCode = error?.statusCode || 503;
    console.error("analytics collect route error:", error);

    return res.status(statusCode).json({
      error:
        statusCode === 401
          ? "Unauthorized"
          : "Analytics collection unavailable",
    });
  }
}
