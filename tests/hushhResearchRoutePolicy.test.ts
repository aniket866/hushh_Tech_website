import { describe, expect, it } from "vitest";

import {
  canHushhResearchAccessRoute,
  canGuestAccessRoute,
  isGuestAuthRoute,
} from "../src/auth/routePolicy";

describe("Hushh Research guest auth routes", () => {
  it("allows the Research start and callback before a session exists", () => {
    expect(isGuestAuthRoute("/auth/hushh-research/start")).toBe(true);
    expect(isGuestAuthRoute("/auth/hushh-research/callback")).toBe(true);
  });

  it("does not widen unrelated auth-like paths", () => {
    expect(isGuestAuthRoute("/auth/hushh-researcher/callback")).toBe(false);
  });

  it("keeps only the exact public profile route guest-accessible", () => {
    expect(canGuestAccessRoute("/profile")).toBe(true);
    expect(canGuestAccessRoute("/profile/private-user-id")).toBe(false);
  });

  it.each([
    "/",
    "/profile",
    "/signed-out",
    "/auth/hushh-research/start",
    "/auth/hushh-research/callback",
    "/AUTH/HUSHH-RESEARCH/START/",
    "/Auth/Hushh-Research/Callback///",
    "/reports/synthetic-report-101",
    "/reports/SYNTHETIC_101.json",
  ])("allows only the explicit Research surface %s", (pathname) => {
    expect(canHushhResearchAccessRoute(pathname)).toBe(true);
  });

  it.each([
    "/auth/callback",
    "/auth/hushh-research",
    "/signup",
    "/investor-guide",
    "/metrics",
    "/hushh-ai",
    "/hushh-ai/login",
    "/profile/private-user-id",
    "/investor/public-slug",
    "/hushhid/public-id",
    "/onboarding/step-1",
    "/reports",
    "/reports/one/two",
    "/reports/%2fmetrics",
    "/reports/%252fmetrics",
    "/reports/..",
  ])("blocks the legacy or malformed Research surface %s", (pathname) => {
    expect(canHushhResearchAccessRoute(pathname)).toBe(false);
  });
});
