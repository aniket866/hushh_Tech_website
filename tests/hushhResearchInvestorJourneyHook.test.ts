// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigateMock = vi.hoisted(() => vi.fn());
const compatibilityReadMock = vi.hoisted(() => vi.fn());
const researchModeMock = vi.hoisted(() => vi.fn());
const hookHarness = vi.hoisted(() => ({
  session: null as null | {
    user: {
      id: string;
      app_metadata: Record<string, unknown>;
    };
  },
  status: "anonymous" as string,
  supabaseClient: undefined as
    | { from: ReturnType<typeof vi.fn> }
    | undefined,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("../src/auth/AuthSessionProvider", () => ({
  useAuthSession: () => ({
    session: hookHarness.session,
    status: hookHarness.status,
  }),
}));

vi.mock("../src/resources/config/config", () => ({
  default: {
    get supabaseClient() {
      return hookHarness.supabaseClient;
    },
  },
}));

vi.mock("../src/services/hushhResearch/firebaseAuth", () => ({
  isHushhResearchAuthMode: (...args: unknown[]) => researchModeMock(...args),
}));

vi.mock("../src/services/hushhResearch/compatibility", () => ({
  readHushhResearchCompatibilityIfActive: (...args: unknown[]) =>
    compatibilityReadMock(...args),
  hasHushhResearchProfileMetadata: (profile: {
    display_name?: string;
    avatar_asset_id?: string;
  }) => Boolean(profile.display_name?.trim() || profile.avatar_asset_id?.trim()),
}));

import {
  type InvestorJourneyCta,
  useInvestorJourneyCta,
} from "../src/hooks/useInvestorJourneyCta";

describe("useInvestorJourneyCta Research boundary", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestCta: InvestorJourneyCta | null;

  const Probe = () => {
    const { primaryCTA } = useInvestorJourneyCta();
    latestCta = primaryCTA;
    return React.createElement(
      "span",
      { "data-testid": "journey" },
      `${primaryCTA.state}|${primaryCTA.text}`,
    );
  };

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    navigateMock.mockReset();
    researchModeMock.mockReset().mockReturnValue(false);
    compatibilityReadMock.mockReset();
    hookHarness.session = {
      user: {
        id: "hushh-tech-uat-synthetic-ada-001",
        app_metadata: { auth_source: "hushh-research" },
      },
    };
    hookHarness.status = "authenticated";
    hookHarness.supabaseClient = undefined;
    latestCta = null;
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("uses only the safe profile CTA for incomplete Research onboarding without Supabase", async () => {
    compatibilityReadMock.mockImplementation(
      (recordType: "profile" | "onboarding", options?: { researchBoundary?: boolean }) => {
        expect(options).toEqual({ researchBoundary: true });
        return Promise.resolve(
          recordType === "profile"
            ? {
                mode: "research",
                response: {
                  payload: { display_name: "Synthetic Ada" },
                },
              }
            : {
                mode: "research",
                response: {
                  payload: {
                    status: "in_progress",
                    completed_steps: ["profile"],
                  },
                },
              },
        );
      },
    );

    await act(async () => {
      root.render(React.createElement(Probe));
    });
    await flush();

    expect(container.textContent).toBe("research_ready|View your profile");
    await act(async () => {
      latestCta?.action();
    });
    expect(navigateMock).toHaveBeenCalledWith("/profile");
    expect(navigateMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/onboarding|payment|kyc|financial-link/i),
    );
  });

  it("returns a disabled CTA on Research errors instead of entering legacy onboarding", async () => {
    compatibilityReadMock.mockRejectedValue(
      Object.assign(new Error("Research data is stale."), {
        state: "STALE_SHADOW",
      }),
    );

    await act(async () => {
      root.render(React.createElement(Probe));
    });
    await flush();

    expect(container.textContent).toBe(
      "research_unavailable|Profile unavailable",
    );
    await act(async () => {
      latestCta?.action();
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("preserves the legacy catch fallback outside Research mode", async () => {
    hookHarness.session = {
      user: {
        id: "legacy-user",
        app_metadata: { provider: "google" },
      },
    };
    hookHarness.supabaseClient = {
      from: vi.fn(() => {
        throw new Error("legacy lookup failed");
      }),
    };
    compatibilityReadMock.mockResolvedValue({ mode: "legacy" });

    await act(async () => {
      root.render(React.createElement(Probe));
    });
    await flush();

    expect(container.textContent).toBe("needs_onboarding|Start investing");
    await act(async () => {
      latestCta?.action();
    });
    expect(navigateMock).toHaveBeenCalledWith("/onboarding/financial-link");
  });
});
