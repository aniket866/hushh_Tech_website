import { beforeEach, describe, expect, it, vi } from "vitest";

const researchModeMock = vi.hoisted(() => vi.fn());

vi.mock("../src/services/hushhResearch/firebaseAuth", () => ({
  isHushhResearchAuthMode: (...args: unknown[]) => researchModeMock(...args),
}));

import {
  isHushhResearchProductBoundary,
  readHushhCoinsBalance,
} from "../src/services/hushhResearch/legacyProductData";

function clientReturning(balance: number) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: { hushh_coins_awarded: balance },
    error: null,
  });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from }, from, select, eq };
}

describe("Hushh Research legacy product-data guard", () => {
  beforeEach(() => {
    researchModeMock.mockReset().mockReturnValue(false);
  });

  it("returns before the Navbar coin query for a Research session", async () => {
    const { client, from } = clientReturning(99);

    await expect(
      readHushhCoinsBalance(client as never, {
        id: "hushh-tech-uat-synthetic-ada-001",
        app_metadata: { auth_source: "hushh-research" },
      }),
    ).resolves.toEqual({ mode: "research" });
    expect(from).not.toHaveBeenCalled();
  });

  it("also blocks the query while Research mode is active without a session tag", async () => {
    researchModeMock.mockReturnValue(true);
    const { client, from } = clientReturning(99);

    await expect(
      readHushhCoinsBalance(client as never, {
        id: "pending-research-user",
        app_metadata: {},
      }),
    ).resolves.toEqual({ mode: "research" });
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    "/auth/hushh-research/start",
    "/auth/hushh-research/callback",
    "/AUTH/HUSHH-RESEARCH/START/",
    "/Auth/Hushh-Research/Callback///",
  ])("blocks Navbar legacy reads on the first %s render", (pathname) => {
    expect(
      isHushhResearchProductBoundary(pathname, {
        app_metadata: { provider: "google" },
      }),
    ).toBe(true);
    expect(researchModeMock).not.toHaveBeenCalled();
  });

  it("preserves the legacy ceo_meeting_payments query", async () => {
    const { client, from, select, eq } = clientReturning(42);

    await expect(
      readHushhCoinsBalance(client as never, {
        id: "legacy-user",
        app_metadata: { provider: "google" },
      }),
    ).resolves.toEqual({ mode: "legacy", balance: 42 });
    expect(from).toHaveBeenCalledWith("ceo_meeting_payments");
    expect(select).toHaveBeenCalledWith("hushh_coins_awarded");
    expect(eq).toHaveBeenCalledWith("user_id", "legacy-user");
  });
});
