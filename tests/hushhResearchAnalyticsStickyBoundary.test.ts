// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Hushh Research analytics sticky boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/AUTH/HUSHH-RESEARCH/START/");
    vi.stubEnv("VITE_SUPABASE_URL", "https://legacy.example.test");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "legacy-public-anon-key");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("does not collect after mode storage disappears during the page lifetime", async () => {
    const { isHushhResearchAuthMode } = await import(
      "../src/services/hushhResearch/firebaseAuth"
    );
    expect(isHushhResearchAuthMode()).toBe(true);

    window.history.replaceState({}, "", "/signed-out");
    window.localStorage.clear();
    expect(isHushhResearchAuthMode()).toBe(true);

    const legacyFetch = vi.fn();
    vi.stubGlobal("fetch", legacyFetch);
    const { trackSiteEvent } = await import(
      "../src/services/analytics/siteAnalytics"
    );

    await trackSiteEvent("page_view");

    expect(legacyFetch).not.toHaveBeenCalled();
  });
});
