import { beforeEach, describe, expect, it, vi } from "vitest";

const compatibilityReadMock = vi.hoisted(() => vi.fn());
const compatibilityModeMock = vi.hoisted(() => vi.fn());

vi.mock("../src/services/hushhResearch/compatibility", () => ({
  readHushhResearchCompatibilityIfActive: (...args: unknown[]) =>
    compatibilityReadMock(...args),
  hasHushhResearchProfileMetadata: (profile: {
    display_name?: string;
    avatar_asset_id?: string;
  }) =>
    Boolean(
      profile.display_name?.trim() || profile.avatar_asset_id?.trim(),
    ),
  getHushhResearchCompatibilityMode: (...args: unknown[]) =>
    compatibilityModeMock(...args),
}));

import { __testing__ } from "../src/hooks/useInvestorJourneyCta";
import {
  fetchCompatibleProfileBuiltStatus,
  isCompatibleNdaApproved,
} from "../src/pages/profile/logic";

describe("Hushh Research profile readiness", () => {
  beforeEach(() => {
    compatibilityReadMock.mockReset();
    compatibilityModeMock.mockReset().mockResolvedValue("research");
  });

  it("uses synthetic profile metadata without querying investor_profiles", async () => {
    compatibilityReadMock.mockResolvedValue({
      mode: "research",
      response: {
        state: "READY",
        record_type: "profile",
        payload: {
          display_name: "Synthetic Ada",
          avatar_asset_id: "synthetic-avatar-101",
          locale: "en-US",
        },
        source_hash: "a".repeat(64),
        updated_at_ms: 1_787_227_200_000,
      },
    });
    const client = { from: vi.fn() };

    await expect(
      __testing__.fetchInvestorProfileBuiltStatus(
        client as never,
        "synthetic-ada",
      ),
    ).resolves.toBe(true);
    await expect(
      fetchCompatibleProfileBuiltStatus(client as never, "synthetic-ada"),
    ).resolves.toBe(true);
    await expect(
      fetchCompatibleProfileBuiltStatus(undefined, "synthetic-ada"),
    ).resolves.toBe(true);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("propagates Research profile failures without a Supabase fallback", async () => {
    compatibilityReadMock.mockRejectedValue(
      Object.assign(new Error("Research data is stale."), {
        state: "STALE_SHADOW",
      }),
    );
    const client = { from: vi.fn() };

    await expect(
      fetchCompatibleProfileBuiltStatus(undefined, "synthetic-ada"),
    ).rejects.toMatchObject({ state: "STALE_SHADOW" });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("passes sticky Research identity when browser mode storage is gone", async () => {
    compatibilityReadMock.mockImplementation(
      (_recordType: string, options?: { researchBoundary?: boolean }) =>
        options?.researchBoundary
          ? Promise.reject(
              Object.assign(new Error("Research sign-in is required."), {
                state: "UNAUTHENTICATED",
              }),
            )
          : Promise.resolve({ mode: "legacy" }),
    );
    const client = { from: vi.fn() };

    await expect(
      fetchCompatibleProfileBuiltStatus(client as never, "synthetic-ada", true),
    ).rejects.toMatchObject({ state: "UNAUTHENTICATED" });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("does not treat Research access metadata as NDA approval", async () => {
    const readLegacyAccess = vi.fn();

    await expect(
      isCompatibleNdaApproved("firebase-id-token", readLegacyAccess),
    ).resolves.toBe(false);
    expect(readLegacyAccess).not.toHaveBeenCalled();
  });

  it("uses the React Research boundary to deny NDA after storage loss", async () => {
    compatibilityModeMock.mockResolvedValue("legacy");
    const readLegacyAccess = vi.fn();

    await expect(
      isCompatibleNdaApproved(
        "firebase-id-token",
        readLegacyAccess,
        true,
      ),
    ).resolves.toBe(false);
    expect(compatibilityModeMock).not.toHaveBeenCalled();
    expect(readLegacyAccess).not.toHaveBeenCalled();
  });

  it("preserves the legacy investor_profiles lookup outside Research mode", async () => {
    compatibilityReadMock.mockResolvedValue({ mode: "legacy" });
    const buildClient = () => {
      const maybeSingle = vi.fn().mockResolvedValue({
        data: { id: "legacy-profile", user_confirmed: false },
        error: null,
      });
      const eq = vi.fn(() => ({ maybeSingle }));
      const select = vi.fn(() => ({ eq }));
      const from = vi.fn(() => ({ select }));
      return { client: { from }, from, select, eq };
    };

    const journey = buildClient();
    await expect(
      __testing__.fetchInvestorProfileBuiltStatus(
        journey.client as never,
        "legacy-user",
      ),
    ).resolves.toBe(true);
    expect(journey.from).toHaveBeenCalledWith("investor_profiles");
    expect(journey.eq).toHaveBeenCalledWith("user_id", "legacy-user");

    const profile = buildClient();
    await expect(
      fetchCompatibleProfileBuiltStatus(
        profile.client as never,
        "legacy-user",
      ),
    ).resolves.toBe(true);
    expect(profile.from).toHaveBeenCalledWith("investor_profiles");
    expect(profile.select).toHaveBeenCalledWith("id, user_confirmed");
    expect(profile.eq).toHaveBeenCalledWith("user_id", "legacy-user");
  });
});
