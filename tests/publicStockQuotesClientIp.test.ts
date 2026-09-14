import { describe, expect, it } from "vitest";

import { __testing } from "../api/shared/publicStockQuotesGateway.js";

const { canonicalTrustedClientIp } = __testing;

const withXff = (value?: string) => ({
  headers: value === undefined ? {} : { "x-forwarded-for": value },
});

/**
 * Which hop of `X-Forwarded-For` the rate-limit key is derived from.
 *
 * The original rule demanded a chain of exactly two and returned the FIRST entry. Both halves were
 * wrong, and neither had ever run in anger because the feature was disabled in every environment.
 *
 *   - The two-hop shape belongs to an external HTTP(S) load balancer. This service sits behind
 *     Cloud Run's own front end, which sends one entry, so every real browser was refused.
 *   - Cloud Run APPENDS the true peer to whatever the caller sent. Returning the first entry
 *     therefore returned a caller-chosen value, and the rate-limit key is an HMAC of it — a fresh
 *     fake hop per request is a fresh identity, and the limiter never bites.
 *
 * Both were confirmed against the deployed service before the fix.
 */
describe("trusted client IP", () => {
  it("accepts the single-entry chain Cloud Run actually sends", () => {
    // The case every browser hits, and the one the old rule rejected outright.
    expect(canonicalTrustedClientIp(withXff("50.35.60.144"))).toBe("50.35.60.144");
  });

  it("ignores a hop the caller prepended and uses the one the platform appended", () => {
    // Exactly the request that got through the old check with a forged identity.
    expect(canonicalTrustedClientIp(withXff("203.0.113.7, 50.35.60.144"))).toBe("50.35.60.144");
  });

  it("is not fooled by a longer forged prefix either", () => {
    expect(
      canonicalTrustedClientIp(withXff("203.0.113.7, 198.51.100.2, 192.0.2.9, 50.35.60.144")),
    ).toBe("50.35.60.144");
  });

  it("handles IPv6 peers", () => {
    expect(canonicalTrustedClientIp(withXff("2001:db8::1"))).toBe("2001:db8::1");
  });

  it("refuses a request with no forwarded chain at all", () => {
    expect(() => canonicalTrustedClientIp(withXff())).toThrow(/Access denied/);
  });

  it("refuses a last hop that is not an IP", () => {
    // A caller cannot choose this value on Cloud Run, so reaching here means something upstream of
    // the assumption changed — fail rather than key the limiter on a string.
    expect(() => canonicalTrustedClientIp(withXff("50.35.60.144, not-an-ip"))).toThrow(
      /Access denied/,
    );
    expect(() => canonicalTrustedClientIp(withXff(""))).toThrow(/Access denied/);
  });

  it("refuses an absurdly long header rather than parsing it", () => {
    expect(() => canonicalTrustedClientIp(withXff("1.2.3.4, ".repeat(40)))).toThrow(
      /Access denied/,
    );
  });
});
