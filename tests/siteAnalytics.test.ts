// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const researchModeMock = vi.hoisted(() => vi.fn());
const legacySessionMock = vi.hoisted(() => vi.fn());

vi.mock("../src/resources/config/config", () => ({
  default: {
    supabaseClient: {
      auth: {
        getSession: (...args: unknown[]) => legacySessionMock(...args),
      },
    },
  },
}));

vi.mock("../src/services/hushhResearch/firebaseAuth", () => ({
  isHushhResearchAuthMode: (...args: unknown[]) => researchModeMock(...args),
}));

describe("site analytics client", () => {
  beforeEach(() => {
    vi.resetModules();
    researchModeMock.mockReset().mockReturnValue(false);
    legacySessionMock
      .mockReset()
      .mockResolvedValue({ data: { session: null } });
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/profile/private-id?utm_source=person@example.com&utm_campaign=token-secret"
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("canonicalizes dynamic paths before sending events", async () => {
    const { sanitizeAnalyticsPath } = await import(
      "../src/services/analytics/siteAnalytics"
    );

    expect(sanitizeAnalyticsPath("/profile/user-123?token=secret")).toBe("/profile/:id");
    expect(sanitizeAnalyticsPath("/hushhid/abc-123")).toBe("/hushhid/:id");
    expect(sanitizeAnalyticsPath("/investor/founder-slug")).toBe("/investor/:slug");
    expect(sanitizeAnalyticsPath("/reports/report-123")).toBe("/reports/:id");
  });

  it("does not forward raw UTM query values", async () => {
    const { trackSiteEvent } = await import("../src/services/analytics/siteAnalytics");

    await trackSiteEvent("page_view");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const serialized = JSON.stringify(body);

    expect(body.events[0].routePath).toBe("/profile/:id");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("token-secret");
  });

  it("does not call the legacy collector or Supabase auth in Research mode", async () => {
    researchModeMock.mockReturnValue(true);
    const { trackSiteEvent } = await import("../src/services/analytics/siteAnalytics");

    await trackSiteEvent("page_view");

    expect(fetch).not.toHaveBeenCalled();
    expect(legacySessionMock).not.toHaveBeenCalled();
  });

  it("does not collect the Research callback before auth mode activates", async () => {
    window.history.replaceState(
      {},
      "",
      "/auth/hushh-research/callback?code=single-use&state=private",
    );
    const { trackSiteEvent } = await import("../src/services/analytics/siteAnalytics");

    await trackSiteEvent("page_view");

    expect(fetch).not.toHaveBeenCalled();
    expect(legacySessionMock).not.toHaveBeenCalled();
  });

  it("does not collect the Research start route before auth mode activates", async () => {
    window.history.replaceState({}, "", "/auth/hushh-research/start");
    const { trackSiteEvent } = await import("../src/services/analytics/siteAnalytics");

    await trackSiteEvent("page_view");

    expect(fetch).not.toHaveBeenCalled();
    expect(legacySessionMock).not.toHaveBeenCalled();
  });

  it.each([
    "/AUTH/HUSHH-RESEARCH/START/",
    "/Auth/Hushh-Research/Callback///",
  ])("does not collect normalized Research auth route %s", async (pathname) => {
    window.history.replaceState({}, "", pathname);
    const { trackSiteEvent } = await import(
      "../src/services/analytics/siteAnalytics"
    );

    await trackSiteEvent("page_view");

    expect(fetch).not.toHaveBeenCalled();
    expect(legacySessionMock).not.toHaveBeenCalled();
  });

  it("does not resume legacy analytics after Research logout", async () => {
    researchModeMock.mockReturnValue(true);
    window.history.replaceState({}, "", "/signed-out");
    const { trackSiteEvent } = await import(
      "../src/services/analytics/siteAnalytics"
    );

    await trackSiteEvent("page_view");

    expect(fetch).not.toHaveBeenCalled();
    expect(legacySessionMock).not.toHaveBeenCalled();
  });
});
