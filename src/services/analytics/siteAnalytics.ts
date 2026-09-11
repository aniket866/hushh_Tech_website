import config from "../../resources/config/config";
import { isUatWebsite } from "../uatOptionalTraffic";
import {
  isHushhResearchAuthMode,
} from "../hushhResearch/firebaseAuth";
import {
  isHushhResearchAuthRoute,
} from "../hushhResearch/contracts";

const ANALYTICS_ID_KEY = "hushh_site_analytics_id";
const ANALYTICS_SESSION_KEY = "hushh_site_analytics_session_id";
const MAX_QUERY_HASH_INPUT_LENGTH = 512;

type AnalyticsProperties = Record<string, string | number | boolean | string[] | number[] | undefined | null>;

interface TrackEventOptions {
  routePath?: string;
  routeGroup?: string;
  properties?: AnalyticsProperties;
}

function getStorageValue(storage: Storage | undefined, key: string) {
  try {
    return storage?.getItem(key) || "";
  } catch {
    return "";
  }
}

function setStorageValue(storage: Storage | undefined, key: string, value: string) {
  try {
    storage?.setItem(key, value);
  } catch {
    // Analytics must never break the product path.
  }
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `analytics-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getOrCreateAnalyticsId() {
  if (typeof window === "undefined") {
    return "server";
  }

  const existing = getStorageValue(window.localStorage, ANALYTICS_ID_KEY);
  if (existing) {
    return existing;
  }

  const value = createId();
  setStorageValue(window.localStorage, ANALYTICS_ID_KEY, value);
  return value;
}

export function getOrCreateAnalyticsSessionId() {
  if (typeof window === "undefined") {
    return "server-session";
  }

  const existing = getStorageValue(window.sessionStorage, ANALYTICS_SESSION_KEY);
  if (existing) {
    return existing;
  }

  const value = createId();
  setStorageValue(window.sessionStorage, ANALYTICS_SESSION_KEY, value);
  return value;
}

export function sanitizeAnalyticsPath(pathname = "/", search = "", hash = "") {
  const rawPath = pathname || "/";
  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://hushhtech.local";

  try {
    const parsed = rawPath.startsWith("http")
      ? new URL(rawPath)
      : new URL(`${rawPath}${search}${hash}`, origin);
    return canonicalizeAnalyticsPath(parsed.pathname || "/");
  } catch {
    return canonicalizeAnalyticsPath(rawPath.split("?")[0].split("#")[0] || "/");
  }
}

export function canonicalizeAnalyticsPath(pathname = "/") {
  const rawPath = pathname || "/";
  const normalized = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;

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

export function inferRouteGroup(pathname: string) {
  const path = sanitizeAnalyticsPath(pathname);

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
  if (path.toLowerCase().startsWith("/login") || path.toLowerCase().startsWith("/signup")) return "auth";

  return path.split("/").filter(Boolean)[0] || "other";
}

function getDevice() {
  const userAgent = navigator.userAgent.toLowerCase();
  if (/mobile|iphone|android.*mobile|windows phone/i.test(userAgent)) return "mobile";
  if (/tablet|ipad|android(?!.*mobile)/i.test(userAgent)) return "tablet";
  return "desktop";
}

function getPlatform() {
  const userAgent = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(userAgent)) return "ios";
  if (/android/.test(userAgent)) return "android";
  return "web";
}

function getBrowser() {
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("edg/")) return "edge";
  if (userAgent.includes("chrome/")) return "chrome";
  if (userAgent.includes("safari/")) return "safari";
  if (userAgent.includes("firefox/")) return "firefox";
  return "unknown";
}

function getReferrerHost() {
  try {
    return document.referrer ? new URL(document.referrer).hostname : "";
  } catch {
    return "";
  }
}

function getViewportBucket() {
  const width = window.innerWidth;
  if (width < 640) return "sm";
  if (width < 1024) return "md";
  if (width < 1440) return "lg";
  return "xl";
}

async function getUtmContext() {
  const params = new URLSearchParams(window.location.search);
  const hashParam = async (name: string) => {
    const value = params.get(name);
    return value ? await sha256(value) : undefined;
  };

  return {
    utmSource: await hashParam("utm_source"),
    utmMedium: await hashParam("utm_medium"),
    utmCampaign: await hashParam("utm_campaign"),
    utmTerm: await hashParam("utm_term"),
    utmContent: await hashParam("utm_content"),
  };
}

async function buildContext() {
  return {
    device: getDevice(),
    platform: getPlatform(),
    browser: getBrowser(),
    referrerHost: getReferrerHost(),
    viewportBucket: getViewportBucket(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language,
    ...(await getUtmContext()),
  };
}

async function getAccessToken() {
  try {
    const response = await config.gcpBackendClient?.auth.getSession();
    return response?.data.session?.access_token || "";
  } catch {
    return "";
  }
}

function getCollectorCandidates() {
  const candidates = ["/api/analytics/collect"];
  // Dev-only fallbacks for when the Vite proxy is not up. Gated on `import.meta.env.DEV` and not
  // on the hostname alone: a production bundle served from 127.0.0.1 (`npm run preview`, the
  // visual-regression harness) otherwise beacons at a port nothing listens on, and every attempt
  // trips the `connect-src 'self'` CSP. Vite strips this branch from the production build.
  const isLocalhost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";

  if (import.meta.env.DEV && isLocalhost) {
    candidates.push("http://127.0.0.1:3005/api/analytics/collect");
    candidates.push("http://127.0.0.1:3000/api/analytics/collect");
  }

  return candidates;
}

async function sha256(value: string) {
  const trimmed = value.trim().slice(0, MAX_QUERY_HASH_INPUT_LENGTH);
  if (!trimmed) {
    return "";
  }

  if (typeof crypto === "undefined" || !crypto.subtle) {
    return "";
  }

  const encoded = new TextEncoder().encode(trimmed.toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getQueryLengthBucket(query: string) {
  const length = query.trim().length;
  if (length === 0) return "empty";
  if (length <= 3) return "1-3";
  if (length <= 10) return "4-10";
  if (length <= 25) return "11-25";
  if (length <= 50) return "26-50";
  return "51+";
}

export async function trackSiteEvent(eventName: string, options: TrackEventOptions = {}) {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return;
  }

  // UAT has no supported collector upsert contract. Optional telemetry must
  // not invoke it; this does not affect GA4 or durable NDA consent evidence.
  if (isUatWebsite()) return;

  const currentPath = sanitizeAnalyticsPath(window.location.pathname);
  const requestedPath = sanitizeAnalyticsPath(
    options.routePath || window.location.pathname,
  );
  if (
    isHushhResearchAuthMode() ||
    isHushhResearchAuthRoute(window.location.pathname) ||
    isHushhResearchAuthRoute(options.routePath || window.location.pathname) ||
    isHushhResearchAuthRoute(currentPath) ||
    isHushhResearchAuthRoute(requestedPath)
  ) {
    // The legacy collector persists to GcpBackend. Research sessions and the
    // launch callback must not silently write into that backend.
    return;
  }

  const routePath = requestedPath;
  const routeGroup = options.routeGroup || inferRouteGroup(routePath);
  const body = {
    anonymousId: getOrCreateAnalyticsId(),
    sessionId: getOrCreateAnalyticsSessionId(),
    context: await buildContext(),
    events: [
      {
        eventId: createId(),
        eventName,
        occurredAt: new Date().toISOString(),
        routePath,
        routeGroup,
        properties: {
          routeGroup,
          ...(options.properties || {}),
        },
      },
    ],
  };
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  for (const candidate of getCollectorCandidates()) {
    // Recheck before transport after asynchronous context/token resolution.
    if (isUatWebsite()) return;
    try {
      const response = await fetch(candidate, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        keepalive: true,
      });

      if (response.ok) {
        return;
      }
    } catch {
      // Try the next candidate in local development.
    }
  }
}

export function trackPageViewEvent(pathname: string, search = "", hash = "") {
  const routePath = sanitizeAnalyticsPath(pathname, search, hash);
  void trackSiteEvent("page_view", {
    routePath,
    routeGroup: inferRouteGroup(routePath),
  });
}

export async function trackSearchEvent(
  surface: string,
  query: string,
  resultCount: number,
  routePath = typeof window !== "undefined" ? window.location.pathname : "/"
) {
  const queryHash = await sha256(query);

  await trackSiteEvent("community_search", {
    routePath,
    routeGroup: inferRouteGroup(routePath),
    properties: {
      surface,
      resultCount: Number.isFinite(resultCount) ? resultCount : 0,
      queryHash,
      queryLengthBucket: getQueryLengthBucket(query),
    },
  });
}
