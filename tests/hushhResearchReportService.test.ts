import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const compatibilityReadMock = vi.hoisted(() => vi.fn());

vi.mock("../src/services/hushhResearch/compatibility", () => ({
  readHushhResearchCompatibilityIfActive: (...args: unknown[]) =>
    compatibilityReadMock(...args),
}));

const researchAsset = (assetId = "synthetic-report-101") => ({
  mode: "research",
  response: {
    state: "READY",
    record_type: "report_asset",
    payload: {
      asset_id: assetId,
      report_type: "research_summary",
      storage_state: "available",
      generated_at_ms: Date.parse("2026-08-20T12:00:03.000Z"),
    },
    source_hash: "a".repeat(64),
    updated_at_ms: Date.parse("2026-08-20T12:00:03.000Z"),
  },
});

describe("Hushh Research report compatibility", () => {
  beforeEach(() => {
    vi.resetModules();
    compatibilityReadMock.mockReset();
    vi.stubEnv("VITE_MARKET_SUPABASE_URL", "https://market.example.test");
    vi.stubEnv("VITE_MARKET_SUPABASE_KEY", "legacy-public-anon-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("translates matching Research metadata without exposing storage URLs", async () => {
    compatibilityReadMock.mockResolvedValue(researchAsset());
    const legacyFetch = vi.fn();
    vi.stubGlobal("fetch", legacyFetch);
    const { getReportById } = await import("../src/services/reportService");

    const result = await getReportById("synthetic-report-101");

    expect(result).toMatchObject({
      id: "synthetic-report-101",
      title: "Research Summary",
      date: "2026-08-20",
      report_type: "research_summary",
      storage_state: "available",
    });
    expect(result?.public_image_urls).toEqual([]);
    expect(result?.public_video_urls).toEqual([]);
    expect(result?.image_urls).toEqual([]);
    expect(result?.video_urls).toEqual([]);
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it("returns not-found when the requested id does not match the asset id", async () => {
    compatibilityReadMock.mockResolvedValue(researchAsset());
    const legacyFetch = vi.fn();
    vi.stubGlobal("fetch", legacyFetch);
    const { getReportById } = await import("../src/services/reportService");

    await expect(getReportById("different-report")).resolves.toBeNull();
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it("never falls back to market Supabase after Research storage loss", async () => {
    compatibilityReadMock.mockImplementation(
      (_recordType: string, options?: { researchBoundary?: boolean }) => {
        if (options?.researchBoundary) {
          return Promise.reject(
            Object.assign(new Error("Research sign-in is required."), {
              state: "UNAUTHENTICATED",
            }),
          );
        }
        return Promise.resolve({ mode: "legacy" });
      },
    );
    const legacyFetch = vi.fn();
    vi.stubGlobal("fetch", legacyFetch);
    const { getReportById } = await import("../src/services/reportService");

    await expect(
      getReportById("synthetic-report-101", { researchBoundary: true }),
    ).rejects.toMatchObject({ state: "UNAUTHENTICATED" });
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it("preserves the existing Supabase REST translation outside Research mode", async () => {
    compatibilityReadMock.mockResolvedValue({ mode: "legacy" });
    const legacyFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: "legacy-report",
          title: "Legacy report",
          date: "14/03/2025",
          image_urls: ["chart.png"],
          video_urls: ["briefing.mp4"],
        },
      ],
    });
    vi.stubGlobal("fetch", legacyFetch);
    const { getReportById } = await import("../src/services/reportService");

    const result = await getReportById("legacy-report");

    expect(legacyFetch).toHaveBeenCalledWith(
      "https://market.example.test/rest/v1/reports?id=eq.legacy-report&select=*",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          apikey: "legacy-public-anon-key",
          Authorization: "Bearer legacy-public-anon-key",
        }),
      }),
    );
    expect(result?.public_image_urls).toEqual([
      "https://market.example.test/storage/v1/object/public/alohafundsreport-images/dmu14mar/chart.png",
    ]);
    expect(result?.public_video_urls).toEqual([
      "https://market.example.test/storage/v1/object/public/alohafundsreport-videos/dmu14mar/briefing.mp4",
    ]);
  });
});
