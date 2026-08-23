import { describe, expect, it } from "vitest";

import {
  __testing,
  buildMetricsSummary,
  buildRollingWindow,
  getDateKeyInTimezone,
} from "../api/metrics/service.js";

describe("metrics service", () => {
  it("configures the server-side GCP data client without a realtime vendor transport", () => {
    const client = __testing.createGcpBackendAdminClient();

    expect(client.from).toBeTypeOf("function");
    expect(client.rpc).toBeTypeOf("function");
    expect(client.storage.from).toBeTypeOf("function");
    expect(client).not.toHaveProperty("realtime");
  });

  it("builds a Pacific-time rolling window", () => {
    const window = buildRollingWindow({
      now: "2026-04-15T18:30:00.000Z",
      timezone: "America/Los_Angeles",
      windowDays: 7,
    });

    expect(window).toEqual({
      days: 7,
      startDate: "2026-04-09",
      endDate: "2026-04-15",
      dates: [
        "2026-04-09",
        "2026-04-10",
        "2026-04-11",
        "2026-04-12",
        "2026-04-13",
        "2026-04-14",
        "2026-04-15",
      ],
    });
    expect(
      getDateKeyInTimezone("2026-04-10T02:30:00.000Z", "America/Los_Angeles")
    ).toBe("2026-04-09");
  });

  it("assembles the dual-funnel summary from injected fetchers", async () => {
    const summary = await buildMetricsSummary({
      now: "2026-04-15T18:30:00.000Z",
      timezone: "America/Los_Angeles",
      windowDays: 7,
      fetchers: {
        fetchWebsiteAuthUsers: async () => [
          {
            id: "auth-1",
            created_at: "2026-04-09T18:00:00.000Z",
          },
          {
            id: "auth-2",
            created_at: "2026-04-10T02:30:00.000Z",
          },
        ],
        fetchWebsiteUsers: async () => [
          {
            id: "user-1",
            created_at: "2026-04-09T18:00:00.000Z",
            onboarding_step: "landing",
          },
        ],
        fetchOnboardingRows: async () => [
          {
            id: "onboarding-1",
            created_at: "2026-04-10T21:00:00.000Z",
            is_completed: true,
            completed_at: "2026-04-12T21:00:00.000Z",
          },
        ],
        fetchInvestorProfiles: async () => [
          {
            id: "profile-1",
            created_at: "2026-04-11T18:00:00.000Z",
            user_confirmed: true,
            confirmed_at: "2026-04-14T17:00:00.000Z",
          },
        ],
        runSchemaAudit: async () => ["schema warning"],
        fetchLegacyUsers: async () => ({
          available: true,
          rows: [
            {
              id: "legacy-1",
              created_at: "2026-04-13T15:00:00.000Z",
            },
          ],
          note: "legacy note",
          warnings: ["legacy warning"],
        }),
        fetchTrafficMetrics: async () => ({
          available: true,
          source: "ga4-data-api",
          overview: {
            active1DayUsers: 12,
            active7DayUsers: 24,
            active28DayUsers: 40,
            sessions: 50,
            engagedSessions: 35,
            screenPageViews: 88,
            newUsers: 9,
            engagementRate: 0.7,
            averageSessionDuration: 132,
            realtimeActiveUsers: 3,
          },
          series: [
            {
              date: "2026-04-09",
              activeUsers: 4,
              sessions: 6,
              screenPageViews: 8,
              engagedSessions: 4,
              newUsers: 1,
            },
            {
              date: "2026-04-10",
              activeUsers: 2,
              sessions: 3,
              screenPageViews: 5,
              engagedSessions: 2,
              newUsers: 1,
            },
            {
              date: "2026-04-11",
              activeUsers: 0,
              sessions: 0,
              screenPageViews: 0,
              engagedSessions: 0,
              newUsers: 0,
            },
            {
              date: "2026-04-12",
              activeUsers: 0,
              sessions: 0,
              screenPageViews: 0,
              engagedSessions: 0,
              newUsers: 0,
            },
            {
              date: "2026-04-13",
              activeUsers: 0,
              sessions: 0,
              screenPageViews: 0,
              engagedSessions: 0,
              newUsers: 0,
            },
            {
              date: "2026-04-14",
              activeUsers: 0,
              sessions: 0,
              screenPageViews: 0,
              engagedSessions: 0,
              newUsers: 0,
            },
            {
              date: "2026-04-15",
              activeUsers: 0,
              sessions: 0,
              screenPageViews: 0,
              engagedSessions: 0,
              newUsers: 0,
            },
          ],
          note: "traffic note",
        }),
      },
    });

    expect(summary.window).toEqual({
      days: 7,
      startDate: "2026-04-09",
      endDate: "2026-04-15",
    });
    expect(summary.businessFunnel.overview).toEqual({
      signups: 2,
      persistedUsers: 1,
      onboardingStarted: 1,
      onboardingCompleted: 1,
      profilesCreated: 1,
      profilesConfirmed: 1,
    });
    expect(summary.businessFunnel.series.find((row) => row.date === "2026-04-09"))
      .toMatchObject({
        signups: 2,
        persistedUsers: 1,
      });
    expect(summary.businessFunnel.series.find((row) => row.date === "2026-04-12"))
      .toMatchObject({
        onboardingCompleted: 1,
      });
    expect(summary.businessFunnel.series.find((row) => row.date === "2026-04-14"))
      .toMatchObject({
        profilesConfirmed: 1,
      });
    expect(summary.businessFunnel.conversionRates.signupToPersistedUsers).toBe(0.5);
    expect(summary.legacy.overview.usersCreated).toBe(1);
    expect(summary.traffic.overview.active28DayUsers).toBe(40);
    expect(summary.dataQualityWarnings).toEqual(
      expect.arrayContaining([
        "schema warning",
        "legacy warning",
        "Website auth signups (2) and website public.users rows (1) diverged over the current 7-day window.",
      ])
    );
    expect(summary.audience.source).toBe("ga4-data-api-fallback");
    expect(summary.audience.dau).toBe(12);
    expect(summary.search.totalSearches).toBe(0);
    expect(summary.searchPerformance.available).toBe(false);
    expect(summary.gcp.available).toBe(false);
  });

  it("adds first-party analytics and GCP aggregates when fetchers provide them", async () => {
    const summary = await buildMetricsSummary({
      now: "2026-04-28T18:30:00.000Z",
      timezone: "America/Los_Angeles",
      windowDays: 7,
      fetchers: {
        fetchWebsiteAuthUsers: async () => [],
        fetchWebsiteUsers: async () => [],
        fetchOnboardingRows: async () => [],
        fetchInvestorProfiles: async () => [],
        runSchemaAudit: async () => [],
        fetchLegacyUsers: async () => ({
          available: false,
          rows: [],
          note: "legacy unavailable",
          warnings: [],
        }),
        fetchTrafficMetrics: async () => ({
          available: true,
          source: "ga4-data-api",
          overview: {
            active1DayUsers: 1,
            active7DayUsers: 2,
            active28DayUsers: 3,
            sessions: 4,
            engagedSessions: 3,
            screenPageViews: 5,
            newUsers: 1,
            engagementRate: 0.75,
            averageSessionDuration: 80,
            realtimeActiveUsers: 1,
          },
          series: [],
          note: "traffic",
        }),
        fetchSiteAnalytics: async () => ({
          available: true,
          source: "website-supabase-site-analytics",
          audience: {
            dau: 7,
            wau: 14,
            mau: 28,
            sessions: 33,
            pageViews: 44,
            events: 55,
          },
          search: {
            totalSearches: 12,
            resultClickRate: 0.5,
            noResultRate: 0.25,
            bySurface: [{ surface: "community", searches: 12 }],
          },
          activity: {
            topPages: [{ path: "/community", views: 10 }],
            byRouteGroup: [{ routeGroup: "community", events: 20 }],
            byEvent: [{ eventName: "page_view", events: 20 }],
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
            firstPartyEventsAvailable: true,
            collectedEvents: 55,
            collectedSessions: 33,
            suppressedMinimumCount: 5,
          },
        }),
        fetchGcpBackendStackMetrics: async () => ({
          source: "website-gcpBackend",
          tables: [{ table: "site_analytics_events", available: true, total: 55, windowCount: 55 }],
        }),
        fetchGcpMetrics: async () => ({
          source: "gcp-cloud-monitoring",
          available: true,
          services: [{ name: "hushh-tech-website", available: true, requestCount: 100 }],
          requestCount: 100,
          errorRate: 0.02,
          p50LatencyMs: null,
          p95LatencyMs: 320,
          instanceCount: 2,
          uptimeAvailability: 0.98,
        }),
        fetchRegionalTraffic: async () => ({
          source: "ga4-data-api",
          available: true,
          byRegion: [{ state: "California", activeUsers: 30, sessions: 40 }],
        }),
        fetchSearchPerformance: async ({ regionalTraffic }) => ({
          source: "google-search-console",
          available: true,
          realtime: false,
          dataState: "all",
          searchType: "web",
          overview: {
            clicks: 120,
            impressions: 1200,
            ctr: 0.1,
            averagePosition: 6.2,
          },
          queries: [{ query: "hushh", clicks: 80, impressions: 800, ctr: 0.1, averagePosition: 3.2 }],
          pages: [{ pageUrl: "https://hushhtech.com/community", clicks: 30, impressions: 300, ctr: 0.1, averagePosition: 4.2 }],
          countries: [{ country: "USA", clicks: 100, impressions: 1000, ctr: 0.1, averagePosition: 5.1 }],
          devices: [{ device: "DESKTOP", clicks: 70, impressions: 700, ctr: 0.1, averagePosition: 4.8 }],
          searchAppearance: [{ appearance: "VIDEO", clicks: 20, impressions: 200, ctr: 0.1, averagePosition: 7.1 }],
          state: regionalTraffic,
          metadata: {},
          note: "fresh",
        }),
      },
    });

    expect(summary.audience).toMatchObject({
      source: "website-gcpBackend-site-analytics",
      dau: 7,
      sessions: 33,
    });
    expect(summary.search.totalSearches).toBe(12);
    expect(summary.activity.topPages[0]).toEqual({
      path: "/community",
      views: 10,
    });
    expect(summary.gcp).toMatchObject({
      available: true,
      requestCount: 100,
      p95LatencyMs: 320,
    });
    expect(summary.searchPerformance).toMatchObject({
      available: true,
      overview: {
        clicks: 120,
        impressions: 1200,
      },
      state: {
        byRegion: [{ state: "California", activeUsers: 30, sessions: 40 }],
      },
    });
    expect(summary.systemHealth.publicSafety).toEqual({
      rawRowsReturned: false,
      piiReturned: false,
      smallCellSuppressionMinimum: 5,
    });
    expect(summary.dataCoverage).toMatchObject({
      firstPartyEventsAvailable: true,
      ga4Available: true,
      gcpAvailable: true,
      searchConsoleAvailable: true,
      ga4RegionAvailable: true,
      gcpBackendAggregateTables: 1,
    });
  });

  it("aggregates first-party analytics without leaking small funnel cells", async () => {
    const capturedRanges: Array<{ gte?: string; lte?: string; range?: [number, number] }> = [];
    const fillerRows = Array.from({ length: 5000 }, (_, index) => ({
      event_id: `older-${index}`,
      event_name: "page_view",
      occurred_at: "2026-03-20T12:00:00.000Z",
      route_path: "/older",
      route_group: "older",
      session_key: `older-session-${index}`,
      anonymous_id_hash: `older-anon-${index}`,
      user_id: null,
      properties: {},
    }));
    const rows = [
      ...Array.from({ length: 5 }, (_, index) => ({
        event_id: `page-${index}`,
        event_name: "page_view",
        occurred_at:
          index === 0 ? "2026-04-16T06:30:00.000Z" : "2026-04-15T15:00:00.000Z",
        route_path: "/community",
        route_group: "community",
        session_key: `page-session-${index}`,
        anonymous_id_hash: `page-anon-${index}`,
        user_id: null,
        properties: {},
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        event_id: `search-${index}`,
        event_name: "community_search",
        occurred_at: "2026-04-15T16:00:00.000Z",
        route_path: "/community",
        route_group: "community",
        session_key: `session-${index}`,
        anonymous_id_hash: `anon-${index}`,
        user_id: null,
        properties: {
          surface: "community",
          resultCount: index === 0 ? 0 : 3,
        },
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        event_id: `click-${index}`,
        event_name: "community_result_clicked",
        occurred_at: "2026-04-15T16:10:00.000Z",
        route_path: "/community",
        route_group: "community",
        session_key: `session-${index}`,
        anonymous_id_hash: `anon-${index}`,
        user_id: null,
        properties: {},
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        event_id: `signup-start-${index}`,
        event_name: "signup_start",
        occurred_at: "2026-04-15T17:00:00.000Z",
        route_path: "/Signup",
        route_group: "auth",
        session_key: `signup-${index}`,
        anonymous_id_hash: `signup-anon-${index}`,
        user_id: null,
        properties: {},
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        event_id: `signup-complete-${index}`,
        event_name: "signup_completed",
        occurred_at: "2026-04-15T17:05:00.000Z",
        route_path: "/Signup",
        route_group: "auth",
        session_key: `signup-${index}`,
        anonymous_id_hash: `signup-anon-${index}`,
        user_id: null,
        properties: {},
      })),
    ];
    const client = {
      from: () => {
        const state: { gte?: string; lte?: string } = {};
        const query = {
          select: () => query,
          gte: (_column: string, value: string) => {
            state.gte = value;
            return query;
          },
          lte: (_column: string, value: string) => {
            state.lte = value;
            return query;
          },
          order: () => query,
          range: (from: number, to: number) => {
            capturedRanges.push({ ...state, range: [from, to] });
            return Promise.resolve({
              data: from === 0 ? fillerRows : from === 5000 ? rows : [],
              error: null,
            });
          },
        };
        return query;
      },
    };

    const analytics = await __testing.fetchSiteAnalytics(
      client,
      {
        days: 7,
        startDate: "2026-04-09",
        endDate: "2026-04-15",
        dates: [],
      },
      "America/Los_Angeles",
      []
    );

    expect(capturedRanges[0]).toMatchObject({
      gte: "2026-03-16T00:00:00.000Z",
      lte: "2026-04-16T23:59:59.999Z",
      range: [0, 4999],
    });
    expect(capturedRanges[1].range).toEqual([5000, 9999]);
    expect(analytics.audience.dau).toBeGreaterThanOrEqual(13);
    expect(analytics.search).toMatchObject({
      totalSearches: 5,
      resultClickRate: 1,
      noResultRate: null,
    });
    expect(analytics.activity.topPages).toEqual([{ path: "/community", views: 5 }]);
    expect(analytics.funnels.signup).toEqual([
      {
        step: "Signup started",
        eventName: "signup_start",
        count: 6,
        conversionFromPrevious: null,
        dropoffFromPrevious: null,
      },
      {
        step: "Signup completed",
        eventName: "signup_completed",
        count: null,
        conversionFromPrevious: null,
        dropoffFromPrevious: null,
      },
    ]);
    expect(analytics.dropoff.signup).toEqual([]);
  });

  it("builds public-safe Search Console performance rows", () => {
    const report = __testing.buildSearchPerformanceReport({
      dataState: "all",
      searchType: "web",
      overviewRows: [
        {
          clicks: 1234,
          impressions: 98765,
          position: 4.26,
        },
      ],
      queryRows: [
        {
          keys: ["hushh investor profile"],
          clicks: 31,
          impressions: 620,
          position: 3.24,
        },
        {
          keys: ["person@example.com"],
          clicks: 100,
          impressions: 5000,
          position: 1.2,
        },
        {
          keys: ["tiny query"],
          clicks: 2,
          impressions: 80,
          position: 9,
        },
      ],
      pageRows: [
        {
          keys: ["https://hushhtech.com/profile/private-user?token=secret#hash"],
          clicks: 12,
          impressions: 180,
          position: 5.6,
        },
      ],
      countryRows: [
        {
          keys: ["usa"],
          clicks: 4,
          impressions: 140,
          position: 8.1,
        },
      ],
      deviceRows: [
        {
          keys: ["mobile"],
          clicks: 24,
          impressions: 240,
          position: 7.3,
        },
      ],
      searchAppearanceRows: [
        {
          keys: ["VIDEO"],
          clicks: 16,
          impressions: 160,
          position: 4.9,
        },
      ],
      state: {
        source: "ga4-data-api",
        available: true,
        byRegion: [{ state: "California", activeUsers: 30, sessions: 40 }],
      },
    });

    expect(report.overview).toMatchObject({
      clicks: 1200,
      impressions: 98800,
      averagePosition: 4.3,
    });
    expect(report.overview.ctr).toBeCloseTo(1200 / 98800);
    expect(report.queries).toMatchObject([
      {
        query: "hushh investor profile",
        clicks: 30,
        impressions: 620,
        averagePosition: 3.2,
      },
    ]);
    expect(report.queries[0].ctr).toBeCloseTo(30 / 620);
    expect(report.pages).toMatchObject([
      {
        pageUrl: "https://hushhtech.com/profile/:id",
        clicks: 10,
        impressions: 180,
        averagePosition: 5.6,
      },
    ]);
    expect(report.pages[0].ctr).toBeCloseTo(10 / 180);
    expect(report.countries[0]).toMatchObject({
      country: "USA",
      clicks: null,
      impressions: 140,
      ctr: null,
    });
    expect(report.devices[0]).toMatchObject({
      device: "MOBILE",
      clicks: 20,
      impressions: 240,
    });
    expect(report.searchAppearance[0]).toMatchObject({
      appearance: "VIDEO",
      clicks: 20,
      impressions: 160,
    });
    expect(JSON.stringify(report)).not.toContain("person@example.com");
    expect(JSON.stringify(report)).not.toContain("token=secret");
  });
});
