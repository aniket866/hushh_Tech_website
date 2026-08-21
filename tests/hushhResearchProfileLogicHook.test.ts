// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const compatibilityReadMock = vi.hoisted(() => vi.fn());
const compatibilityModeMock = vi.hoisted(() => vi.fn());
const legacyNdaMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../src/resources/config/config", () => ({
  default: { supabaseClient: undefined },
}));

vi.mock("../src/auth/AuthSessionProvider", () => ({
  useAuthSession: () => ({
    session: {
      access_token: "firebase-id-token",
      user: {
        id: "hushh-tech-uat-synthetic-ada-001",
        app_metadata: { auth_source: "hushh-research" },
      },
    },
  }),
}));

vi.mock("../src/services/hushhResearch/firebaseAuth", () => ({
  // Model the storage-loss case: React still owns the Research snapshot.
  isHushhResearchAuthMode: () => false,
}));

vi.mock("../src/services/hushhResearch/compatibility", () => ({
  readHushhResearchCompatibilityIfActive: (...args: unknown[]) =>
    compatibilityReadMock(...args),
  getHushhResearchCompatibilityMode: (...args: unknown[]) =>
    compatibilityModeMock(...args),
  hasHushhResearchProfileMetadata: (profile: { display_name?: string }) =>
    Boolean(profile.display_name?.trim()),
}));

vi.mock("../src/services/access/accessControlApi", () => ({
  checkAccessStatus: (...args: unknown[]) => legacyNdaMock(...args),
}));

vi.mock("../src/hooks/useInvestorJourneyCta", () => ({
  useInvestorJourneyCta: () => ({
    primaryCTA: {
      text: "View your profile",
      action: vi.fn(),
      loading: false,
      state: "research_ready",
      isInvestor: false,
      progressLabel: null,
    },
  }),
}));

import { useProfileLogic } from "../src/pages/profile/logic";

describe("useProfileLogic Research compatibility", () => {
  let container: HTMLDivElement;
  let root: Root;

  const Probe = () => {
    const { onboardingStatus, ndaApproved } = useProfileLogic();
    return React.createElement(
      "span",
      null,
      JSON.stringify({ onboardingStatus, ndaApproved }),
    );
  };

  beforeEach(() => {
    compatibilityModeMock.mockReset().mockResolvedValue("legacy");
    legacyNdaMock.mockReset();
    compatibilityReadMock.mockReset().mockImplementation(
      (recordType: "profile" | "onboarding", options?: { researchBoundary?: boolean }) => {
        expect(options).toEqual({ researchBoundary: true });
        return Promise.resolve(
          recordType === "profile"
            ? {
                mode: "research",
                response: { payload: { display_name: "Synthetic Ada" } },
              }
            : {
                mode: "research",
                response: {
                  payload: {
                    status: "in_progress",
                    completed_steps: ["profile", "preferences"],
                  },
                },
              },
        );
      },
    );
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

  it("loads profile and onboarding metadata without a Supabase client", async () => {
    await act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('"hasProfile":true');
    expect(container.textContent).toContain('"currentStep":3');
    expect(container.textContent).toContain(
      '"financialLinkStatus":"skipped"',
    );
    expect(container.textContent).toContain('"loading":false');
    expect(container.textContent).toContain('"ndaApproved":false');
    expect(legacyNdaMock).not.toHaveBeenCalled();
    expect(compatibilityModeMock).not.toHaveBeenCalled();
  });
});
