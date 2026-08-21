import { beforeEach, describe, expect, it, vi } from "vitest";

const compatibilityReadMock = vi.hoisted(() => vi.fn());

vi.mock("../src/services/hushhResearch/compatibility", () => ({
  readHushhResearchCompatibilityIfActive: (...args: unknown[]) =>
    compatibilityReadMock(...args),
}));

import {
  fetchOnboardingProgress,
  fetchResolvedOnboardingProgress,
  translateHushhResearchOnboardingProgress,
} from "../src/services/onboarding/progress";

function researchOnboarding(
  payload: {
    status: "not_started" | "in_progress" | "complete";
    current_step?: string;
    completed_steps: string[];
  },
) {
  return {
    mode: "research",
    response: {
      state: "READY",
      record_type: "onboarding",
      payload,
      source_hash: "a".repeat(64),
      updated_at_ms: 1_787_227_201_000,
    },
  };
}

function legacyClient() {
  const from = vi.fn((table: string) => {
    const maybeSingle = vi.fn().mockResolvedValue(
      table === "onboarding_data"
        ? {
            data: {
              current_step: 5,
              is_completed: false,
              financial_link_status: "pending",
              fund_payment_status: null,
              fund_investor_verification_status: null,
            },
            error: null,
          }
        : { data: { status: "complete" }, error: null },
    );
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    return { select };
  });

  return { from };
}

describe("Hushh Research onboarding compatibility", () => {
  beforeEach(() => {
    compatibilityReadMock.mockReset();
  });

  it("maps complete to the terminal step with excluded legacy states", async () => {
    compatibilityReadMock.mockResolvedValue(
      researchOnboarding({
        status: "complete",
        current_step: "done",
        completed_steps: ["profile", "preferences", "review"],
      }),
    );
    const client = { from: vi.fn() };

    const result = await fetchResolvedOnboardingProgress(
      undefined,
      "synthetic-ada",
    );

    expect(result).toEqual({
      current_step: 13,
      is_completed: true,
      financial_link_status: "skipped",
      fund_payment_status: null,
      fund_investor_verification_status: null,
    });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("derives a bounded in-progress step only from completed steps", async () => {
    const progress = translateHushhResearchOnboardingProgress({
      status: "in_progress",
      current_step: "untrusted-free-text",
      completed_steps: Array.from({ length: 32 }, (_, index) => `step-${index}`),
    });

    expect(progress).toEqual({
      current_step: 13,
      is_completed: false,
      financial_link_status: "skipped",
      fund_payment_status: null,
      fund_investor_verification_status: null,
    });

    compatibilityReadMock.mockResolvedValue(
      researchOnboarding({
        status: "in_progress",
        current_step: "review",
        completed_steps: ["profile", "preferences"],
      }),
    );
    const client = { from: vi.fn() };
    await expect(
      fetchOnboardingProgress(undefined, "synthetic-grace"),
    ).resolves.toMatchObject({ current_step: 3, is_completed: false });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("does not fall back to Supabase for a typed Research failure", async () => {
    compatibilityReadMock.mockRejectedValue(
      Object.assign(new Error("Research consent is required."), {
        state: "CONSENT_REQUIRED",
      }),
    );
    const client = { from: vi.fn() };

    await expect(
      fetchResolvedOnboardingProgress(undefined, "synthetic-ada"),
    ).rejects.toMatchObject({ state: "CONSENT_REQUIRED" });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("keeps a React Research snapshot fail-closed after storage loss", async () => {
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
      fetchResolvedOnboardingProgress(client as never, "synthetic-ada", {
        researchBoundary: true,
      }),
    ).rejects.toMatchObject({ state: "UNAUTHENTICATED" });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("preserves legacy onboarding and financial-link resolution", async () => {
    compatibilityReadMock.mockResolvedValue({ mode: "legacy" });
    const client = legacyClient();

    const result = await fetchResolvedOnboardingProgress(
      client as never,
      "legacy-user",
    );

    expect(result).toEqual({
      current_step: 5,
      is_completed: false,
      financial_link_status: "completed",
      fund_payment_status: null,
      fund_investor_verification_status: null,
    });
    expect(client.from).toHaveBeenNthCalledWith(1, "onboarding_data");
    expect(client.from).toHaveBeenNthCalledWith(2, "user_financial_data");
  });
});
