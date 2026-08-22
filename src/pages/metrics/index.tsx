import {
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";
import { Helmet } from "react-helmet";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import Footer from "../../components/Footer";
import HushhTechHeader from "../../components/hushh-tech-header/HushhTechHeader";
import { buildMetricsSummary } from "./metricsService";
import type { SummaryPayload, SummaryState } from "./types";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_REPORT_TIMEZONE = "America/Los_Angeles";

function formatNumber(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) {
    return "—";
  }

  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(seconds: number | null | undefined) {
  if (seconds == null || Number.isNaN(seconds)) {
    return "n/a";
  }

  const roundedSeconds = Math.round(seconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;

  return `${minutes}m ${remainingSeconds}s`;
}

function formatTimestamp(value: string | null | undefined, timezone?: string) {
  if (!value) {
    return "Unavailable";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unavailable";
  }

  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  });
}

function formatChartDate(dateKey: string) {
  const date = new Date(`${dateKey}T00:00:00Z`);

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
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

function buildFallbackWindow(
  days = DEFAULT_WINDOW_DAYS,
  timezone = DEFAULT_REPORT_TIMEZONE
) {
  const endDate = getDateKeyInTimezone(new Date(), timezone);

  if (!endDate) {
    return {
      days,
      startDate: "",
      endDate: "",
    };
  }

  const [year, month, day] = endDate.split("-").map(Number);
  const startDate = new Date(
    Date.UTC(year, month - 1, day) - (days - 1) * 24 * 60 * 60 * 1000
  )
    .toISOString()
    .slice(0, 10);

  return {
    days,
    startDate,
    endDate,
  };
}

function buildLookerStudioLink(rawUrl?: string) {
  if (!rawUrl) {
    return "";
  }

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") {
      return "";
    }

    return url.toString();
  } catch {
    return "";
  }
}

export function AnalyticsToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
      {children}
    </div>
  );
}

export function AnalyticsToolbarLink({
  className = "",
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const classes = [
    "inline-flex min-h-10 w-full items-center justify-center whitespace-nowrap",
    "rounded-full border border-black bg-black px-5 py-2 text-sm font-medium leading-none text-white",
    "transition hover:bg-transparent hover:text-black sm:w-auto",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <a
      {...props}
      className={classes}
    >
      {children}
    </a>
  );
}

export function MetricCard({
  eyebrow,
  label,
  value,
  hint,
  className = "",
}: {
  eyebrow: string;
  label: string;
  value: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={`rounded-[1.6rem] border border-gray-200 bg-white px-5 py-5 shadow-sm ${className}`.trim()}
      data-testid="metric-card"
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-gray-500">
        {eyebrow}
      </p>
      <div className="mt-4 space-y-1.5" data-testid="metric-label-value-stack">
        <p className="text-sm font-medium leading-5 text-gray-700" aria-hidden="true">
          {label}
        </p>
        <h3
          className="text-[28px] font-semibold leading-none tracking-tight text-black"
          aria-label={`${label}: ${value}`}
        >
          {value}
        </h3>
      </div>
      {hint ? (
        <p className="mt-3 text-sm leading-6 text-gray-500">{hint}</p>
      ) : null}
    </div>
  );
}

function SummaryCell({
  label,
  value,
  theme = "light",
}: {
  label: string;
  value: string;
  theme?: "light" | "dark";
}) {
  const isDark = theme === "dark";

  return (
    <div
      className={`rounded-2xl border px-4 py-3 ${
        isDark
          ? "border-white/10 bg-white/5"
          : "border-[#e8dfcb] bg-white"
      }`}
    >
      <p
        className={`text-[10px] font-semibold uppercase tracking-[0.22em] ${
          isDark ? "text-white/45" : "text-[#6b6252]"
        }`}
      >
        {label}
      </p>
      <p
        className={`mt-2 text-sm font-medium ${
          isDark ? "text-white" : "text-black"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

export function DashboardStatusBadge({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className: string;
}) {
  return (
    <span
      role="status"
      aria-label={`${label}: ${value}`}
      className={`inline-flex items-center justify-center rounded-full px-3 py-1 text-[10px] font-semibold uppercase leading-none ${className}`.trim()}
    >
      {value}
    </span>
  );
}

function SearchPerformanceList({
  title,
  rows,
  labelKey,
}: {
  title: string;
  rows: Array<Record<string, unknown>>;
  labelKey: string;
}) {
  const headingId = `analytics-filter-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-[1.4rem] border border-[#e8dfcb] bg-white px-4 py-4"
      data-testid="analytics-filter-control"
    >
      <p
        id={headingId}
        className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#244d86]"
      >
        {title}
      </p>
      <div
        aria-label={`${title} analytics filter results`}
        className="mt-3 space-y-3"
        role="list"
      >
        {rows.length > 0 ? (
          rows.slice(0, 5).map((row, index) => {
            const hasSearchMetrics = "clicks" in row || "impressions" in row;
            const primaryValue = hasSearchMetrics ? row.clicks : row.activeUsers;
            const secondaryValue = hasSearchMetrics ? row.impressions : row.sessions;

            return (
              <div
                key={`${title}-${index}`}
                className="flex items-start justify-between gap-4 border-b border-gray-100 pb-2 last:border-b-0 last:pb-0"
                role="listitem"
              >
                <p className="min-w-0 flex-1 truncate text-sm font-medium text-black">
                  {String(row[labelKey] || "Unknown")}
                </p>
                <div className="shrink-0 text-right text-xs text-gray-500">
                  <p>
                    {formatNumber(primaryValue as number | null)}{" "}
                    {hasSearchMetrics ? "clicks" : "users"}
                  </p>
                  <p>
                    {formatNumber(secondaryValue as number | null)}{" "}
                    {hasSearchMetrics ? "impressions" : "sessions"}
                  </p>
                </div>
              </div>
            );
          })
        ) : (
          <p className="text-sm leading-6 text-gray-500" role="listitem">
            No public-safe rows yet.
          </p>
        )}
      </div>
    </section>
  );
}

function FunnelStackRow({
  label,
  value,
  baseline,
  accentClassName,
}: {
  label: string;
  value: number;
  baseline: number;
  accentClassName: string;
}) {
  const ratio = baseline > 0 ? (value / baseline) * 100 : 0;
  const clampedWidth =
    value > 0 ? Math.max(10, Math.min(100, ratio)) : 0;

  return (
    <div className="rounded-[1.4rem] border border-white/10 bg-white/[0.04] px-4 py-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-white/55">
            {label}
          </p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-white">
            {formatNumber(value)}
          </p>
        </div>
        <p className="text-sm font-medium text-white/60">
          {baseline > 0 ? formatPercent(value / baseline) : "n/a"}
        </p>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full ${accentClassName}`}
          style={{ width: `${clampedWidth}%` }}
        />
      </div>
    </div>
  );
}

export default function MetricsPage() {
  const [summary, setSummary] = useState<SummaryState>({
    data: null,
    error: null,
    isLoading: true,
  });
  const buildTimestamp = useMemo(
    () => window.__HUSHH_VERSION__?.built || null,
    []
  );
  const fallbackWindow = useMemo(
    () => buildFallbackWindow(DEFAULT_WINDOW_DAYS, DEFAULT_REPORT_TIMEZONE),
    []
  );

  useEffect(() => {
    let isActive = true;

    const loadSummary = async () => {
      setSummary((current) => ({
        data: current.data,
        error: null,
        isLoading: current.data == null,
      }));

      try {
        const payload = await buildMetricsSummary(DEFAULT_WINDOW_DAYS);

        if (!isActive) return;

        setSummary({
          data: payload,
          error: null,
          isLoading: false,
        });
      } catch (error) {
        if (!isActive) return;

        setSummary((current) => ({
          data: current.data,
          error:
            error instanceof Error
              ? error.message
              : "GcpBackend metrics query failed.",
          isLoading: false,
        }));
      }
    };

    void loadSummary();
    const intervalId = window.setInterval(
      () => void loadSummary(),
      REFRESH_INTERVAL_MS
    );

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const lookerStudioLink = useMemo(
    () => buildLookerStudioLink(summary.data?.traffic.lookerStudioReportUrl),
    [summary.data?.traffic.lookerStudioReportUrl]
  );
  const isLoaded = Boolean(summary.data);
  const resolvedWindow = summary.data?.window || fallbackWindow;
  const businessSeries = summary.data?.businessFunnel.series || [];
  const trafficSeries = summary.data?.traffic.series || [];
  const warnings = summary.data?.dataQualityWarnings || [];
  const statusLabel = summary.error
    ? "Issue"
    : summary.isLoading && !isLoaded
      ? "Loading"
      : summary.data?.stale
        ? "Cached"
        : "Live";
  const businessOverview = summary.data?.businessFunnel.overview;
  const trafficOverview = summary.data?.traffic.overview;
  const audienceOverview = summary.data?.audience;
  const searchOverview = summary.data?.search;
  const searchPerformance = summary.data?.searchPerformance;
  const gcpOverview = summary.data?.gcp;
  const funnelBaseline = businessOverview?.signups || 0;
  const funnelStack = [
    {
      label: "Signups",
      value: businessOverview?.signups || 0,
      accentClassName: "bg-[#7caeff]",
    },
    {
      label: "Persisted",
      value: businessOverview?.persistedUsers || 0,
      accentClassName: "bg-[#d8b06c]",
    },
    {
      label: "Started",
      value: businessOverview?.onboardingStarted || 0,
      accentClassName: "bg-[#63c7a8]",
    },
    {
      label: "Completed",
      value: businessOverview?.onboardingCompleted || 0,
      accentClassName: "bg-[#46b88c]",
    },
    {
      label: "Confirmed",
      value: businessOverview?.profilesConfirmed || 0,
      accentClassName: "bg-white",
    },
  ];

  return (
    <>
      <Helmet>
        <title>Public KPI Dashboard | Hushh Technologies</title>
        <meta
          name="description"
          content="Public Hushh KPI dashboard with audited 7-day business funnel metrics from GcpBackend and secondary Google Analytics traffic context."
        />
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="min-h-screen bg-[#f7f3e8] text-gray-900">
        <HushhTechHeader showTicker={false} />

        <main className="mx-auto flex w-full max-w-[88rem] flex-col gap-8 px-6 pb-16 pt-6 md:px-8">
          <section className="grid gap-6 xl:grid-cols-[1.45fr_0.95fr]">
            <div className="rounded-[2rem] border border-[#e8dfcb] bg-[#fffaf0] p-6 shadow-sm md:p-8">
              <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
                <div className="max-w-2xl">
                  <div className="inline-flex items-center gap-2 rounded-full border border-[#244d86]/15 bg-[#244d86]/5 px-3 py-1">
                    <span className="relative flex h-3 w-3 items-center justify-center">
                      <span className="absolute h-1.5 w-3 rounded-full bg-[#244d86]/30 -translate-y-[3px]" />
                      <span className="absolute h-1.5 w-3 rounded-full bg-[#244d86]/55" />
                      <span className="absolute h-1.5 w-3 rounded-full bg-[#244d86] translate-y-[3px]" />
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#244d86]">
                      #HushhKPIs
                    </span>
                  </div>

                  <h1
                    className="mt-5 text-[2.5rem] font-normal leading-[0.95] tracking-tight text-black md:text-[4.25rem]"
                    style={{ fontFamily: "'Playfair Display', serif" }}
                  >
                    Team KPI board.
                  </h1>

                  <p className="mt-4 max-w-2xl text-base leading-7 text-[#5f5a4d] md:text-lg">
                    Seven days of website signup, onboarding, investor profile,
                    and traffic activity with GcpBackend driving the primary
                    numbers.
                  </p>

                  <div className="mt-6 flex flex-wrap gap-3 text-sm text-[#5f5a4d]">
                    {[
                      "Website GcpBackend primary",
                      "Last 7 days in Pacific time",
                      "Legacy API split out",
                    ].map((item) => (
                      <div
                        key={item}
                        className="rounded-full border border-[#e8dfcb] bg-white px-4 py-2"
                      >
                        {item}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:w-[22rem]">
                  <SummaryCell
                    label="Window"
                    value={
                      resolvedWindow.startDate && resolvedWindow.endDate
                        ? `${resolvedWindow.startDate} → ${resolvedWindow.endDate}`
                        : `Last ${resolvedWindow.days} days`
                    }
                  />
                  <SummaryCell label="Status" value={statusLabel} />
                  <SummaryCell
                    label="Last updated"
                    value={
                      summary.isLoading && !isLoaded
                        ? "Loading…"
                        : summary.error
                          ? "Summary unavailable"
                          : formatTimestamp(
                              summary.data?.generatedAt || null,
                              summary.data?.timezone
                            )
                    }
                  />
                  <SummaryCell
                    label="Traffic"
                    value={
                      summary.error
                        ? "Summary API issue"
                        : summary.data?.traffic.available
                          ? "GA4 available"
                          : "GA4 degraded"
                    }
                  />
                </div>
              </div>

              <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <MetricCard
                  eyebrow="Website KPI"
                  label="Raw signups"
                  value={
                    summary.isLoading && !isLoaded
                      ? "…"
                      : formatNumber(businessOverview?.signups)
                  }
                  className="bg-white/90"
                />
                <MetricCard
                  eyebrow="Website KPI"
                  label="Persisted users"
                  value={
                    summary.isLoading && !isLoaded
                      ? "…"
                      : formatNumber(businessOverview?.persistedUsers)
                  }
                  className="bg-white/90"
                />
                <MetricCard
                  eyebrow="Onboarding"
                  label="Onboarding started"
                  value={
                    summary.isLoading && !isLoaded
                      ? "…"
                      : formatNumber(businessOverview?.onboardingStarted)
                  }
                  className="bg-white/90"
                />
                <MetricCard
                  eyebrow="Onboarding"
                  label="Onboarding completed"
                  value={
                    summary.isLoading && !isLoaded
                      ? "…"
                      : formatNumber(businessOverview?.onboardingCompleted)
                  }
                  className="bg-white/90"
                />
                <MetricCard
                  eyebrow="Profiles"
                  label="Profiles created"
                  value={
                    summary.isLoading && !isLoaded
                      ? "…"
                      : formatNumber(businessOverview?.profilesCreated)
                  }
                  className="bg-white/90"
                />
                <MetricCard
                  eyebrow="Profiles"
                  label="Profiles confirmed"
                  value={
                    summary.isLoading && !isLoaded
                      ? "…"
                      : formatNumber(businessOverview?.profilesConfirmed)
                  }
                  className="bg-white/90"
                />
              </div>
            </div>

            <aside className="rounded-[2rem] border border-black bg-[#050505] p-6 text-white shadow-2xl md:p-8">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.24em] text-white/45">
                    Funnel stack
                  </p>
                  <h2
                    className="mt-2 text-3xl font-normal tracking-tight"
                    style={{ fontFamily: "'Playfair Display', serif" }}
                  >
                    From signup to confirmation
                  </h2>
                </div>
                <DashboardStatusBadge
                  label="Funnel stack status"
                  value={statusLabel}
                  className={`tracking-[0.2em] ${
                    statusLabel === "Issue"
                      ? "bg-red-400/20 text-red-200"
                      : statusLabel === "Cached"
                        ? "bg-amber-400/20 text-amber-200"
                        : statusLabel === "Loading"
                          ? "bg-white/10 text-white/70"
                          : "bg-emerald-400/15 text-emerald-200"
                  }`}
                />
              </div>

              <div className="mt-6 space-y-4">
                {funnelStack.map((item) => (
                  <FunnelStackRow
                    key={item.label}
                    label={item.label}
                    value={item.value}
                    baseline={funnelBaseline}
                    accentClassName={item.accentClassName}
                  />
                ))}
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <SummaryCell
                  label="Source"
                  value="Website GcpBackend"
                  theme="dark"
                />
                <SummaryCell
                  label="Window"
                  value={`Last ${summary.data?.window.days || 7} days`}
                  theme="dark"
                />
                <SummaryCell
                  label="Current window"
                  value={
                    resolvedWindow.startDate && resolvedWindow.endDate
                      ? `${resolvedWindow.startDate} → ${resolvedWindow.endDate}`
                      : `Last ${resolvedWindow.days} days`
                  }
                  theme="dark"
                />
                <SummaryCell
                  label="Traffic"
                  value={
                    summary.data?.traffic.available
                      ? "GA4 supporting"
                      : "GcpBackend-only primary"
                  }
                  theme="dark"
                />
              </div>

              {summary.error ? (
                <div className="mt-6 rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm leading-6 text-red-100">
                  {summary.error}
                </div>
              ) : (
                <p className="mt-6 text-sm leading-7 text-white/65">
                  The stack stays anchored to website signup and profile data,
                  with traffic metrics kept in supporting context below.
                </p>
              )}
            </aside>
          </section>

          {summary.error && !isLoaded && (
            <section className="rounded-[1.75rem] border border-red-200 bg-red-50 px-6 py-5 text-red-900 shadow-sm">
              {summary.error}
            </section>
          )}

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              eyebrow="Audience"
              label="Daily active users"
              value={formatNumber(
                audienceOverview?.dau ?? trafficOverview?.active1DayUsers
              )}
              hint={audienceOverview?.source || "GA4 fallback"}
            />
            <MetricCard
              eyebrow="Audience"
              label="Monthly active users"
              value={formatNumber(
                audienceOverview?.mau ?? trafficOverview?.active28DayUsers
              )}
              hint="Distinct public-safe visitors"
            />
            <MetricCard
              eyebrow="Search"
              label="Searches captured"
              value={formatNumber(searchOverview?.totalSearches)}
              hint={
                searchOverview?.noResultRate == null
                  ? "No search data yet"
                  : `${formatPercent(searchOverview.noResultRate)} no-result rate`
              }
            />
            <MetricCard
              eyebrow="GCP"
              label="Cloud Run requests"
              value={formatNumber(gcpOverview?.requestCount)}
              hint={
                gcpOverview?.available
                  ? `${formatPercent(gcpOverview.errorRate)} error rate`
                  : "Monitoring unavailable"
              }
            />
            <MetricCard
              eyebrow="SEO"
              label="Google Search clicks"
              value={formatNumber(searchPerformance?.overview.clicks)}
              hint={searchPerformance?.available ? "Search Console" : "Unavailable"}
            />
            <MetricCard
              eyebrow="SEO"
              label="Google impressions"
              value={formatNumber(searchPerformance?.overview.impressions)}
              hint={searchPerformance?.dataState || "Search Console"}
            />
            <MetricCard
              eyebrow="SEO"
              label="Google CTR"
              value={formatPercent(searchPerformance?.overview.ctr)}
              hint="Organic search result CTR"
            />
            <MetricCard
              eyebrow="SEO"
              label="Average position"
              value={
                searchPerformance?.overview.averagePosition == null
                  ? "—"
                  : searchPerformance.overview.averagePosition.toFixed(1)
              }
              hint={searchPerformance?.realtime ? "Realtime" : "Fresh, not realtime"}
            />
          </section>

          <section className="rounded-[2rem] border border-[#e8dfcb] bg-[#fffaf0] p-6 shadow-sm">
            <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#244d86]">
                  Search Console
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-black">
                  Organic search visibility
                </h2>
              </div>
              <p className="max-w-2xl text-sm leading-6 text-[#5f5a4d]">
                Query and page rows are public-safe top lists only. State/region
                comes from GA4 because Search Console does not expose state.
              </p>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <SearchPerformanceList
                title="Queries"
                rows={searchPerformance?.queries || []}
                labelKey="query"
              />
              <SearchPerformanceList
                title="Page URLs"
                rows={searchPerformance?.pages || []}
                labelKey="pageUrl"
              />
              <SearchPerformanceList
                title="Countries"
                rows={searchPerformance?.countries || []}
                labelKey="country"
              />
              <SearchPerformanceList
                title="Device"
                rows={searchPerformance?.devices || []}
                labelKey="device"
              />
              <SearchPerformanceList
                title="State / region"
                rows={searchPerformance?.state?.byRegion || []}
                labelKey="state"
              />
              <SearchPerformanceList
                title="Search appearance"
                rows={searchPerformance?.searchAppearance || []}
                labelKey="appearance"
              />
            </div>
          </section>

          <section className="grid gap-6 xl:grid-cols-[1.4fr_0.9fr]">
            <div className="rounded-[2rem] border border-[#e8dfcb] bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#244d86]">
                    7-Day KPI Flow
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-tight text-black">
                    Website signups, onboarding, and confirmed profiles by day
                  </h2>
                </div>
                <p className="text-sm leading-6 text-[#5f5a4d]">
                  Daily buckets are resolved in{" "}
                  <span className="font-medium text-black">
                    {summary.data?.timezone || "America/Los_Angeles"}
                  </span>
                  .
                </p>
              </div>

              <div className="mt-6 overflow-x-auto pb-2">
                <div className="h-[300px] min-w-[620px] sm:h-[340px] sm:min-w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={businessSeries} margin={{ left: 0, right: 12 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#ede6d7" />
                      <XAxis
                        dataKey="date"
                        tickFormatter={formatChartDate}
                        tick={{ fill: "#6b6252", fontSize: 12 }}
                        axisLine={{ stroke: "#e0d7c4" }}
                        tickLine={false}
                      />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fill: "#6b6252", fontSize: 12 }}
                        axisLine={{ stroke: "#e0d7c4" }}
                        tickLine={false}
                      />
                      <Tooltip
                        formatter={(value: unknown, name: unknown) => [
                          formatNumber(Number(value) || 0),
                          String(name),
                        ]}
                        labelFormatter={(label) => formatChartDate(String(label))}
                      />
                      <Legend />
                      <Bar
                        dataKey="signups"
                        name="Signups"
                        fill="#244d86"
                        radius={[8, 8, 0, 0]}
                      />
                      <Bar
                        dataKey="onboardingStarted"
                        name="Onboarding started"
                        fill="#d1a15f"
                        radius={[8, 8, 0, 0]}
                      />
                      <Line
                        type="monotone"
                        dataKey="onboardingCompleted"
                        name="Onboarding completed"
                        stroke="#0d8f6f"
                        strokeWidth={3}
                        dot={{ r: 4 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="profilesConfirmed"
                        name="Profiles confirmed"
                        stroke="#111111"
                        strokeWidth={3}
                        dot={{ r: 4 }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div className="grid gap-6">
              <div className="rounded-[2rem] border border-[#e8dfcb] bg-white p-6 shadow-sm">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#244d86]">
                  Conversion rates
                </p>
                <div className="mt-4 grid gap-3">
                  {[
                    [
                      "Signup → persisted",
                      formatPercent(
                        summary.data?.businessFunnel.conversionRates
                          .signupToPersistedUsers
                      ),
                    ],
                    [
                      "Signup → onboarding",
                      formatPercent(
                        summary.data?.businessFunnel.conversionRates
                          .signupToOnboardingStarted
                      ),
                    ],
                    [
                      "Onboarding completion",
                      formatPercent(
                        summary.data?.businessFunnel.conversionRates
                          .onboardingCompletionRate
                      ),
                    ],
                    [
                      "Profile confirmation",
                      formatPercent(
                        summary.data?.businessFunnel.conversionRates
                          .profileConfirmationRate
                      ),
                    ],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-2xl border border-[#ece4d2] bg-[#faf5ea] px-4 py-3"
                    >
                      <p className="text-sm text-[#5f5a4d]">{label}</p>
                      <p className="mt-2 text-2xl font-semibold text-black">
                        {value}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-[2rem] border border-[#e8dfcb] bg-white p-6 shadow-sm">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#244d86]">
                  Onboarding step distribution
                </p>
                <div className="mt-4 space-y-3">
                  {(summary.data?.businessFunnel.onboardingStepBreakdown || []).map(
                    (item) => (
                      <div key={item.step}>
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-medium text-black">
                            {item.step}
                          </span>
                          <span className="text-[#5f5a4d]">
                            {formatNumber(item.users)}
                          </span>
                        </div>
                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#eee6d4]">
                          <div
                            className="h-full rounded-full bg-[#244d86]"
                            style={{
                              width: `${Math.max(
                                8,
                                Math.min(
                                  100,
                                  ((item.users || 0) /
                                    Math.max(
                                      1,
                                      summary.data?.businessFunnel.overview
                                        .persistedUsers || 1
                                    )) *
                                    100
                                )
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                    )
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-[2rem] border border-[#e8dfcb] bg-[#fffaf0] p-6 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#244d86]">
                  Traffic context
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-black">
                  DAU, WAU, MAU, sessions, and engagement
                </h2>
              </div>

              {lookerStudioLink && (
                <AnalyticsToolbar>
                  <AnalyticsToolbarLink
                    href={lookerStudioLink}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Looker traffic view
                  </AnalyticsToolbarLink>
                </AnalyticsToolbar>
                )}
            </div>

            <div className="mt-6 grid gap-3 md:grid-cols-3">
              <SummaryCell
                label="Traffic source"
                value={summary.data?.traffic.source || "GA4 Data API"}
              />
              <SummaryCell
                label="Realtime"
                value={
                  isLoaded
                    ? formatNumber(trafficOverview?.realtimeActiveUsers)
                    : "…"
                }
              />
              <SummaryCell
                label="Traffic status"
                value={
                  summary.data?.traffic.available
                    ? "Supporting metrics live"
                    : "Supporting metrics degraded"
                }
              />
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <MetricCard
                eyebrow="Traffic"
                label="DAU / WAU / MAU"
                value={
                  isLoaded
                    ? `${formatNumber(
                        trafficOverview?.active1DayUsers
                      )} / ${formatNumber(
                        trafficOverview?.active7DayUsers
                      )} / ${formatNumber(
                        trafficOverview?.active28DayUsers
                      )}`
                    : "…"
                }
              />
              <MetricCard
                eyebrow="Traffic"
                label="Sessions"
                value={
                  isLoaded ? formatNumber(trafficOverview?.sessions) : "…"
                }
              />
              <MetricCard
                eyebrow="Traffic"
                label="Views"
                value={
                  isLoaded ? formatNumber(trafficOverview?.screenPageViews) : "…"
                }
              />
              <MetricCard
                eyebrow="Traffic"
                label="New users"
                value={
                  isLoaded ? formatNumber(trafficOverview?.newUsers) : "…"
                }
              />
              <MetricCard
                eyebrow="Traffic"
                label="Engagement rate"
                value={
                  isLoaded ? formatPercent(trafficOverview?.engagementRate) : "…"
                }
              />
              <MetricCard
                eyebrow="Traffic"
                label="Avg session / active now"
                value={
                  isLoaded
                    ? `${formatDuration(
                        trafficOverview?.averageSessionDuration
                      )} · ${formatNumber(
                        trafficOverview?.realtimeActiveUsers
                      )}`
                    : "…"
                }
              />
            </div>

            <div className="mt-6 rounded-[1.6rem] border border-[#e8dfcb] bg-white p-4 sm:p-5">
              <div className="overflow-x-auto pb-2">
                <div className="h-[280px] min-w-[560px] sm:h-[300px] sm:min-w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={trafficSeries} margin={{ left: 0, right: 12 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#ede6d7" />
                      <XAxis
                        dataKey="date"
                        tickFormatter={formatChartDate}
                        tick={{ fill: "#6b6252", fontSize: 12 }}
                        axisLine={{ stroke: "#e0d7c4" }}
                        tickLine={false}
                      />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fill: "#6b6252", fontSize: 12 }}
                        axisLine={{ stroke: "#e0d7c4" }}
                        tickLine={false}
                      />
                      <Tooltip
                        formatter={(value: unknown, name: unknown) => [
                          formatNumber(Number(value) || 0),
                          String(name),
                        ]}
                        labelFormatter={(label) => formatChartDate(String(label))}
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="activeUsers"
                        name="Active users"
                        stroke="#244d86"
                        strokeWidth={3}
                        dot={{ r: 3 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="sessions"
                        name="Sessions"
                        stroke="#d1a15f"
                        strokeWidth={3}
                        dot={{ r: 3 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="screenPageViews"
                        name="Views"
                        stroke="#0d8f6f"
                        strokeWidth={3}
                        dot={{ r: 3 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {summary.data?.traffic.note && (
              <p className="mt-4 text-sm leading-7 text-[#5f5a4d]">
                {summary.data.traffic.note}
              </p>
            )}
          </section>

          <section className="grid gap-6 xl:grid-cols-[1.18fr_0.82fr]">
            <div className="rounded-[2rem] border border-[#e8dfcb] bg-white p-6 shadow-sm">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#244d86]">
                Daily appendix
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-black">
                Last seven days at a glance
              </h2>

              <div className="mt-6 overflow-x-auto rounded-[1.4rem] border border-[#e8dfcb]">
                <table className="min-w-full border-collapse text-left text-sm">
                  <thead className="bg-[#faf5ea] text-[#5f5a4d]">
                    <tr>
                      {[
                        "Date",
                        "Signups",
                        "Persisted",
                        "Started",
                        "Completed",
                        "Profiles",
                        "Confirmed",
                        "Legacy",
                      ].map((label) => (
                        <th
                          key={label}
                          className="px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.18em]"
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {businessSeries.map((row) => {
                      const legacyRow = summary.data?.legacy.series.find(
                        (candidate) => candidate.date === row.date
                      );

                      return (
                        <tr
                          key={row.date}
                          className="border-t border-[#eee6d4] text-[#2b2822]"
                        >
                          <td className="px-4 py-3 font-medium">
                            {formatChartDate(row.date)}
                          </td>
                          <td className="px-4 py-3">{formatNumber(row.signups)}</td>
                          <td className="px-4 py-3">
                            {formatNumber(row.persistedUsers)}
                          </td>
                          <td className="px-4 py-3">
                            {formatNumber(row.onboardingStarted)}
                          </td>
                          <td className="px-4 py-3">
                            {formatNumber(row.onboardingCompleted)}
                          </td>
                          <td className="px-4 py-3">
                            {formatNumber(row.profilesCreated)}
                          </td>
                          <td className="px-4 py-3">
                            {formatNumber(row.profilesConfirmed)}
                          </td>
                          <td className="px-4 py-3">
                            {formatNumber(legacyRow?.usersCreated)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="grid gap-6">
              <div className="rounded-[2rem] border border-[#e8dfcb] bg-white p-6 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#244d86]">
                      Legacy appendix
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold tracking-tight text-black">
                      Separate hushh-api flow
                    </h2>
                  </div>
                  <DashboardStatusBadge
                    label="Legacy appendix status"
                    value="Not merged"
                    className="border border-[#e8dfcb] bg-[#faf5ea] tracking-[0.18em] text-[#6f684f]"
                  />
                </div>

                <div className="mt-6 rounded-2xl border border-[#ece4d2] bg-[#faf5ea] px-4 py-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#6f684f]">
                    Legacy users created
                  </p>
                  <p className="mt-3 text-4xl font-semibold tracking-tight text-black">
                    {isLoaded
                      ? formatNumber(summary.data?.legacy.overview.usersCreated)
                      : "…"}
                  </p>
                </div>

                <p className="mt-4 text-sm leading-7 text-[#5f5a4d]">
                  {summary.data?.legacy.note ||
                    "Legacy audit notes will appear here once the summary loads."}
                </p>
              </div>

              {warnings.length > 0 && (
                <section className="rounded-[2rem] border border-amber-200 bg-amber-50 p-6 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-700">
                        Audit notes
                      </p>
                      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-amber-950">
                        Runtime warnings
                      </h2>
                    </div>
                    <DashboardStatusBadge
                      label="Audit notes status"
                      value={`${warnings.length} note${warnings.length === 1 ? "" : "s"}`}
                      className="border border-amber-200 bg-white/70 tracking-[0.18em] text-amber-800"
                    />
                  </div>

                  <div className="mt-5 grid gap-3">
                    {warnings.map((warning) => (
                      <div
                        key={warning}
                        className="rounded-2xl border border-amber-200 bg-white/80 px-4 py-3 text-sm leading-6 text-amber-950"
                      >
                        {warning}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </section>

          <section className="flex flex-col gap-2 rounded-[1.75rem] border border-[#e8dfcb] bg-white px-6 py-5 text-sm text-[#5f5a4d] shadow-sm md:flex-row md:items-center md:justify-between">
            <p>
              {summary.error
                ? `Latest load issue: ${summary.error}`
                : "Refreshes automatically every five minutes and matches the same payload used for the scheduled report email."}
            </p>
            <p>
              Build:{" "}
              <span className="font-medium text-black">
                {buildTimestamp ? formatTimestamp(buildTimestamp) : "local"}
              </span>
            </p>
          </section>
        </main>

        <Footer />
      </div>
    </>
  );
}
