import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/resources/resources", () => ({
  default: {
    config: {
      gcpBackendClient: null,
    },
  },
}));

import resources from "../src/resources/resources";
import { fetchPublicInvestorProfileBySlug } from "../src/services/investorProfile";

describe("fetchPublicInvestorProfileBySlug", () => {
  const rpcMock = vi.fn();

  beforeEach(() => {
    rpcMock.mockReset();
    (resources.config as any).gcpBackendClient = {
      rpc: rpcMock,
    };
  });

  it("loads shared investor profiles through the secure RPC", async () => {
    rpcMock.mockResolvedValue({
      data: {
        slug: "ankit-kumar-singh-2597e6b8",
        profile_url:
          "https://hushhtech.com/investor/ankit-kumar-singh-2597e6b8",
        is_confirmed: true,
        basic_info: {
          name: "Ankit Kumar Singh",
          email: "a***h@example.com",
          age: 31,
          organisation: "Hushh",
        },
        investor_profile: {
          primary_goal: {
            value: "long_term_growth",
            confidence: 0.82,
            rationale: "Matched from profile context",
          },
        },
        onboarding_data: {
          citizenship_country: "India",
          residence_country: "India",
        },
        shadow_profile: null,
      },
      error: null,
    });

    const profile = await fetchPublicInvestorProfileBySlug(
      "  ankit-kumar-singh-2597e6b8  "
    );

    expect(rpcMock).toHaveBeenCalledWith("get_public_investor_profile", {
      p_slug: "ankit-kumar-singh-2597e6b8",
    });
    expect(profile.is_confirmed).toBe(true);
    expect(profile.basic_info.email).toBe("a***h@example.com");
    expect(profile.profile_url).toBe(
      "https://hushhtech.com/investor/ankit-kumar-singh-2597e6b8"
    );
    expect(profile.onboarding_data).toEqual({
      citizenship_country: "India",
      residence_country: "India",
    });
  });

  it("returns basic shared profiles even before confirmation", async () => {
    rpcMock.mockResolvedValue({
      data: {
        slug: "ankit-kumar-singh-2597e6b8",
        profile_url:
          "https://hushhtech.com/investor/ankit-kumar-singh-2597e6b8",
        is_confirmed: false,
        basic_info: {
          name: "Ankit Kumar Singh",
          email: "a***h@example.com",
          age: null,
          organisation: null,
        },
        investor_profile: null,
        onboarding_data: null,
        shadow_profile: null,
      },
      error: null,
    });

    const profile = await fetchPublicInvestorProfileBySlug(
      "ankit-kumar-singh-2597e6b8"
    );

    expect(profile.is_confirmed).toBe(false);
    expect(profile.basic_info.name).toBe("Ankit Kumar Singh");
    expect(profile.investor_profile).toBeNull();
    expect(profile.onboarding_data).toBeNull();
    expect(profile.shadow_profile).toBeNull();
  });

  it("throws when no public profile projection is returned", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: null,
    });

    await expect(fetchPublicInvestorProfileBySlug("missing-profile")).rejects.toThrow(
      "Profile not found or is private"
    );
  });
});
