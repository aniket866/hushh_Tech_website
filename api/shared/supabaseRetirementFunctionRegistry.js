import {
  SUPABASE_RETIREMENT_FUNCTION_REGISTRY,
  SUPABASE_RETIREMENT_FUNCTION_REGISTRY_DIGEST,
  SUPABASE_RETIREMENT_FUNCTION_REGISTRY_VERSION,
  SUPABASE_RETIREMENT_FUNCTIONS,
} from "./supabaseRetirementFunctionRegistry.generated.js";

export {
  SUPABASE_RETIREMENT_FUNCTION_REGISTRY,
  SUPABASE_RETIREMENT_FUNCTION_REGISTRY_DIGEST,
  SUPABASE_RETIREMENT_FUNCTION_REGISTRY_VERSION,
  SUPABASE_RETIREMENT_FUNCTIONS,
};

export const PORTED_AND_VERIFIED = "PORTED_AND_VERIFIED";

export function getSupabaseRetirementFunction(slug) {
  if (typeof slug !== "string" || slug.length === 0) return null;
  return SUPABASE_RETIREMENT_FUNCTION_REGISTRY[slug] || null;
}

export function resolveSupabaseRetirementFunctionGate(slug) {
  const entry = getSupabaseRetirementFunction(slug);

  if (!entry) {
    return Object.freeze({
      allowed: false,
      httpStatus: 404,
      code: "LEGACY_FUNCTION_NOT_ALLOWLISTED",
      entry: null,
    });
  }

  if (entry.final_disposition === "RETIRE_WITH_410") {
    return Object.freeze({
      allowed: false,
      httpStatus: 410,
      code: "FEATURE_RETIRED",
      entry,
    });
  }

  if (entry.migration_state !== PORTED_AND_VERIFIED) {
    return Object.freeze({
      allowed: false,
      httpStatus: 503,
      code: "FEATURE_DISABLED",
      entry,
    });
  }

  return Object.freeze({
    allowed: true,
    httpStatus: null,
    code: PORTED_AND_VERIFIED,
    entry,
  });
}
