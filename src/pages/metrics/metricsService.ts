import { getMetricsClient } from "./metricsClient";
import type { SummaryPayload, WindowPayload } from "./types";

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_REPORT_TIMEZONE = "America/Los_Angeles";

function clampWindowDays(rawValue: number) {
  if (!Number.isFinite(rawValue)) {
    return DEFAULT_WINDOW_DAYS;
  }

  return Math.min(Math.max(Math.trunc(rawValue), 1), 31);
}

function getDateKeyInTimezone(value: Date | string, timezone: string) {
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

function buildWindow(
  windowDays = DEFAULT_WINDOW_DAYS,
  timezone = DEFAULT_REPORT_TIMEZONE
): WindowPayload {
  const days = clampWindowDays(windowDays);
  const endDate = getDateKeyInTimezone(new Date(), timezone);

  if (!endDate) {
    return {
      days,
      startDate: "",
      endDate: "",
      dates: [],
    };
  }

  const [year, month, day] = endDate.split("-").map(Number);
  const anchorUtc = Date.UTC(year, month - 1, day);
  const dates = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    dates.push(
      new Date(anchorUtc - offset * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10)
    );
  }

  return {
    days,
    startDate: dates[0] || "",
    endDate: dates.at(-1) || "",
    dates,
  };
}

function createEmptyTrafficSeries(window: WindowPayload) {
  return (window.dates || []).map((date) => ({
    date,
    activeUsers: 0,
    sessions: 0,
    screenPageViews: 0,
    engagedSessions: 0,
    newUsers: 0,
  }));
}

function createBusinessSeriesMap(window: WindowPayload) {
  return Object.fromEntries(
    (window.dates || []).map((date) => [
      date,
      {
        date,
        signups: 0,
        persistedUsers: 0,
        onboardingStarted: 0,
        onboardingCompleted: 0,
        profilesCreated: 0,
        profilesConfirmed: 0,
      },
    ])
  );
}

function isLikelyHtmlResponse(body: string, contentType: string | null) {
  const trimmed = body.trimStart();

  return (
    (contentType || "").includes("text/html") ||
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<html")
  );
}

async function fetchSummaryFromApi(windowDays: number) {
  const query = `window_days=${clampWindowDays(windowDays)}`;
  const candidates = [`/api/metrics/summary?${query}`];
  const isLocalhost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";

  if (isLocalhost) {
    candidates.push(`http://127.0.0.1:3005/api/metrics/summary?${query}`);
    candidates.push(`http://127.0.0.1:3000/api/metrics/summary?${query}`);
  }

  const failures: string[] = [];

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
        },
      });
      const contentType = response.headers.get("content-type");
      const body = await response.text();

      if (isLikelyHtmlResponse(body, contentType)) {
        failures.push(`${candidate} returned HTML instead of JSON.`);
        continue;
      }

      let payload: SummaryPayload | { error?: string; detail?: string };
      try {
        payload = JSON.parse(body) as SummaryPayload | {
          error?: string;
          detail?: string;
        };
      } catch {
        failures.push(`${candidate} returned a non-JSON response.`);
        continue;
      }

      if (!response.ok) {
        failures.push(
          payload.detail || payload.error || `${candidate} returned ${response.status}.`
        );
        continue;
      }

      return payload as SummaryPayload;
    } catch (error) {
      failures.push(
        error instanceof Error
          ? `${candidate}: ${error.message}`
          : `${candidate}: request failed`
      );
    }
  }

  throw new Error(
    failures[0] ||
      "Metrics summary is temporarily unavailable because no JSON metrics endpoint responded."
  );
}

async function loadPublicUsersFallback(
  windowDays: number,
  sourceError: string
): Promise<SummaryPayload | null> {
  const gcpBackend = getMetricsClient();
  const window = buildWindow(windowDays, DEFAULT_REPORT_TIMEZONE);

  if (!gcpBackend || !window.startDate || !window.endDate) {
    return null;
  }

  const response = await gcpBackend
    .from("users")
    .select("id, created_at, onboarding_step")
    .gte("created_at", `${window.startDate}T00:00:00.000Z`);

  if (response.error) {
    return null;
  }

  const seriesMap = createBusinessSeriesMap(window);
  const onboardingStepBreakdown = Object.entries(
    (response.data || []).reduce<Record<string, number>>((accumulator, row) => {
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

  for (const row of response.data || []) {
    const dateKey = getDateKeyInTimezone(
      row.created_at,
      DEFAULT_REPORT_TIMEZONE
    );
    if (!dateKey || !seriesMap[dateKey]) {
      continue;
    }

    seriesMap[dateKey].persistedUsers += 1;
  }

  const series = (window.dates || []).map((date) => seriesMap[date]);
  const totalPersistedUsers = series.reduce(
    (sum, row) => sum + row.persistedUsers,
    0
  );

  return {
    generatedAt: new Date().toISOString(),
    timezone: DEFAULT_REPORT_TIMEZONE,
    window,
    businessFunnel: {
      source: "website-gcpBackend-public-users-fallback",
      overview: {
        signups: 0,
        persistedUsers: totalPersistedUsers,
        onboardingStarted: 0,
        onboardingCompleted: 0,
        profilesCreated: 0,
        profilesConfirmed: 0,
      },
      conversionRates: {
        signupToPersistedUsers: null,
        signupToOnboardingStarted: null,
        onboardingCompletionRate: null,
        profileConfirmationRate: null,
      },
      onboardingStepBreakdown,
      series,
    },
    traffic: {
      source: "ga4-data-api",
      available: false,
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
      series: createEmptyTrafficSeries(window),
      note:
        "Traffic metrics require the server summary API. The current fallback is showing public.users only.",
    },
    legacy: {
      source: "legacy-hushh-api-gcpBackend",
      available: false,
      overview: {
        usersCreated: 0,
      },
      series: createEmptyTrafficSeries(window).map((row) => ({
        date: row.date,
        usersCreated: 0,
      })),
      note:
        "Legacy appendix is unavailable in client-side fallback mode.",
    },
    dataQualityWarnings: [
      `Summary API fallback is active: ${sourceError}`,
      "This fallback is powered by public.users only, so auth signups, onboarding, profiles, legacy, and GA traffic remain unavailable until the server summary API is reachable.",
    ],
  };
}

export async function buildMetricsSummary(windowDays = DEFAULT_WINDOW_DAYS) {
  try {
    return await fetchSummaryFromApi(windowDays);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Metrics summary is temporarily unavailable.";

    const fallback = await loadPublicUsersFallback(windowDays, message).catch(
      () => null
    );

    if (fallback) {
      return fallback;
    }

    throw new Error(message);
  }
}
