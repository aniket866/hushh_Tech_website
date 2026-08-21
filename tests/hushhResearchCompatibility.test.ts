import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionStateMock = vi.hoisted(() => vi.fn());

vi.mock("../src/services/hushhResearch/firebaseAuth", () => ({
  getHushhResearchSessionState: (...args: unknown[]) =>
    getSessionStateMock(...args),
}));

import {
  HushhResearchCompatibilityError,
  hasHushhResearchProfileMetadata,
  readHushhResearchAccessState,
  readHushhResearchCompatibilityIfActive,
} from "../src/services/hushhResearch/compatibility";

const SOURCE_HASH = "a".repeat(64);
const TOKEN = "firebase-id-token-do-not-log";

const authenticatedState = (linkState: "READY" | "LINK_REQUIRED" = "READY") => ({
  status: "authenticated",
  session: {
    access_token: TOKEN,
    refresh_token: "refresh-token",
    token_type: "bearer",
    user: {
      id: "hushh-tech-uat-synthetic-ada-001",
      app_metadata: {
        auth_source: "hushh-research",
        research_link_state: linkState,
      },
      user_metadata: {},
      aud: "authenticated",
      created_at: "2026-08-21T00:00:00.000Z",
    },
  },
  user: {
    id: "hushh-tech-uat-synthetic-ada-001",
    app_metadata: {
      auth_source: "hushh-research",
      research_link_state: linkState,
    },
    user_metadata: {},
    aud: "authenticated",
    created_at: "2026-08-21T00:00:00.000Z",
  },
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("Hushh Research compatibility facade", () => {
  beforeEach(() => {
    getSessionStateMock.mockReset();
  });

  it("returns the legacy mode without making a gateway request", async () => {
    getSessionStateMock.mockResolvedValue({ status: "inactive" });
    const fetchImpl = vi.fn();

    await expect(
      readHushhResearchCompatibilityIfActive("profile", { fetchImpl }),
    ).resolves.toEqual({ mode: "legacy" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not reopen legacy mode when a Research React snapshot outlives storage", async () => {
    getSessionStateMock.mockResolvedValue({ status: "inactive" });
    const fetchImpl = vi.fn();

    await expect(
      readHushhResearchCompatibilityIfActive("report_asset", {
        fetchImpl,
        researchBoundary: true,
      }),
    ).rejects.toMatchObject({
      name: "HushhResearchCompatibilityError",
      state: "UNAUTHENTICATED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses only the refreshed READY Firebase session on the same-origin gateway", async () => {
    getSessionStateMock.mockResolvedValue(authenticatedState());
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        state: "READY",
        record_type: "profile",
        payload: {
          display_name: "Synthetic Ada",
          avatar_asset_id: "synthetic-avatar-101",
          locale: "en-US",
        },
        source_hash: SOURCE_HASH,
        updated_at_ms: 1_787_227_200_000,
      }),
    );

    const result = await readHushhResearchCompatibilityIfActive("profile", {
      fetchImpl,
    });

    expect(result).toMatchObject({
      mode: "research",
      response: {
        state: "READY",
        record_type: "profile",
        source_hash: SOURCE_HASH,
      },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/hushh-research/compatibility/profile",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
      }),
    );
  });

  it("exposes access-state metadata without turning it into an entitlement", async () => {
    getSessionStateMock.mockResolvedValue(authenticatedState());
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        state: "READY",
        record_type: "access_state",
        payload: {
          state: "enabled",
          reason_code: "synthetic_uat_cohort",
          last_evaluated_at_ms: 1_787_227_202_000,
        },
        source_hash: SOURCE_HASH,
        updated_at_ms: 1_787_227_202_000,
      }),
    );

    const result = await readHushhResearchAccessState({ fetchImpl });

    expect(result.mode).toBe("research");
    if (result.mode === "research") {
      expect(result.response.payload).toEqual({
        state: "enabled",
        reason_code: "synthetic_uat_cohort",
        last_evaluated_at_ms: 1_787_227_202_000,
      });
      expect(result.response.payload).not.toHaveProperty("payment_status");
      expect(result.response.payload).not.toHaveProperty("nda_status");
      expect(result.response.payload).not.toHaveProperty("kyc_status");
    }
  });

  it("fails before fetch when the refreshed Research session is not READY", async () => {
    getSessionStateMock.mockResolvedValue(authenticatedState("LINK_REQUIRED"));
    const fetchImpl = vi.fn();

    const promise = readHushhResearchCompatibilityIfActive("onboarding", {
      fetchImpl,
    });
    await expect(promise).rejects.toMatchObject({
      name: "HushhResearchCompatibilityError",
      state: "LINK_REQUIRED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves typed fail-closed gateway states", async () => {
    getSessionStateMock.mockResolvedValue(authenticatedState());
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          state: "STALE_SHADOW",
          message: "Shadow is stale.",
        },
        409,
      ),
    );

    await expect(
      readHushhResearchCompatibilityIfActive("onboarding", { fetchImpl }),
    ).rejects.toEqual(
      expect.objectContaining<HushhResearchCompatibilityError>({
        state: "STALE_SHADOW",
        statusCode: 409,
      }),
    );
  });

  it("rejects extra response fields instead of trusting contract drift", async () => {
    getSessionStateMock.mockResolvedValue(authenticatedState());
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        state: "READY",
        record_type: "report_asset",
        payload: {
          asset_id: "synthetic-report-101",
          report_type: "research_summary",
          storage_state: "available",
          generated_at_ms: 1_787_227_203_000,
        },
        source_hash: SOURCE_HASH,
        updated_at_ms: 1_787_227_203_000,
        owner_token: "must-not-pass",
      }),
    );

    await expect(
      readHushhResearchCompatibilityIfActive("report_asset", { fetchImpl }),
    ).rejects.toMatchObject({ state: "UPSTREAM_UNAVAILABLE" });
  });

  it("uses only nonempty display-name or avatar metadata for profile readiness", () => {
    expect(
      hasHushhResearchProfileMetadata({
        display_name: "Synthetic Ada",
        locale: "en-US",
      }),
    ).toBe(true);
    expect(
      hasHushhResearchProfileMetadata({
        display_name: " ",
        avatar_asset_id: "synthetic-avatar-101",
        locale: "en-US",
      }),
    ).toBe(true);
    expect(
      hasHushhResearchProfileMetadata({ display_name: " ", locale: "en-US" }),
    ).toBe(false);
  });
});
