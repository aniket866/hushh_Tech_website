import { google } from "googleapis";

import { createGcpServerClient } from "../shared/gcpServerClient.js";

const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_MIN_DIMENSION_COUNT = 5;
const DEFAULT_GCP_REGION = "us-central1";
const DEFAULT_CLOUD_RUN_SERVICES = ["hushh-tech-website"];
const DEFAULT_SEARCH_CONSOLE_ROW_LIMIT = 25;
const DEFAULT_SEARCH_CONSOLE_TYPE = "web";
const DEFAULT_SEARCH_CONSOLE_DATA_STATE = "all";
const SEARCH_CONSOLE_LOW_RISK_MIN_IMPRESSIONS = 100;
const SEARCH_CONSOLE_PAGE_MIN_CLICKS = 10;
const SEARCH_CONSOLE_PAGE_MIN_IMPRESSIONS = 100;
const SEARCH_CONSOLE_QUERY_MIN_CLICKS = 25;
const SEARCH_CONSOLE_QUERY_MIN_IMPRESSIONS = 500;

function trimEnvValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ratio(numerator, denominator) {
  if (!denominator) {
    return null;
  }

  return numerator / denominator;
}

function safeRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function isSmallPublicCount(value) {
  return value > 0 && value < PUBLIC_MIN_DIMENSION_COUNT;
}

function publicCount(value) {
  return isSmallPublicCount(value) ? null : value;
}

function publicRatio(numerator, denominator) {
  if (!denominator || isSmallPublicCount(numerator) || isSmallPublicCount(denominator)) {
    return null;
  }

  return numerator / denominator;
}

function publicRows(rows, countKey = "count") {
  return rows
    .filter((row) => !isSmallPublicCount(Number(row[countKey] || 0)))
    .map((row) => ({
      ...row,
      [countKey]: publicCount(Number(row[countKey] || 0)),
    }));
}

function incrementMap(map, key, amount = 1) {
  const normalizedKey = key || "unknown";
  map.set(normalizedKey, (map.get(normalizedKey) || 0) + amount);
}

function mapToPublicRows(map, labelKey, countKey = "count", limit = 12) {
  return publicRows(
    Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([label, count]) => ({
        [labelKey]: label,
        [countKey]: count,
      })),
    countKey
  );
}

function dedupeWarnings(warnings) {
  return Array.from(
    new Set(
      warnings
        .map((warning) => warning?.trim())
        .filter(Boolean)
    )
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDateKey(dateKey, offsetDays) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return formatDateKey(new Date(Date.UTC(year, month - 1, day + offsetDays)));
}

export function clampWindowDays(rawValue) {
  const parsed = Number.parseInt(String(rawValue ?? DEFAULT_WINDOW_DAYS), 10);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_WINDOW_DAYS;
  }

  return Math.min(Math.max(parsed, 1), 31);
}

export function getMetricsTimezone(env = process.env) {
  return trimEnvValue(env.METRICS_REPORT_TIMEZONE) || DEFAULT_TIMEZONE;
}

export function getDateKeyInTimezone(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  if (!values.year || !values.month || !values.day) {
    return null;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

export function buildRollingWindow({
  now = new Date(),
  timezone = DEFAULT_TIMEZONE,
  windowDays = DEFAULT_WINDOW_DAYS,
} = {}) {
  const resolvedWindowDays = clampWindowDays(windowDays);
  const endDateKey = getDateKeyInTimezone(now, timezone);

  if (!endDateKey) {
    throw new Error("Unable to resolve the reporting window");
  }

  const [year, month, day] = endDateKey.split("-").map(Number);
  const anchorUtc = Date.UTC(year, month - 1, day);
  const dates = [];

  for (let offset = resolvedWindowDays - 1; offset >= 0; offset -= 1) {
    dates.push(formatDateKey(new Date(anchorUtc - offset * DAY_MS)));
  }

  return {
    days: resolvedWindowDays,
    startDate: dates[0],
    endDate: dates.at(-1),
    dates,
  };
}

function createSeriesMap(dates, fields) {
  return Object.fromEntries(
    dates.map((date) => [
      date,
      {
        date,
        ...Object.fromEntries(fields.map((field) => [field, 0])),
      },
    ])
  );
}

function finalizeSeries(seriesMap, dates) {
  return dates.map((date) => seriesMap[date]);
}

function incrementSeries(seriesMap, timezone, rawDate, field) {
  if (!rawDate) {
    return;
  }

  const dateKey = getDateKeyInTimezone(rawDate, timezone);
  if (!dateKey || !seriesMap[dateKey]) {
    return;
  }

  seriesMap[dateKey][field] += 1;
}

function normalizeLookerStudioUrl(rawUrl) {
  if (!rawUrl) {
    return undefined;
  }

  try {
    const url = new URL(rawUrl);

    if (url.protocol !== "https:") {
      return undefined;
    }

    if (url.pathname.startsWith("/embed/reporting/")) {
      url.pathname = url.pathname.replace("/embed/reporting/", "/reporting/");
    }

    return url.toString();
  } catch {
    return undefined;
  }
}

function isMissingTableError(error, tableName) {
  const message = `${error?.message || ""}`.toLowerCase();
  return (
    error?.code === "42P01" ||
    error?.code === "PGRST205" ||
    message.includes(`${tableName}`.toLowerCase())
  );
}

function isMissingColumnError(error, columnName) {
  const message = `${error?.message || ""}`.toLowerCase();
  return error?.code === "42703" || message.includes(columnName.toLowerCase());
}

function buildHostnameFilter(hostnames) {
  if (!hostnames.length) {
    return undefined;
  }

  return {
    orGroup: {
      expressions: hostnames.map((hostname) => ({
        filter: {
          fieldName: "hostName",
          stringFilter: {
            matchType: "EXACT",
            value: hostname,
          },
        },
      })),
    },
  };
}

function parseAllowedHostnames(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((hostname) => hostname.trim())
    .filter(Boolean);
}

function parseCsv(rawValue, fallback = []) {
  const values = String(rawValue || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length > 0 ? values : fallback;
}

function clampRowLimit(rawValue, fallback = DEFAULT_SEARCH_CONSOLE_ROW_LIMIT) {
  const parsed = parseInteger(rawValue, fallback);
  return Math.min(Math.max(parsed, 1), 250);
}

function roundMetric(value, decimals = 2) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }

  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

function roundSearchConsoleCount(value) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  if (numericValue >= 1000) {
    return Math.round(numericValue / 100) * 100;
  }

  return Math.round(numericValue / 10) * 10;
}

function getSearchConsoleThresholds(dimension) {
  if (dimension === "query") {
    return {
      minClicks: SEARCH_CONSOLE_QUERY_MIN_CLICKS,
      minImpressions: SEARCH_CONSOLE_QUERY_MIN_IMPRESSIONS,
    };
  }

  if (dimension === "page") {
    return {
      minClicks: SEARCH_CONSOLE_PAGE_MIN_CLICKS,
      minImpressions: SEARCH_CONSOLE_PAGE_MIN_IMPRESSIONS,
    };
  }

  return {
    minClicks: 0,
    minImpressions: SEARCH_CONSOLE_LOW_RISK_MIN_IMPRESSIONS,
  };
}

function canonicalizePublicPath(pathname) {
  const path = trimEnvValue(pathname) || "/";
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

function sanitizePublicPageUrl(value) {
  const raw = trimEnvValue(value);
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    return `${url.origin}${canonicalizePublicPath(url.pathname)}`;
  } catch {
    return canonicalizePublicPath(raw.split("?")[0].split("#")[0]);
  }
}

function looksSensitiveDimensionLabel(value) {
  const text = trimEnvValue(value);
  return (
    text.length === 0 ||
    text.length > 160 ||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ||
    /\b(access|auth|bearer|code|jwt|key|oauth|password|secret|session|token)\b/i.test(text) ||
    /\b[A-Za-z0-9_-]{32,}\b/.test(text)
  );
}

function sanitizePublicDimensionLabel(value, dimension) {
  const text = trimEnvValue(value);
  if (dimension === "page") {
    return sanitizePublicPageUrl(text);
  }

  if (looksSensitiveDimensionLabel(text)) {
    return "";
  }

  if (dimension === "country" || dimension === "device") {
    return text.toUpperCase();
  }

  return text.slice(0, 120);
}

function buildWindowFetchStartIso(window) {
  return `${window.startDate}T00:00:00.000Z`;
}

function createGcpBackendAdminClient(url, serviceRoleKey) {
  return createGcpServerClient(url, serviceRoleKey);
}

function getWebsiteGcpBackendConfig(env) {
  const gcpBackendUrl =
    trimEnvValue(env.CLOUD_SQL_INSTANCE_CONNECTION_NAME) || trimEnvValue(env.CLOUD_SQL_INSTANCE_CONNECTION_NAME);
  const serviceRoleKey = trimEnvValue(env.GCP_SERVER_ACTOR_UID);
  const anonKey = trimEnvValue(env.VITE_FIREBASE_API_KEY);

  if (!gcpBackendUrl) {
    throw new Error(
      "CLOUD_SQL_INSTANCE_CONNECTION_NAME or CLOUD_SQL_INSTANCE_CONNECTION_NAME is required for business metrics"
    );
  }

  if (serviceRoleKey) {
    return {
      url: gcpBackendUrl,
      apiKey: serviceRoleKey,
      accessLevel: "service_role",
    };
  }

  if (anonKey) {
    return {
      url: gcpBackendUrl,
      apiKey: anonKey,
      accessLevel: "anon",
    };
  }

  throw new Error(
    "GCP_SERVER_ACTOR_UID is missing and no VITE_FIREBASE_API_KEY fallback is available"
  );
}

function getLegacyGcpBackendConfig(env) {
  const url = trimEnvValue(env.CLOUD_SQL_INSTANCE_CONNECTION_NAME);
  const serviceRoleKey =
    trimEnvValue(env.LEGACY_GCP_SERVER_ACTOR_UID) ||
    trimEnvValue(env.GCP_SERVER_ACTOR_UID);

  if (!url || !serviceRoleKey) {
    return null;
  }

  return {
    url,
    serviceRoleKey,
  };
}

async function listAuthUsersInWindow(client, window, timezone) {
  const rows = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const response = await client.auth.admin.listUsers({
      page,
      perPage,
    });

    if (response.error) {
      throw new Error(`Failed to list website auth users: ${response.error.message}`);
    }

    const users = response.data?.users || [];

    for (const user of users) {
      const dateKey = getDateKeyInTimezone(user.created_at, timezone);
      if (dateKey && dateKey >= window.startDate && dateKey <= window.endDate) {
        rows.push({
          id: user.id,
          created_at: user.created_at,
          email: user.email || null,
        });
      }
    }

    if (users.length < perPage) {
      break;
    }

    page += 1;
  }

  return rows;
}

async function fetchWebsiteUsers(client, window) {
  const response = await client
    .from("users")
    .select("id, created_at, onboarding_step")
    .gte("created_at", buildWindowFetchStartIso(window));

  if (response.error) {
    throw new Error(`Failed to read public.users: ${response.error.message}`);
  }

  return response.data || [];
}

async function fetchOnboardingRows(client, window, warnings) {
  const primary = await client
    .from("onboarding_data")
    .select("id, created_at, is_completed, completed_at")
    .gte("created_at", buildWindowFetchStartIso(window));

  if (!primary.error) {
    return primary.data || [];
  }

  if (!isMissingColumnError(primary.error, "completed_at")) {
    throw new Error(`Failed to read onboarding_data: ${primary.error.message}`);
  }

  warnings.push(
    "Live schema drift: onboarding_data.completed_at is missing, so completed onboarding is bucketed by row creation date."
  );

  const fallback = await client
    .from("onboarding_data")
    .select("id, created_at, is_completed")
    .gte("created_at", buildWindowFetchStartIso(window));

  if (fallback.error) {
    throw new Error(`Failed to read onboarding_data: ${fallback.error.message}`);
  }

  return fallback.data || [];
}

async function fetchInvestorProfiles(client, window, warnings) {
  const primary = await client
    .from("investor_profiles")
    .select("id, created_at, user_confirmed, confirmed_at")
    .gte("created_at", buildWindowFetchStartIso(window));

  if (!primary.error) {
    return primary.data || [];
  }

  if (!isMissingColumnError(primary.error, "confirmed_at")) {
    throw new Error(`Failed to read investor_profiles: ${primary.error.message}`);
  }

  warnings.push(
    "Live schema drift: investor_profiles.confirmed_at is missing, so confirmed profiles are bucketed by row creation date."
  );

  const fallback = await client
    .from("investor_profiles")
    .select("id, created_at, user_confirmed")
    .gte("created_at", buildWindowFetchStartIso(window));

  if (fallback.error) {
    throw new Error(`Failed to read investor_profiles: ${fallback.error.message}`);
  }

  return fallback.data || [];
}

async function runSchemaAudit(client) {
  const warnings = [];

  const hushhAiUsersCheck = await client
    .from("hushh_ai_users")
    .select("id", { head: true, count: "exact" });

  if (hushhAiUsersCheck.error && isMissingTableError(hushhAiUsersCheck.error, "hushh_ai_users")) {
    warnings.push(
      "Live schema drift: public.hushh_ai_users is not exposed in the live website schema cache, even though repo migrations reference it."
    );
  }

  const productUsageCheck = await client
    .from("user_product_usage")
    .select("first_access_at, last_access_at")
    .limit(1);

  if (productUsageCheck.error && isMissingColumnError(productUsageCheck.error, "first_access_at")) {
    warnings.push(
      "Live schema drift: public.user_product_usage is missing first_access_at / last_access_at at runtime, so product-usage APIs are not used as KPI truth."
    );
  }

  return warnings;
}

async function fetchLegacyUsers(client, window, warnings) {
  const primary = await client
    .from("users")
    .select("id, accountCreation")
    .gte("accountCreation", buildWindowFetchStartIso(window));

  if (!primary.error) {
    return {
      available: true,
      rows: (primary.data || []).map((row) => ({
        id: row.id,
        created_at: row.accountCreation,
      })),
      note:
        "Legacy external profile flow remains read-only: /user-registration posts to hushh-api and /your-profile reads hushh-api check-user.",
      warnings: [],
    };
  }

  if (!isMissingColumnError(primary.error, "accountCreation")) {
    throw new Error(`Failed to read legacy public.users: ${primary.error.message}`);
  }

  warnings.push(
    "Legacy schema drift: public.users.accountCreation is missing, so legacy metrics fell back to created_at."
  );

  const fallback = await client
    .from("users")
    .select("id, created_at")
    .gte("created_at", buildWindowFetchStartIso(window));

  if (fallback.error) {
    throw new Error(`Failed to read legacy public.users: ${fallback.error.message}`);
  }

  return {
    available: true,
    rows: fallback.data || [],
    note:
      "Legacy external profile flow remains read-only: /user-registration posts to hushh-api and /your-profile reads hushh-api check-user.",
    warnings: [],
  };
}

async function fetchTrafficMetrics(env, window, warnings) {
  const propertyId = trimEnvValue(env.GA4_PROPERTY_ID);
  const lookerStudioReportUrl = normalizeLookerStudioUrl(
    trimEnvValue(env.LOOKER_STUDIO_EMBED_URL)
  );
  const allowedHostnames = parseAllowedHostnames(env.GA4_ALLOWED_HOSTNAMES);
  const seriesMap = createSeriesMap(window.dates, [
    "activeUsers",
    "sessions",
    "screenPageViews",
    "engagedSessions",
    "newUsers",
  ]);

  if (!propertyId) {
    warnings.push(
      "GA4_PROPERTY_ID is not configured, so the traffic section is unavailable."
    );

    return {
      available: false,
      source: "ga4-data-api",
      overview: {
        active1DayUsers: 0,
        active7DayUsers: 0,
        active28DayUsers: 0,
        sessions: 0,
        engagedSessions: 0,
        screenPageViews: 0,
        newUsers: 0,
        engagementRate: null,
        averageSessionDuration: null,
        realtimeActiveUsers: null,
      },
      series: finalizeSeries(seriesMap, window.dates),
      lookerStudioReportUrl,
      note: lookerStudioReportUrl
        ? "Traffic exploration is still available in Looker Studio, but it is not the KPI source of truth."
        : "Traffic exploration is unavailable until GA4 is configured.",
    };
  }

  const auth = new google.auth.GoogleAuth({
    scopes: [ANALYTICS_SCOPE],
  });
  const analyticsdata = google.analyticsdata({
    version: "v1beta",
    auth,
  });
  const dimensionFilter = buildHostnameFilter(allowedHostnames);
  const noteParts = [];

  if (allowedHostnames.length > 0) {
    noteParts.push(
      `Traffic reports are filtered to ${allowedHostnames.join(", ")}.`
    );
  }

  if (lookerStudioReportUrl) {
    noteParts.push(
      "Looker Studio remains optional for traffic exploration and is not used for KPI totals."
    );
  }

  try {
    const [totalsResponse, seriesResponse] = await Promise.all([
      analyticsdata.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [
            {
              startDate: window.startDate,
              endDate: window.endDate,
            },
          ],
          metrics: [
            { name: "active1DayUsers" },
            { name: "active7DayUsers" },
            { name: "active28DayUsers" },
            { name: "sessions" },
            { name: "engagedSessions" },
            { name: "screenPageViews" },
            { name: "newUsers" },
            { name: "engagementRate" },
            { name: "averageSessionDuration" },
          ],
          ...(dimensionFilter ? { dimensionFilter } : {}),
        },
      }),
      analyticsdata.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [
            {
              startDate: window.startDate,
              endDate: window.endDate,
            },
          ],
          dimensions: [{ name: "date" }],
          metrics: [
            { name: "activeUsers" },
            { name: "sessions" },
            { name: "screenPageViews" },
            { name: "engagedSessions" },
            { name: "newUsers" },
          ],
          ...(dimensionFilter ? { dimensionFilter } : {}),
        },
      }),
    ]);

    const totals = totalsResponse.data.rows?.[0]?.metricValues || [];
    const overview = {
      active1DayUsers: parseNumber(totals[0]?.value),
      active7DayUsers: parseNumber(totals[1]?.value),
      active28DayUsers: parseNumber(totals[2]?.value),
      sessions: parseNumber(totals[3]?.value),
      engagedSessions: parseNumber(totals[4]?.value),
      screenPageViews: parseNumber(totals[5]?.value),
      newUsers: parseNumber(totals[6]?.value),
      engagementRate:
        totals[7]?.value == null ? null : parseNumber(totals[7]?.value, null),
      averageSessionDuration:
        totals[8]?.value == null ? null : parseNumber(totals[8]?.value, null),
      realtimeActiveUsers: null,
    };

    for (const row of seriesResponse.data.rows || []) {
      const rawDate = row.dimensionValues?.[0]?.value;

      if (!rawDate || rawDate.length !== 8) {
        continue;
      }

      const dateKey = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
      if (!seriesMap[dateKey]) {
        continue;
      }

      seriesMap[dateKey].activeUsers = parseNumber(row.metricValues?.[0]?.value);
      seriesMap[dateKey].sessions = parseNumber(row.metricValues?.[1]?.value);
      seriesMap[dateKey].screenPageViews = parseNumber(row.metricValues?.[2]?.value);
      seriesMap[dateKey].engagedSessions = parseNumber(row.metricValues?.[3]?.value);
      seriesMap[dateKey].newUsers = parseNumber(row.metricValues?.[4]?.value);
    }

    try {
      const realtimeResponse = await analyticsdata.properties.runRealtimeReport({
        property: `properties/${propertyId}`,
        requestBody: {
          metrics: [{ name: "activeUsers" }],
          minuteRanges: [
            {
              name: "last30Minutes",
              startMinutesAgo: 29,
              endMinutesAgo: 0,
            },
          ],
        },
      });

      overview.realtimeActiveUsers = parseNumber(
        realtimeResponse.data.rows?.[0]?.metricValues?.[0]?.value,
        null
      );

      if (allowedHostnames.length > 0) {
        noteParts.push(
          "Realtime traffic is property-wide because the GA4 Realtime API does not support hostname filters."
        );
      }
    } catch (error) {
      warnings.push(
        `GA realtime is unavailable and was excluded from the traffic overview: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    return {
      available: true,
      source: "ga4-data-api",
      overview,
      series: finalizeSeries(seriesMap, window.dates),
      lookerStudioReportUrl,
      note: noteParts.join(" "),
    };
  } catch (error) {
    console.error("GA traffic metrics unavailable:", error);
    warnings.push("GA traffic metrics are unavailable.");

    return {
      available: false,
      source: "ga4-data-api",
      overview: {
        active1DayUsers: 0,
        active7DayUsers: 0,
        active28DayUsers: 0,
        sessions: 0,
        engagedSessions: 0,
        screenPageViews: 0,
        newUsers: 0,
        engagementRate: null,
        averageSessionDuration: null,
        realtimeActiveUsers: null,
      },
      series: finalizeSeries(seriesMap, window.dates),
      lookerStudioReportUrl,
      note: "Google Analytics traffic is currently unavailable.",
    };
  }
}

function createEmptyRegionalTraffic(available = false, note = "GA4 region metrics are not configured for this runtime.") {
  return {
    source: "ga4-data-api",
    available,
    byRegion: [],
    note,
  };
}

async function fetchRegionalTrafficMetrics(env, window, warnings) {
  const propertyId = trimEnvValue(env.GA4_PROPERTY_ID);
  const allowedHostnames = parseAllowedHostnames(env.GA4_ALLOWED_HOSTNAMES);

  if (!propertyId) {
    return createEmptyRegionalTraffic(false, "GA4_PROPERTY_ID is not configured, so state/region metrics are unavailable.");
  }

  try {
    const auth = new google.auth.GoogleAuth({
      scopes: [ANALYTICS_SCOPE],
    });
    const analyticsdata = google.analyticsdata({
      version: "v1beta",
      auth,
    });
    const dimensionFilter = buildHostnameFilter(allowedHostnames);
    const response = await analyticsdata.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [
          {
            startDate: window.startDate,
            endDate: window.endDate,
          },
        ],
        dimensions: [{ name: "region" }],
        metrics: [{ name: "activeUsers" }, { name: "sessions" }],
        limit: "25",
        orderBys: [
          {
            metric: {
              metricName: "activeUsers",
            },
            desc: true,
          },
        ],
        ...(dimensionFilter ? { dimensionFilter } : {}),
      },
    });

    return {
      source: "ga4-data-api",
      available: true,
      byRegion: (response.data.rows || [])
        .map((row) => {
          const activeUsers = parseNumber(row.metricValues?.[0]?.value);
          const sessions = parseNumber(row.metricValues?.[1]?.value);
          const region = sanitizePublicDimensionLabel(
            row.dimensionValues?.[0]?.value,
            "region"
          );

          if (!region || isSmallPublicCount(activeUsers)) {
            return null;
          }

          return {
            state: region,
            activeUsers: publicCount(activeUsers),
            sessions: publicCount(sessions),
          };
        })
        .filter(Boolean),
      note:
        "State/region is sourced from GA4 region because Search Console Search Analytics does not expose a state dimension.",
    };
  } catch (error) {
    console.error("GA4 state/region metrics unavailable:", error);
    warnings.push("GA4 state/region metrics are unavailable.");

    return createEmptyRegionalTraffic(false, "GA4 state/region metrics are unavailable for this response.");
  }
}

function createEmptySearchPerformance(available = false, note = "Google Search Console is not configured for this runtime.") {
  return {
    source: "google-search-console",
    available,
    realtime: false,
    dataState: DEFAULT_SEARCH_CONSOLE_DATA_STATE,
    searchType: DEFAULT_SEARCH_CONSOLE_TYPE,
    overview: {
      clicks: 0,
      impressions: 0,
      ctr: null,
      averagePosition: null,
    },
    queries: [],
    pages: [],
    countries: [],
    devices: [],
    searchAppearance: [],
    state: createEmptyRegionalTraffic(),
    metadata: {},
    note,
  };
}

function buildSearchPerformanceRows(rows, dimension, labelKey) {
  const { minClicks, minImpressions } = getSearchConsoleThresholds(dimension);

  return (rows || [])
    .map((row) => {
      const rawLabel = row.keys?.[0] || "";
      const label = sanitizePublicDimensionLabel(rawLabel, dimension);
      const clicks = Math.round(parseNumber(row.clicks));
      const impressions = Math.round(parseNumber(row.impressions));

      if (!label || impressions < minImpressions || clicks < minClicks) {
        return null;
      }

      const publicClicks = clicks < PUBLIC_MIN_DIMENSION_COUNT
        ? null
        : roundSearchConsoleCount(clicks);
      const publicImpressions = roundSearchConsoleCount(impressions);

      return {
        [labelKey]: label,
        clicks: publicClicks,
        impressions: publicImpressions,
        ctr: publicClicks == null ? null : safeRatio(publicClicks, publicImpressions),
        averagePosition: roundMetric(parseNumber(row.position, null), 1),
      };
    })
    .filter(Boolean);
}

function buildSearchPerformanceReport({
  overviewRows = [],
  queryRows = [],
  pageRows = [],
  countryRows = [],
  deviceRows = [],
  searchAppearanceRows = [],
  metadata = {},
  dataState = DEFAULT_SEARCH_CONSOLE_DATA_STATE,
  searchType = DEFAULT_SEARCH_CONSOLE_TYPE,
  state = createEmptyRegionalTraffic(),
} = {}) {
  const overviewRow = overviewRows[0] || {};
  const clicks = Math.round(parseNumber(overviewRow.clicks));
  const impressions = Math.round(parseNumber(overviewRow.impressions));
  const publicClicks = roundSearchConsoleCount(clicks);
  const publicImpressions = roundSearchConsoleCount(impressions);

  return {
    source: "google-search-console",
    available: true,
    realtime: false,
    dataState,
    searchType,
    overview: {
      clicks: publicClicks,
      impressions: publicImpressions,
      ctr: safeRatio(publicClicks, publicImpressions),
      averagePosition: roundMetric(parseNumber(overviewRow.position, null), 1),
    },
    queries: buildSearchPerformanceRows(queryRows, "query", "query"),
    pages: buildSearchPerformanceRows(pageRows, "page", "pageUrl"),
    countries: buildSearchPerformanceRows(countryRows, "country", "country"),
    devices: buildSearchPerformanceRows(deviceRows, "device", "device"),
    searchAppearance: buildSearchPerformanceRows(
      searchAppearanceRows,
      "searchAppearance",
      "appearance"
    ),
    state,
    metadata,
    note:
      dataState === "final"
        ? "Search Console data is finalized daily data, not realtime clickstream data."
        : "Search Console data uses the freshest available Search Analytics data; recent rows can be incomplete and can change.",
  };
}

async function querySearchConsole(searchconsole, siteUrl, requestBody) {
  const response = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody,
  });

  return {
    rows: response.data.rows || [],
    metadata: response.data.metadata || {},
  };
}

async function fetchSearchPerformanceMetrics(env, window, regionalTraffic, warnings) {
  const siteUrl = trimEnvValue(env.SEARCH_CONSOLE_SITE_URL);
  const rowLimit = clampRowLimit(env.SEARCH_CONSOLE_ROW_LIMIT);
  const searchType = trimEnvValue(env.SEARCH_CONSOLE_TYPE) || DEFAULT_SEARCH_CONSOLE_TYPE;
  const dataState =
    trimEnvValue(env.SEARCH_CONSOLE_DATA_STATE) || DEFAULT_SEARCH_CONSOLE_DATA_STATE;

  if (!siteUrl) {
    warnings.push(
      "SEARCH_CONSOLE_SITE_URL is not configured, so Search Console performance metrics are unavailable."
    );
    return {
      ...createEmptySearchPerformance(false),
      state: regionalTraffic,
    };
  }

  const auth = new google.auth.GoogleAuth({
    scopes: [SEARCH_CONSOLE_SCOPE],
  });
  const searchconsole = google.searchconsole({
    version: "v1",
    auth,
  });
  const baseRequest = {
    startDate: window.startDate,
    endDate: window.endDate,
    type: searchType,
    dataState,
  };

  try {
    const [
      overview,
      byQuery,
      byPage,
      byCountry,
      byDevice,
      bySearchAppearance,
      byDate,
    ] = await Promise.all([
      querySearchConsole(searchconsole, siteUrl, {
        ...baseRequest,
        rowLimit: 1,
      }),
      querySearchConsole(searchconsole, siteUrl, {
        ...baseRequest,
        dimensions: ["query"],
        rowLimit,
      }),
      querySearchConsole(searchconsole, siteUrl, {
        ...baseRequest,
        dimensions: ["page"],
        rowLimit,
      }),
      querySearchConsole(searchconsole, siteUrl, {
        ...baseRequest,
        dimensions: ["country"],
        rowLimit,
      }),
      querySearchConsole(searchconsole, siteUrl, {
        ...baseRequest,
        dimensions: ["device"],
        rowLimit,
      }),
      querySearchConsole(searchconsole, siteUrl, {
        ...baseRequest,
        dimensions: ["searchAppearance"],
        rowLimit,
      }),
      querySearchConsole(searchconsole, siteUrl, {
        ...baseRequest,
        dimensions: ["date"],
        rowLimit: Math.min(window.days, 31),
      }),
    ]);

    return buildSearchPerformanceReport({
      overviewRows: overview.rows,
      queryRows: byQuery.rows,
      pageRows: byPage.rows,
      countryRows: byCountry.rows,
      deviceRows: byDevice.rows,
      searchAppearanceRows: bySearchAppearance.rows,
      metadata: byDate.metadata || overview.metadata || {},
      dataState,
      searchType,
      state: regionalTraffic,
    });
  } catch (error) {
    console.error("Search Console performance metrics unavailable:", error);
    warnings.push("Search Console performance metrics are unavailable.");

    return {
      ...createEmptySearchPerformance(false, "Search Console performance metrics are unavailable for this response."),
      dataState,
      searchType,
      state: regionalTraffic,
    };
  }
}

function createEmptySiteAnalytics(window, available = false, note = "First-party GcpBackend analytics have not started collecting data yet.") {
  return {
    available,
    source: "website-gcpBackend-site-analytics",
    audience: {
      dau: 0,
      wau: 0,
      mau: 0,
      sessions: 0,
      pageViews: 0,
      events: 0,
    },
    search: {
      totalSearches: 0,
      resultClickRate: null,
      noResultRate: null,
      bySurface: [],
    },
    activity: {
      topPages: [],
      byRouteGroup: [],
      byEvent: [],
    },
    funnels: {
      signup: [],
      onboarding: [],
      kyc: [],
      profile: [],
      chat: [],
    },
    dropoff: {
      signup: [],
      onboarding: [],
      kyc: [],
      profile: [],
      chat: [],
    },
    dataCoverage: {
      firstPartyEventsAvailable: available,
      collectedEvents: 0,
      collectedSessions: 0,
      suppressedMinimumCount: PUBLIC_MIN_DIMENSION_COUNT,
      note,
    },
  };
}

function buildFunnel(eventsByName, steps) {
  return steps.map((step, index) => {
    const count = eventsByName.get(step.eventName) || 0;
    const previousCount =
      index === 0 ? null : eventsByName.get(steps[index - 1].eventName) || 0;
    const conversionFromPrevious =
      previousCount == null ? null : publicRatio(count, previousCount);

    return {
      step: step.step,
      eventName: step.eventName,
      count: publicCount(count),
      conversionFromPrevious,
      dropoffFromPrevious:
        previousCount == null || conversionFromPrevious === null
          ? null
          : Math.max(0, 1 - conversionFromPrevious),
    };
  });
}

function buildDropoff(funnelRows) {
  return funnelRows
    .filter((row) => row.dropoffFromPrevious !== null)
    .map((row) => ({
      step: row.step,
      eventName: row.eventName,
      dropoffRate: row.dropoffFromPrevious,
      conversionRate: row.conversionFromPrevious,
    }));
}

function buildAnalyticsDateStarts(window) {
  const [year, month, day] = window.endDate.split("-").map(Number);
  const anchorUtc = Date.UTC(year, month - 1, day);

  return {
    dauStart: window.endDate,
    wauStart: formatDateKey(new Date(anchorUtc - 6 * DAY_MS)),
    mauStart: formatDateKey(new Date(anchorUtc - 29 * DAY_MS)),
  };
}

async function fetchSiteAnalyticsRows(client, window, mauStart) {
  const rows = [];
  const pageSize = 5000;
  const selectColumns =
    "event_id,event_name,occurred_at,route_path,route_group,session_key,anonymous_id_hash,user_id,search_query_hash,properties";
  const startIso = `${shiftDateKey(mauStart, -1)}T00:00:00.000Z`;
  const endIso = `${shiftDateKey(window.endDate, 1)}T23:59:59.999Z`;

  for (let offset = 0; ; offset += pageSize) {
    const response = await client
      .from("site_analytics_events")
      .select(selectColumns)
      .gte("occurred_at", startIso)
      .lte("occurred_at", endIso)
      .order("occurred_at", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (response.error) {
      return {
        data: rows,
        error: response.error,
      };
    }

    const pageRows = response.data || [];
    rows.push(...pageRows);

    if (pageRows.length < pageSize) {
      break;
    }
  }

  return {
    data: rows,
    error: null,
  };
}

async function fetchSiteAnalytics(client, window, timezone, warnings) {
  const empty = createEmptySiteAnalytics(window);
  const { dauStart, wauStart, mauStart } = buildAnalyticsDateStarts(window);
  const response = await fetchSiteAnalyticsRows(client, window, mauStart);

  if (response.error) {
    if (isMissingTableError(response.error, "site_analytics_events")) {
      warnings.push(
        "First-party site analytics tables are not available yet, so DAU/MAU/search/dropoff are using secondary or zero-value fallbacks."
      );
      return empty;
    }

    throw new Error(`Failed to read site_analytics_events: ${response.error.message}`);
  }

  const allRows = response.data || [];
  if (allRows.length === 0) {
    return empty;
  }

  const windowRows = [];
  const dauUsers = new Set();
  const wauUsers = new Set();
  const mauUsers = new Set();
  const windowSessions = new Set();
  const eventsByName = new Map();
  const routeGroups = new Map();
  const topPages = new Map();
  const searchBySurface = new Map();
  let pageViews = 0;
  let totalSearches = 0;
  let noResultSearches = 0;
  let resultClicks = 0;

  for (const row of allRows) {
    const dateKey = getDateKeyInTimezone(row.occurred_at, timezone);
    if (!dateKey) {
      continue;
    }

    const identity = row.user_id || row.anonymous_id_hash;
    if (identity && dateKey >= mauStart && dateKey <= window.endDate) {
      mauUsers.add(identity);
    }
    if (identity && dateKey >= wauStart && dateKey <= window.endDate) {
      wauUsers.add(identity);
    }
    if (identity && dateKey === dauStart) {
      dauUsers.add(identity);
    }

    if (dateKey < window.startDate || dateKey > window.endDate) {
      continue;
    }

    windowRows.push(row);
    if (row.session_key) {
      windowSessions.add(row.session_key);
    }

    incrementMap(eventsByName, row.event_name);
    incrementMap(routeGroups, row.route_group || "unknown");

    if (row.event_name === "page_view") {
      pageViews += 1;
      incrementMap(topPages, row.route_path || "/");
    }

    if (row.event_name === "community_search" || row.event_name === "kai_search_performed") {
      totalSearches += 1;
      const properties = row.properties || {};
      const resultCount = Number(properties.resultCount);
      if (Number.isFinite(resultCount) && resultCount === 0) {
        noResultSearches += 1;
      }
      incrementMap(searchBySurface, properties.surface || row.route_group || "unknown");
    }

    if (row.event_name === "community_result_clicked") {
      resultClicks += 1;
    }
  }

  const signup = buildFunnel(eventsByName, [
    { step: "Signup started", eventName: "signup_start" },
    { step: "Signup completed", eventName: "signup_completed" },
  ]);
  const onboarding = buildFunnel(eventsByName, [
    { step: "Financial link started", eventName: "financial_link_started" },
    { step: "Financial link completed", eventName: "financial_link_completed" },
    { step: "Onboarding step viewed", eventName: "onboarding_step_viewed" },
    { step: "Onboarding step completed", eventName: "onboarding_step_completed" },
  ]);
  const kyc = buildFunnel(eventsByName, [
    { step: "KYC step completed", eventName: "kyc_step_completed" },
    { step: "KYC result", eventName: "kyc_result" },
  ]);
  const profile = buildFunnel(eventsByName, [
    { step: "Profile loaded", eventName: "investor_profile_loaded" },
    { step: "Profile generated", eventName: "investor_profile_generated" },
    { step: "Profile confirmed", eventName: "investor_profile_confirmed" },
  ]);
  const chat = buildFunnel(eventsByName, [
    { step: "Chat opened", eventName: "public_chat_opened" },
    { step: "Message sent", eventName: "public_chat_message_sent" },
    { step: "Paywall shown", eventName: "chat_paywall_shown" },
    { step: "Checkout started", eventName: "chat_checkout_started" },
    { step: "Checkout completed", eventName: "chat_checkout_completed" },
  ]);

  return {
    available: true,
    source: "website-gcpBackend-site-analytics",
    audience: {
      dau: dauUsers.size,
      wau: wauUsers.size,
      mau: mauUsers.size,
      sessions: windowSessions.size,
      pageViews,
      events: windowRows.length,
    },
    search: {
      totalSearches,
      resultClickRate: publicRatio(resultClicks, totalSearches),
      noResultRate: publicRatio(noResultSearches, totalSearches),
      bySurface: mapToPublicRows(searchBySurface, "surface", "searches", 8),
    },
    activity: {
      topPages: mapToPublicRows(topPages, "path", "views", 12),
      byRouteGroup: mapToPublicRows(routeGroups, "routeGroup", "events", 12),
      byEvent: mapToPublicRows(eventsByName, "eventName", "events", 16),
    },
    funnels: {
      signup,
      onboarding,
      kyc,
      profile,
      chat,
    },
    dropoff: {
      signup: buildDropoff(signup),
      onboarding: buildDropoff(onboarding),
      kyc: buildDropoff(kyc),
      profile: buildDropoff(profile),
      chat: buildDropoff(chat),
    },
    dataCoverage: {
      firstPartyEventsAvailable: true,
      collectedEvents: allRows.length,
      collectedSessions: new Set(allRows.map((row) => row.session_key).filter(Boolean)).size,
      windowEvents: windowRows.length,
      suppressedMinimumCount: PUBLIC_MIN_DIMENSION_COUNT,
      note:
        "First-party analytics are aggregate-only. Raw events, users, IPs, tokens, prompts, and search text are not returned.",
    },
  };
}

async function countTableRows(client, table, window) {
  const totalResponse = await client
    .from(table)
    .select("id", { head: true, count: "exact" });

  if (totalResponse.error) {
    return {
      table,
      available: false,
      total: 0,
      windowCount: 0,
      error: totalResponse.error.message,
    };
  }

  const windowResponse = await client
    .from(table)
    .select("id", { head: true, count: "exact" })
    .gte("created_at", buildWindowFetchStartIso(window));

  return {
    table,
    available: !windowResponse.error,
    total: publicCount(totalResponse.count || 0),
    windowCount: windowResponse.error ? 0 : publicCount(windowResponse.count || 0),
    countsSuppressed:
      isSmallPublicCount(totalResponse.count || 0) ||
      isSmallPublicCount(windowResponse.error ? 0 : windowResponse.count || 0),
    error: windowResponse.error?.message,
  };
}

async function fetchGcpBackendStackMetrics(client, window, warnings) {
  const tables = [
    "site_analytics_events",
    "site_analytics_sessions",
    "onboarding_data",
    "investor_profiles",
    "kyc_profiles",
    "identity_verifications",
    "ceo_meeting_payments",
    "community_registrations",
    "user_product_usage",
    "public_chat_messages",
    "devices",
    "delete_requests",
    "notifications",
  ];

  const rows = await Promise.all(tables.map((table) => countTableRows(client, table, window)));
  const unavailable = rows.filter((row) => !row.available);

  for (const row of unavailable) {
    warnings.push(`GcpBackend aggregate for ${row.table} is unavailable.`);
  }

  return {
    source: "website-gcpBackend",
    tables: rows.map(({ error, ...row }) => row),
  };
}

function createEmptyGcpMetrics(available = false, note = "GCP Cloud Monitoring is not configured for this runtime.") {
  return {
    source: "gcp-cloud-monitoring",
    available,
    services: [],
    requestCount: 0,
    errorRate: null,
    p50LatencyMs: null,
    p95LatencyMs: null,
    instanceCount: null,
    uptimeAvailability: null,
    note,
  };
}

function readMonitoringValue(point) {
  const value = point?.value || {};
  if (value.int64Value != null) return Number(value.int64Value);
  if (value.doubleValue != null) return Number(value.doubleValue);
  if (value.distributionValue?.mean != null) return Number(value.distributionValue.mean);
  return 0;
}

function sumTimeSeries(timeSeries) {
  return (timeSeries || []).reduce((sum, series) => {
    return sum + (series.points || []).reduce((pointSum, point) => pointSum + readMonitoringValue(point), 0);
  }, 0);
}

function maxTimeSeries(timeSeries) {
  let maxValue = null;
  for (const series of timeSeries || []) {
    for (const point of series.points || []) {
      const value = readMonitoringValue(point);
      maxValue = maxValue == null ? value : Math.max(maxValue, value);
    }
  }
  return maxValue;
}

async function listMonitoringSeries(monitoring, projectId, filter, interval, aggregation) {
  const response = await monitoring.projects.timeSeries.list({
    name: `projects/${projectId}`,
    filter,
    "interval.startTime": interval.startTime,
    "interval.endTime": interval.endTime,
    "aggregation.alignmentPeriod": aggregation.alignmentPeriod,
    "aggregation.perSeriesAligner": aggregation.perSeriesAligner,
    "aggregation.crossSeriesReducer": aggregation.crossSeriesReducer,
  });

  return response.data.timeSeries || [];
}

async function fetchGcpMetrics(env, window, warnings) {
  const projectId =
    trimEnvValue(env.GCP_MONITORING_PROJECT_ID) ||
    trimEnvValue(env.GCP_PROJECT_ID) ||
    trimEnvValue(env.GOOGLE_CLOUD_PROJECT) ||
    trimEnvValue(env.GCLOUD_PROJECT);
  const region = trimEnvValue(env.GCP_CLOUD_RUN_REGION) || DEFAULT_GCP_REGION;
  const services = parseCsv(env.GCP_CLOUD_RUN_SERVICES, DEFAULT_CLOUD_RUN_SERVICES);

  if (!projectId) {
    warnings.push(
      "GCP_MONITORING_PROJECT_ID or GOOGLE_CLOUD_PROJECT is not configured, so Cloud Run stack metrics are unavailable."
    );
    return {
      ...createEmptyGcpMetrics(),
      services: services.map((name) => ({
        name,
        region,
        available: false,
      })),
    };
  }

  const interval = {
    startTime: `${window.startDate}T00:00:00.000Z`,
    endTime: `${window.endDate}T23:59:59.999Z`,
  };
  const countAggregation = {
    alignmentPeriod: "86400s",
    perSeriesAligner: "ALIGN_DELTA",
    crossSeriesReducer: "REDUCE_SUM",
  };
  const latencyAggregation = {
    alignmentPeriod: "86400s",
    perSeriesAligner: "ALIGN_PERCENTILE_95",
    crossSeriesReducer: "REDUCE_MAX",
  };
  const instanceAggregation = {
    alignmentPeriod: "3600s",
    perSeriesAligner: "ALIGN_MEAN",
    crossSeriesReducer: "REDUCE_MAX",
  };

  try {
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/monitoring.read"],
    });
    const monitoring = google.monitoring({
      version: "v3",
      auth,
    });
    const serviceRows = [];
    let requestCount = 0;
    let errorCount = 0;
    let p95LatencyMs = null;
    let instanceCount = null;

    for (const service of services) {
      const baseFilter =
        `resource.type="cloud_run_revision" AND ` +
        `resource.labels.service_name="${service}" AND ` +
        `resource.labels.location="${region}"`;
      const requestSeries = await listMonitoringSeries(
        monitoring,
        projectId,
        `${baseFilter} AND metric.type="run.googleapis.com/request_count"`,
        interval,
        countAggregation
      );
      const errorSeries = await listMonitoringSeries(
        monitoring,
        projectId,
        `${baseFilter} AND metric.type="run.googleapis.com/request_count" AND metric.labels.response_code_class!="2xx"`,
        interval,
        countAggregation
      );
      const latencySeries = await listMonitoringSeries(
        monitoring,
        projectId,
        `${baseFilter} AND metric.type="run.googleapis.com/request_latencies"`,
        interval,
        latencyAggregation
      );
      const instanceSeries = await listMonitoringSeries(
        monitoring,
        projectId,
        `${baseFilter} AND metric.type="run.googleapis.com/container/instance_count"`,
        interval,
        instanceAggregation
      );

      const serviceRequests = Math.round(sumTimeSeries(requestSeries));
      const serviceErrors = Math.round(sumTimeSeries(errorSeries));
      const serviceP95 = maxTimeSeries(latencySeries);
      const serviceInstances = maxTimeSeries(instanceSeries);

      requestCount += serviceRequests;
      errorCount += serviceErrors;
      p95LatencyMs = serviceP95 == null ? p95LatencyMs : Math.max(p95LatencyMs || 0, serviceP95);
      instanceCount =
        serviceInstances == null ? instanceCount : Math.max(instanceCount || 0, serviceInstances);

      serviceRows.push({
        name: service,
        region,
        available: true,
        requestCount: serviceRequests,
        errorRate: safeRatio(serviceErrors, serviceRequests),
        p95LatencyMs: serviceP95 == null ? null : Math.round(serviceP95),
        instanceCount: serviceInstances == null ? null : Math.round(serviceInstances),
      });
    }

    return {
      source: "gcp-cloud-monitoring",
      available: true,
      services: serviceRows,
      requestCount,
      errorRate: safeRatio(errorCount, requestCount),
      p50LatencyMs: null,
      p95LatencyMs: p95LatencyMs == null ? null : Math.round(p95LatencyMs),
      instanceCount: instanceCount == null ? null : Math.round(instanceCount),
      uptimeAvailability:
        requestCount > 0 ? Math.max(0, 1 - errorCount / requestCount) : null,
      note:
        "Cloud Run metrics are aggregate Monitoring API values for configured public services.",
    };
  } catch (error) {
    console.error("GCP Cloud Monitoring metrics unavailable:", error);
    warnings.push("GCP Cloud Monitoring metrics are unavailable.");

    return {
      ...createEmptyGcpMetrics(false, "Cloud Run metrics are unavailable for this response."),
      services: services.map((name) => ({
        name,
        region,
        available: false,
      })),
    };
  }
}

function createDefaultMetricsFetchers(env) {
  const websiteConfig = getWebsiteGcpBackendConfig(env);
  const websiteClient = createGcpBackendAdminClient(
    websiteConfig.url,
    websiteConfig.apiKey
  );
  const hasServiceRole = websiteConfig.accessLevel === "service_role";
  const legacyConfig = getLegacyGcpBackendConfig(env);
  const legacyClient = legacyConfig
    ? createGcpBackendAdminClient(legacyConfig.url, legacyConfig.serviceRoleKey)
    : null;

  return {
    fetchWebsiteAuthUsers: async ({ window, timezone, warnings }) => {
      if (hasServiceRole) {
        return listAuthUsersInWindow(websiteClient, window, timezone);
      }

      warnings.push(
        "GCP_SERVER_ACTOR_UID is missing in this environment, so signups are falling back to public.users instead of auth.users."
      );

      const rows = await fetchWebsiteUsers(websiteClient, window);
      return rows.map((row) => ({
        id: row.id,
        created_at: row.created_at,
        email: null,
      }));
    },
    fetchWebsiteUsers: ({ window }) => fetchWebsiteUsers(websiteClient, window),
    fetchOnboardingRows: ({ window, warnings }) => {
      if (!hasServiceRole) {
        warnings.push(
          "Protected onboarding metrics are unavailable without the GcpBackend service role, so onboarding cards are showing partial fallback data."
        );
        return [];
      }

      return fetchOnboardingRows(websiteClient, window, warnings);
    },
    fetchInvestorProfiles: ({ window, warnings }) => {
      if (!hasServiceRole) {
        warnings.push(
          "Protected investor profile metrics are unavailable without the GcpBackend service role, so profile cards are showing partial fallback data."
        );
        return [];
      }

      return fetchInvestorProfiles(websiteClient, window, warnings);
    },
    runSchemaAudit: () => {
      if (!hasServiceRole) {
        return Promise.resolve([
          "Local fallback mode is active: protected tables and schema-drift checks require the server-side GcpBackend service role.",
        ]);
      }

      return runSchemaAudit(websiteClient);
    },
    fetchLegacyUsers: async ({ window, warnings }) => {
      if (!legacyClient) {
        warnings.push(
          "Legacy metrics are unavailable until CLOUD_SQL_INSTANCE_CONNECTION_NAME and LEGACY_GCP_SERVER_ACTOR_UID are configured on this service."
        );

        return {
          available: false,
          rows: [],
          note:
            "Legacy external profile flow remains separate and read-only until legacy GcpBackend credentials are configured.",
          warnings: [],
        };
      }

      return fetchLegacyUsers(legacyClient, window, warnings);
    },
    fetchTrafficMetrics: ({ window, warnings }) =>
      fetchTrafficMetrics(env, window, warnings),
    fetchSiteAnalytics: ({ window, timezone, warnings }) => {
      if (!hasServiceRole) {
        warnings.push(
          "First-party site analytics require the server-side GcpBackend service role."
        );
        return createEmptySiteAnalytics(window);
      }

      return fetchSiteAnalytics(websiteClient, window, timezone, warnings);
    },
    fetchGcpBackendStackMetrics: ({ window, warnings }) => {
      if (!hasServiceRole) {
        warnings.push(
          "GcpBackend stack table aggregates require the server-side GcpBackend service role."
        );
        return {
          source: "website-gcpBackend",
          tables: [],
        };
      }

      return fetchGcpBackendStackMetrics(websiteClient, window, warnings);
    },
    fetchGcpMetrics: ({ window, warnings }) =>
      fetchGcpMetrics(env, window, warnings),
    fetchRegionalTraffic: ({ window, warnings }) =>
      fetchRegionalTrafficMetrics(env, window, warnings),
    fetchSearchPerformance: ({ window, regionalTraffic, warnings }) =>
      fetchSearchPerformanceMetrics(env, window, regionalTraffic, warnings),
  };
}

export async function buildMetricsSummary(options = {}) {
  const env = options.env || process.env;
  const timezone = options.timezone || getMetricsTimezone(env);
  const now = options.now ? new Date(options.now) : new Date();
  const window = buildRollingWindow({
    now,
    timezone,
    windowDays: options.windowDays,
  });
  const warnings = [];
  const fetchers = options.fetchers || createDefaultMetricsFetchers(env);

  const [
    websiteAuthUsers,
    websiteUsers,
    onboardingRows,
    investorProfiles,
    schemaWarnings,
    legacyMetrics,
    traffic,
    siteAnalytics,
    gcpBackendStack,
    gcp,
    regionalTraffic,
  ] = await Promise.all([
    fetchers.fetchWebsiteAuthUsers({ window, timezone, warnings }),
    fetchers.fetchWebsiteUsers({ window, timezone, warnings }),
    fetchers.fetchOnboardingRows({ window, timezone, warnings }),
    fetchers.fetchInvestorProfiles({ window, timezone, warnings }),
    fetchers.runSchemaAudit({ window, timezone, warnings }),
    fetchers.fetchLegacyUsers({ window, timezone, warnings }),
    fetchers.fetchTrafficMetrics({ window, timezone, warnings }),
    fetchers.fetchSiteAnalytics
      ? fetchers.fetchSiteAnalytics({ window, timezone, warnings })
      : createEmptySiteAnalytics(window),
    fetchers.fetchGcpBackendStackMetrics
      ? fetchers.fetchGcpBackendStackMetrics({ window, timezone, warnings })
      : Promise.resolve({
          source: "website-gcpBackend",
          tables: [],
        }),
    fetchers.fetchGcpMetrics
      ? fetchers.fetchGcpMetrics({ window, timezone, warnings })
      : Promise.resolve(createEmptyGcpMetrics()),
    fetchers.fetchRegionalTraffic
      ? fetchers.fetchRegionalTraffic({ window, timezone, warnings })
      : Promise.resolve(createEmptyRegionalTraffic()),
  ]);
  const searchPerformance = fetchers.fetchSearchPerformance
    ? await fetchers.fetchSearchPerformance({
        window,
        timezone,
        regionalTraffic,
        warnings,
      })
    : {
        ...createEmptySearchPerformance(),
        state: regionalTraffic,
      };

  const businessSeriesMap = createSeriesMap(window.dates, [
    "signups",
    "persistedUsers",
    "onboardingStarted",
    "onboardingCompleted",
    "profilesCreated",
    "profilesConfirmed",
  ]);
  const legacySeriesMap = createSeriesMap(window.dates, ["usersCreated"]);

  for (const row of websiteAuthUsers) {
    incrementSeries(businessSeriesMap, timezone, row.created_at, "signups");
  }

  for (const row of websiteUsers) {
    incrementSeries(businessSeriesMap, timezone, row.created_at, "persistedUsers");
  }

  for (const row of onboardingRows) {
    incrementSeries(businessSeriesMap, timezone, row.created_at, "onboardingStarted");

    if (row.is_completed) {
      incrementSeries(
        businessSeriesMap,
        timezone,
        row.completed_at || row.created_at,
        "onboardingCompleted"
      );
    }
  }

  for (const row of investorProfiles) {
    incrementSeries(businessSeriesMap, timezone, row.created_at, "profilesCreated");

    if (row.user_confirmed) {
      incrementSeries(
        businessSeriesMap,
        timezone,
        row.confirmed_at || row.created_at,
        "profilesConfirmed"
      );
    }
  }

  for (const row of legacyMetrics.rows || []) {
    incrementSeries(legacySeriesMap, timezone, row.created_at, "usersCreated");
  }

  const businessSeries = finalizeSeries(businessSeriesMap, window.dates);
  const legacySeries = finalizeSeries(legacySeriesMap, window.dates);

  const onboardingStepBreakdown = Object.entries(
    websiteUsers.reduce((accumulator, row) => {
      const step = row.onboarding_step || "unknown";
      accumulator[step] = (accumulator[step] || 0) + 1;
      return accumulator;
    }, {})
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([step, users]) => ({
      step,
      users,
    }));

  const businessOverview = businessSeries.reduce(
    (accumulator, row) => ({
      signups: accumulator.signups + row.signups,
      persistedUsers: accumulator.persistedUsers + row.persistedUsers,
      onboardingStarted: accumulator.onboardingStarted + row.onboardingStarted,
      onboardingCompleted: accumulator.onboardingCompleted + row.onboardingCompleted,
      profilesCreated: accumulator.profilesCreated + row.profilesCreated,
      profilesConfirmed: accumulator.profilesConfirmed + row.profilesConfirmed,
    }),
    {
      signups: 0,
      persistedUsers: 0,
      onboardingStarted: 0,
      onboardingCompleted: 0,
      profilesCreated: 0,
      profilesConfirmed: 0,
    }
  );

  const legacyOverview = legacySeries.reduce(
    (accumulator, row) => ({
      usersCreated: accumulator.usersCreated + row.usersCreated,
    }),
    {
      usersCreated: 0,
    }
  );

  if (businessOverview.signups !== businessOverview.persistedUsers) {
    warnings.push(
      `Website auth signups (${businessOverview.signups}) and website public.users rows (${businessOverview.persistedUsers}) diverged over the current ${window.days}-day window.`
    );
  }

  const hasFirstPartyAudience = Boolean(siteAnalytics?.audience?.events);
  const audience = {
    source: hasFirstPartyAudience
      ? "website-gcpBackend-site-analytics"
      : "ga4-data-api-fallback",
    dau: hasFirstPartyAudience
      ? siteAnalytics.audience.dau
      : traffic.overview.active1DayUsers,
    wau: hasFirstPartyAudience
      ? siteAnalytics.audience.wau
      : traffic.overview.active7DayUsers,
    mau: hasFirstPartyAudience
      ? siteAnalytics.audience.mau
      : traffic.overview.active28DayUsers,
    sessions: hasFirstPartyAudience
      ? siteAnalytics.audience.sessions
      : traffic.overview.sessions,
    pageViews: hasFirstPartyAudience
      ? siteAnalytics.audience.pageViews
      : traffic.overview.screenPageViews,
    events: siteAnalytics?.audience?.events || 0,
    note: hasFirstPartyAudience
      ? "Audience metrics are first-party GcpBackend aggregates."
      : "Audience metrics are using GA4 fallback until first-party event collection has enough data.",
  };

  return {
    generatedAt: now.toISOString(),
    timezone,
    window: {
      days: window.days,
      startDate: window.startDate,
      endDate: window.endDate,
    },
    businessFunnel: {
      source: "website-gcpBackend",
      overview: businessOverview,
      conversionRates: {
        signupToPersistedUsers: ratio(
          businessOverview.persistedUsers,
          businessOverview.signups
        ),
        signupToOnboardingStarted: ratio(
          businessOverview.onboardingStarted,
          businessOverview.signups
        ),
        onboardingCompletionRate: ratio(
          businessOverview.onboardingCompleted,
          businessOverview.onboardingStarted
        ),
        profileConfirmationRate: ratio(
          businessOverview.profilesConfirmed,
          businessOverview.profilesCreated
        ),
      },
      onboardingStepBreakdown,
      series: businessSeries,
    },
    audience,
    search: siteAnalytics.search,
    searchPerformance,
    activity: siteAnalytics.activity,
    funnels: siteAnalytics.funnels,
    dropoff: siteAnalytics.dropoff,
    traffic,
    gcp,
    systemHealth: {
      gcpBackend: gcpBackendStack,
      gcp: {
        available: gcp.available,
        servicesConfigured: gcp.services.length,
        requestCount: gcp.requestCount,
        errorRate: gcp.errorRate,
        p95LatencyMs: gcp.p95LatencyMs,
        instanceCount: gcp.instanceCount,
      },
      publicSafety: {
        rawRowsReturned: false,
        piiReturned: false,
        smallCellSuppressionMinimum: PUBLIC_MIN_DIMENSION_COUNT,
      },
    },
    legacy: {
      source: "legacy-hushh-api-gcpBackend",
      available: Boolean(legacyMetrics.available),
      overview: legacyOverview,
      series: legacySeries,
      note:
        legacyMetrics.note ||
        "Legacy external profile flow remains separate and read-only during the audit phase.",
    },
    dataCoverage: {
      ...siteAnalytics.dataCoverage,
      ga4Available: Boolean(traffic.available),
      gcpAvailable: Boolean(gcp.available),
      gcpBackendAggregateTables: gcpBackendStack.tables.length,
      searchConsoleAvailable: Boolean(searchPerformance.available),
      ga4RegionAvailable: Boolean(regionalTraffic.available),
    },
    dataQualityWarnings: dedupeWarnings([
      ...warnings,
      ...(schemaWarnings || []),
      ...(legacyMetrics.warnings || []),
    ]),
  };
}

export const __testing = {
  buildFunnel,
  buildSearchPerformanceReport,
  createGcpBackendAdminClient,
  fetchSiteAnalytics,
  fetchSearchPerformanceMetrics,
  fetchGcpBackendStackMetrics,
  publicCount,
  publicRatio,
  sanitizePublicDimensionLabel,
  sanitizePublicPageUrl,
  shiftDateKey,
};

function formatPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "n/a";
  }

  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(seconds) {
  if (typeof seconds !== "number" || Number.isNaN(seconds)) {
    return "n/a";
  }

  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;

  return `${minutes}m ${remainingSeconds}s`;
}

export function buildMetricsReportEmail(summary) {
  const business = summary.businessFunnel.overview;
  const traffic = summary.traffic.overview;
  const legacy = summary.legacy.overview;
  const businessRows = summary.businessFunnel.series
    .map(
      (row) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #ece7da;">${escapeHtml(row.date)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #ece7da;text-align:right;">${escapeHtml(row.signups)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #ece7da;text-align:right;">${escapeHtml(row.persistedUsers)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #ece7da;text-align:right;">${escapeHtml(row.onboardingStarted)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #ece7da;text-align:right;">${escapeHtml(row.onboardingCompleted)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #ece7da;text-align:right;">${escapeHtml(row.profilesCreated)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #ece7da;text-align:right;">${escapeHtml(row.profilesConfirmed)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #ece7da;text-align:right;">${escapeHtml(summary.traffic.series.find((trafficRow) => trafficRow.date === row.date)?.sessions || 0)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #ece7da;text-align:right;">${escapeHtml(summary.traffic.series.find((trafficRow) => trafficRow.date === row.date)?.activeUsers || 0)}</td>
        </tr>
      `
    )
    .join("");
  const warningItems = summary.dataQualityWarnings
    .map(
      (warning) =>
        `<li style="margin:0 0 8px;">${escapeHtml(warning)}</li>`
    )
    .join("");
  const subject = `Hushh KPI report — last ${summary.window.days} days ending ${summary.window.endDate}`;

  const html = `
    <div style="background:#f7f3e8;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#171717;">
      <div style="max-width:980px;margin:0 auto;background:#fffaf0;border:1px solid #ece7da;border-radius:24px;overflow:hidden;">
        <div style="padding:28px 32px;border-bottom:1px solid #ece7da;background:#111111;color:#ffffff;">
          <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#d0c8b7;">Hushh KPI Report</div>
          <h1 style="margin:14px 0 8px;font-size:34px;line-height:1.05;font-weight:500;">Trustworthy 7-day business funnel snapshot</h1>
          <p style="margin:0;color:#d6d0c2;font-size:15px;">${escapeHtml(
            summary.window.startDate
          )} to ${escapeHtml(summary.window.endDate)} in ${escapeHtml(
    summary.timezone
  )}. Business funnel is the primary truth source; GA traffic stays secondary.</p>
        </div>

        <div style="padding:28px 32px;">
          <h2 style="margin:0 0 14px;font-size:19px;">Business funnel totals</h2>
          <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;">
            ${[
              ["Signups", business.signups],
              ["Persisted users", business.persistedUsers],
              ["Onboarding started", business.onboardingStarted],
              ["Onboarding completed", business.onboardingCompleted],
              ["Profiles created", business.profilesCreated],
              ["Profiles confirmed", business.profilesConfirmed],
            ]
              .map(
                ([label, value]) => `
                  <div style="border:1px solid #ece7da;border-radius:18px;padding:16px 18px;background:#ffffff;">
                    <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#6d6657;">${escapeHtml(label)}</div>
                    <div style="margin-top:10px;font-size:30px;font-weight:600;color:#111111;">${escapeHtml(value)}</div>
                  </div>
                `
              )
              .join("")}
          </div>

          <h2 style="margin:28px 0 14px;font-size:19px;">Conversion rates</h2>
          <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;">
            ${[
              ["Signup → persisted", formatPercent(summary.businessFunnel.conversionRates.signupToPersistedUsers)],
              ["Signup → onboarding", formatPercent(summary.businessFunnel.conversionRates.signupToOnboardingStarted)],
              ["Onboarding completion", formatPercent(summary.businessFunnel.conversionRates.onboardingCompletionRate)],
              ["Profile confirmation", formatPercent(summary.businessFunnel.conversionRates.profileConfirmationRate)],
            ]
              .map(
                ([label, value]) => `
                  <div style="border:1px solid #ece7da;border-radius:18px;padding:16px 18px;background:#ffffff;">
                    <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#6d6657;">${escapeHtml(label)}</div>
                    <div style="margin-top:10px;font-size:24px;font-weight:600;color:#111111;">${escapeHtml(value)}</div>
                  </div>
                `
              )
              .join("")}
          </div>

          <h2 style="margin:28px 0 14px;font-size:19px;">Traffic context</h2>
          <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;">
            ${[
              ["DAU", traffic.active1DayUsers],
              ["WAU", traffic.active7DayUsers],
              ["MAU", traffic.active28DayUsers],
              ["Sessions", traffic.sessions],
              ["Page views", traffic.screenPageViews],
              ["Engagement", formatPercent(traffic.engagementRate)],
              ["New users", traffic.newUsers],
              ["Avg session", formatDuration(traffic.averageSessionDuration)],
              ["Active now", traffic.realtimeActiveUsers ?? "n/a"],
            ]
              .map(
                ([label, value]) => `
                  <div style="border:1px solid #ece7da;border-radius:18px;padding:16px 18px;background:#ffffff;">
                    <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#6d6657;">${escapeHtml(label)}</div>
                    <div style="margin-top:10px;font-size:24px;font-weight:600;color:#111111;">${escapeHtml(value)}</div>
                  </div>
                `
              )
              .join("")}
          </div>

          <h2 style="margin:28px 0 14px;font-size:19px;">Daily breakdown</h2>
          <div style="overflow:auto;border:1px solid #ece7da;border-radius:18px;">
            <table style="width:100%;border-collapse:collapse;font-size:14px;background:#ffffff;">
              <thead style="background:#f7f3e8;color:#403b31;text-transform:uppercase;font-size:11px;letter-spacing:0.12em;">
                <tr>
                  <th style="padding:12px;text-align:left;">Date</th>
                  <th style="padding:12px;text-align:right;">Signups</th>
                  <th style="padding:12px;text-align:right;">Persisted</th>
                  <th style="padding:12px;text-align:right;">Started</th>
                  <th style="padding:12px;text-align:right;">Completed</th>
                  <th style="padding:12px;text-align:right;">Profiles</th>
                  <th style="padding:12px;text-align:right;">Confirmed</th>
                  <th style="padding:12px;text-align:right;">Sessions</th>
                  <th style="padding:12px;text-align:right;">Active users</th>
                </tr>
              </thead>
              <tbody>
                ${businessRows}
              </tbody>
            </table>
          </div>

          <h2 style="margin:28px 0 14px;font-size:19px;">Legacy appendix</h2>
          <div style="border:1px solid #ece7da;border-radius:18px;padding:18px;background:#ffffff;">
            <p style="margin:0 0 8px;"><strong>Legacy users created:</strong> ${escapeHtml(
              legacy.usersCreated
            )}</p>
            <p style="margin:0;color:#5b5549;">${escapeHtml(summary.legacy.note)}</p>
          </div>

          <h2 style="margin:28px 0 14px;font-size:19px;">Data quality warnings</h2>
          ${
            warningItems
              ? `<ul style="margin:0;padding-left:20px;color:#5b5549;">${warningItems}</ul>`
              : `<p style="margin:0;color:#5b5549;">No active data quality warnings.</p>`
          }
        </div>
      </div>
    </div>
  `;

  const text = [
    subject,
    "",
    `Window: ${summary.window.startDate} to ${summary.window.endDate} (${summary.timezone})`,
    "",
    `Signups: ${business.signups}`,
    `Persisted users: ${business.persistedUsers}`,
    `Onboarding started: ${business.onboardingStarted}`,
    `Onboarding completed: ${business.onboardingCompleted}`,
    `Profiles created: ${business.profilesCreated}`,
    `Profiles confirmed: ${business.profilesConfirmed}`,
    "",
    `Traffic DAU / WAU / MAU: ${traffic.active1DayUsers} / ${traffic.active7DayUsers} / ${traffic.active28DayUsers}`,
    `Traffic sessions: ${traffic.sessions}`,
    `Traffic page views: ${traffic.screenPageViews}`,
    `Traffic new users: ${traffic.newUsers}`,
    `Traffic engagement: ${formatPercent(traffic.engagementRate)}`,
    `Traffic avg session: ${formatDuration(traffic.averageSessionDuration)}`,
    "",
    `Legacy users created: ${legacy.usersCreated}`,
    `Legacy note: ${summary.legacy.note}`,
    "",
    "Warnings:",
    ...(summary.dataQualityWarnings.length
      ? summary.dataQualityWarnings.map((warning) => `- ${warning}`)
      : ["- None"]),
  ].join("\n");

  return {
    subject,
    html,
    text,
  };
}
