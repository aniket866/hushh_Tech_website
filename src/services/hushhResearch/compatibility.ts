import type { Session, User } from "@supabase/supabase-js";

import {
  getHushhResearchSessionState,
} from "./firebaseAuth";

export const HUSHH_RESEARCH_COMPATIBILITY_PATH =
  "/api/hushh-research/compatibility" as const;

export type HushhResearchCompatibilityRecordType =
  | "profile"
  | "onboarding"
  | "access_state"
  | "report_asset";

export type HushhResearchCompatibilityFailureState =
  | "UNAUTHENTICATED"
  | "LINK_REQUIRED"
  | "LINK_CONFLICT"
  | "CONSENT_REQUIRED"
  | "UPSTREAM_UNAVAILABLE"
  | "STALE_SHADOW"
  | "FEATURE_DISABLED";

export interface HushhResearchProfilePayload {
  display_name: string;
  avatar_asset_id?: string;
  locale?: string;
}

export interface HushhResearchOnboardingPayload {
  status: "not_started" | "in_progress" | "complete";
  current_step?: string;
  completed_steps: string[];
}

export interface HushhResearchAccessStatePayload {
  state: "enabled" | "blocked" | "review_required";
  reason_code?: string;
  last_evaluated_at_ms: number;
}

export interface HushhResearchReportAssetPayload {
  asset_id: string;
  report_type: string;
  storage_state: "available" | "pending" | "unavailable";
  generated_at_ms: number;
}

interface HushhResearchCompatibilityPayloadMap {
  profile: HushhResearchProfilePayload;
  onboarding: HushhResearchOnboardingPayload;
  access_state: HushhResearchAccessStatePayload;
  report_asset: HushhResearchReportAssetPayload;
}

export interface HushhResearchCompatibilityResponse<
  RecordType extends HushhResearchCompatibilityRecordType,
> {
  state: "READY";
  record_type: RecordType;
  payload: HushhResearchCompatibilityPayloadMap[RecordType];
  source_hash: string;
  updated_at_ms: number;
}

export type HushhResearchCompatibilityRead<
  RecordType extends HushhResearchCompatibilityRecordType,
> =
  | { mode: "legacy" }
  | {
      mode: "research";
      response: HushhResearchCompatibilityResponse<RecordType>;
    };

export class HushhResearchCompatibilityError extends Error {
  readonly state: HushhResearchCompatibilityFailureState;
  readonly statusCode?: number;

  constructor(
    state: HushhResearchCompatibilityFailureState,
    options: { statusCode?: number } = {},
  ) {
    super(messageForFailureState(state));
    this.name = "HushhResearchCompatibilityError";
    this.state = state;
    this.statusCode = options.statusCode;
  }
}

type FetchLike = typeof fetch;

export interface CompatibilityRequestOptions {
  fetchImpl?: FetchLike;
  /**
   * Sticky caller proof that the current React session belongs to Research.
   * This never supplies a token; it only prevents a lost browser-mode key
   * from reopening a legacy/Supabase fallback.
   */
  researchBoundary?: boolean;
}

type ResearchSessionContext = {
  mode: "research";
  session: Session;
  user: User;
};

type CompatibilitySessionContext =
  | { mode: "legacy" }
  | ResearchSessionContext;

const FAILURE_STATES = new Set<HushhResearchCompatibilityFailureState>([
  "UNAUTHENTICATED",
  "LINK_REQUIRED",
  "LINK_CONFLICT",
  "CONSENT_REQUIRED",
  "UPSTREAM_UNAVAILABLE",
  "STALE_SHADOW",
  "FEATURE_DISABLED",
]);

const RESPONSE_KEYS = [
  "payload",
  "record_type",
  "source_hash",
  "state",
  "updated_at_ms",
] as const;

function messageForFailureState(
  state: HushhResearchCompatibilityFailureState,
): string {
  switch (state) {
    case "UNAUTHENTICATED":
      return "Research sign-in is required.";
    case "LINK_REQUIRED":
      return "Research account linking is required.";
    case "LINK_CONFLICT":
      return "Research account linking has a conflict.";
    case "CONSENT_REQUIRED":
      return "Research consent is required.";
    case "STALE_SHADOW":
      return "Research data is stale.";
    case "FEATURE_DISABLED":
      return "Research access is disabled.";
    case "UPSTREAM_UNAVAILABLE":
      return "Research data is unavailable.";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isShortString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function isOptionalShortString(value: unknown, maxLength: number): boolean {
  return value === undefined || isShortString(value, maxLength);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isProfilePayload(value: unknown): value is HushhResearchProfilePayload {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, ["display_name", "avatar_asset_id", "locale"]) &&
    isShortString(value.display_name, 120) &&
    isOptionalShortString(value.avatar_asset_id, 128) &&
    isOptionalShortString(value.locale, 32)
  );
}

function isOnboardingPayload(
  value: unknown,
): value is HushhResearchOnboardingPayload {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, ["status", "current_step", "completed_steps"]) &&
    ["not_started", "in_progress", "complete"].includes(
      String(value.status),
    ) &&
    isOptionalShortString(value.current_step, 64) &&
    Array.isArray(value.completed_steps) &&
    value.completed_steps.length <= 32 &&
    value.completed_steps.every((step) => isShortString(step, 64))
  );
}

function isAccessStatePayload(
  value: unknown,
): value is HushhResearchAccessStatePayload {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, ["state", "reason_code", "last_evaluated_at_ms"]) &&
    ["enabled", "blocked", "review_required"].includes(String(value.state)) &&
    isOptionalShortString(value.reason_code, 128) &&
    Number.isSafeInteger(value.last_evaluated_at_ms) &&
    Number(value.last_evaluated_at_ms) >= 0
  );
}

function isReportAssetPayload(
  value: unknown,
): value is HushhResearchReportAssetPayload {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      "asset_id",
      "report_type",
      "storage_state",
      "generated_at_ms",
    ]) &&
    isShortString(value.asset_id, 128) &&
    isShortString(value.report_type, 128) &&
    ["available", "pending", "unavailable"].includes(
      String(value.storage_state),
    ) &&
    Number.isSafeInteger(value.generated_at_ms) &&
    Number(value.generated_at_ms) >= 0
  );
}

const PAYLOAD_VALIDATORS = {
  profile: isProfilePayload,
  onboarding: isOnboardingPayload,
  access_state: isAccessStatePayload,
  report_asset: isReportAssetPayload,
} satisfies Record<
  HushhResearchCompatibilityRecordType,
  (value: unknown) => boolean
>;

function parseCompatibilityResponse<
  RecordType extends HushhResearchCompatibilityRecordType,
>(
  value: unknown,
  recordType: RecordType,
): HushhResearchCompatibilityResponse<RecordType> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RESPONSE_KEYS) ||
    value.state !== "READY" ||
    value.record_type !== recordType ||
    typeof value.source_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.source_hash) ||
    !Number.isSafeInteger(value.updated_at_ms) ||
    Number(value.updated_at_ms) < 1 ||
    !PAYLOAD_VALIDATORS[recordType](value.payload)
  ) {
    throw new HushhResearchCompatibilityError("UPSTREAM_UNAVAILABLE");
  }

  return value as unknown as HushhResearchCompatibilityResponse<RecordType>;
}

function readFailureState(value: unknown): HushhResearchCompatibilityFailureState | null {
  if (!isRecord(value)) return null;
  const direct = value.state;
  const detail = isRecord(value.detail) ? value.detail.code : undefined;
  const candidate = typeof direct === "string" ? direct : detail;
  return typeof candidate === "string" &&
    FAILURE_STATES.has(candidate as HushhResearchCompatibilityFailureState)
    ? (candidate as HushhResearchCompatibilityFailureState)
    : null;
}

function fallbackFailureState(statusCode: number): HushhResearchCompatibilityFailureState {
  if (statusCode === 401) return "UNAUTHENTICATED";
  if (statusCode === 404) return "FEATURE_DISABLED";
  if (statusCode === 409) return "LINK_CONFLICT";
  return "UPSTREAM_UNAVAILABLE";
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function resolveCompatibilitySession(
  researchBoundary = false,
): Promise<CompatibilitySessionContext> {
  const state = await getHushhResearchSessionState();
  if (state.status === "inactive") {
    if (researchBoundary) {
      throw new HushhResearchCompatibilityError("UNAUTHENTICATED");
    }
    return { mode: "legacy" };
  }
  if (state.status !== "authenticated") {
    throw new HushhResearchCompatibilityError("UNAUTHENTICATED");
  }

  const linkState = state.user.app_metadata?.research_link_state;
  if (linkState !== "READY") {
    throw new HushhResearchCompatibilityError("LINK_REQUIRED");
  }
  if (
    typeof state.session.access_token !== "string" ||
    state.session.access_token.trim().length === 0
  ) {
    throw new HushhResearchCompatibilityError("UNAUTHENTICATED");
  }

  return {
    mode: "research",
    session: state.session,
    user: state.user,
  };
}

export async function getHushhResearchCompatibilityMode(
  options: Pick<CompatibilityRequestOptions, "researchBoundary"> = {},
): Promise<"legacy" | "research"> {
  return (await resolveCompatibilitySession(options.researchBoundary)).mode;
}

export async function readHushhResearchCompatibilityIfActive<
  RecordType extends HushhResearchCompatibilityRecordType,
>(
  recordType: RecordType,
  options: CompatibilityRequestOptions = {},
): Promise<HushhResearchCompatibilityRead<RecordType>> {
  const context = await resolveCompatibilitySession(options.researchBoundary);
  if (context.mode === "legacy") {
    return context;
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new HushhResearchCompatibilityError("UPSTREAM_UNAVAILABLE");
  }

  let response: Response;
  try {
    response = await fetchImpl(
      `${HUSHH_RESEARCH_COMPATIBILITY_PATH}/${recordType}`,
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${context.session.access_token}`,
        },
      },
    );
  } catch {
    throw new HushhResearchCompatibilityError("UPSTREAM_UNAVAILABLE");
  }

  const payload = await readJson(response);
  if (!response.ok) {
    throw new HushhResearchCompatibilityError(
      readFailureState(payload) ?? fallbackFailureState(response.status),
      { statusCode: response.status },
    );
  }

  return {
    mode: "research",
    response: parseCompatibilityResponse(payload, recordType),
  };
}

export function hasHushhResearchProfileMetadata(
  profile: Partial<HushhResearchProfilePayload> | null | undefined,
): boolean {
  return Boolean(
    (typeof profile?.display_name === "string" &&
      profile.display_name.trim().length > 0) ||
      (typeof profile?.avatar_asset_id === "string" &&
        profile.avatar_asset_id.trim().length > 0),
  );
}

export async function readHushhResearchAccessState(
  options: CompatibilityRequestOptions = {},
): Promise<HushhResearchCompatibilityRead<"access_state">> {
  return readHushhResearchCompatibilityIfActive("access_state", options);
}
