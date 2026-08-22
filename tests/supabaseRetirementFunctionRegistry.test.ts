import { describe, expect, it } from "vitest";

import {
  GCP_BACKEND_RETIREMENT_FUNCTION_REGISTRY,
  GCP_BACKEND_RETIREMENT_FUNCTION_REGISTRY_DIGEST,
  GCP_BACKEND_RETIREMENT_FUNCTION_REGISTRY_VERSION,
  GCP_BACKEND_RETIREMENT_FUNCTIONS,
  getSupabaseRetirementFunction,
  resolveSupabaseRetirementFunctionGate,
} from "../api/shared/supabaseRetirementFunctionRegistry.js";

describe("Supabase retirement runtime function registry", () => {
  it("ships the exact 112-function generated allowlist inside api/shared", () => {
    expect(GCP_BACKEND_RETIREMENT_FUNCTION_REGISTRY_VERSION).toBe(1);
    expect(GCP_BACKEND_RETIREMENT_FUNCTION_REGISTRY_DIGEST).toBe(
      "00b022ae3eab4a559fb5e70a90f55283e738a5fa81ed34a2e1aafb20e8479d55"
    );
    expect(GCP_BACKEND_RETIREMENT_FUNCTIONS).toHaveLength(112);
    expect(Object.keys(GCP_BACKEND_RETIREMENT_FUNCTION_REGISTRY)).toHaveLength(112);
    expect(new Set(GCP_BACKEND_RETIREMENT_FUNCTIONS.map((entry) => entry.slug)).size).toBe(112);
  });

  it("contains only the runtime-safe migration fields", () => {
    for (const entry of GCP_BACKEND_RETIREMENT_FUNCTIONS) {
      expect(Object.keys(entry).sort()).toEqual(
        [
          "auth_mode",
          "final_disposition",
          "migration_state",
          "owner_group",
          "slug",
        ].sort()
      );
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(Object.isFrozen(GCP_BACKEND_RETIREMENT_FUNCTIONS)).toBe(true);
    expect(Object.isFrozen(GCP_BACKEND_RETIREMENT_FUNCTION_REGISTRY)).toBe(true);
  });

  it("returns 410 FEATURE_RETIRED for get-secrets", () => {
    expect(getSupabaseRetirementFunction("get-secrets")).toMatchObject({
      slug: "get-secrets",
      final_disposition: "RETIRE_WITH_410",
    });
    expect(resolveSupabaseRetirementFunctionGate("get-secrets")).toMatchObject({
      allowed: false,
      httpStatus: 410,
      code: "FEATURE_RETIRED",
    });
  });

  it("enables only geocode and keeps every other replacement fail closed", () => {
    const nonRetired = GCP_BACKEND_RETIREMENT_FUNCTIONS.filter(
      (entry) => entry.final_disposition !== "RETIRE_WITH_410"
    );

    expect(nonRetired).toHaveLength(111);
    expect(
      nonRetired.filter((entry) => entry.migration_state === "PORTED_AND_VERIFIED"),
    ).toEqual([
      expect.objectContaining({ slug: "hushh-location-geocode" }),
    ]);
    expect(resolveSupabaseRetirementFunctionGate("hushh-location-geocode")).toMatchObject({
      allowed: true,
      code: "PORTED_AND_VERIFIED",
    });
    for (const entry of nonRetired.filter(
      ({ slug }) => slug !== "hushh-location-geocode",
    )) {
      expect(resolveSupabaseRetirementFunctionGate(entry.slug)).toMatchObject({
        allowed: false,
        httpStatus: 503,
        code: "FEATURE_DISABLED",
      });
    }
    expect(resolveSupabaseRetirementFunctionGate("nda-admin-fetch")).toMatchObject({
      allowed: false,
      httpStatus: 503,
    });
  });

  it("never treats an unknown or malformed slug as a generic proxy target", () => {
    for (const slug of [
      "not-in-the-manifest",
      "create-link-token/anything",
      "../get-secrets",
      "",
    ]) {
      expect(resolveSupabaseRetirementFunctionGate(slug)).toEqual({
        allowed: false,
        httpStatus: 404,
        code: "LEGACY_FUNCTION_NOT_ALLOWLISTED",
        entry: null,
      });
    }
  });
});
