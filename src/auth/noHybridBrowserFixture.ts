import type { AuthSessionSnapshot } from "./session";

export const NO_HYBRID_BROWSER_FIXTURE_GLOBAL =
  "__HUSHH_NO_HYBRID_AUTH_FIXTURE__" as const;

export type NoHybridBrowserPersona =
  | "firebase-user-a"
  | "firebase-user-b"
  | "firebase-admin";

interface FixtureDescriptor {
  schema_version: 1;
  contract_id: "hushh-tech-no-hybrid-browser-auth-v1";
  authority: "hushh-tech-uat";
  persona: NoHybridBrowserPersona;
}

interface FixtureWindow {
  location: Pick<Location, "origin">;
  [NO_HYBRID_BROWSER_FIXTURE_GLOBAL]?: unknown;
}

declare global {
  interface Window {
    __HUSHH_NO_HYBRID_AUTH_FIXTURE__?: unknown;
  }
}

const FIXTURE_ORIGIN = "http://127.0.0.1:5173";
const FIXTURE_KEYS = Object.freeze([
  "authority",
  "contract_id",
  "persona",
  "schema_version",
]);
const PERSONAS = new Set<NoHybridBrowserPersona>([
  "firebase-user-a",
  "firebase-user-b",
  "firebase-admin",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactDescriptor(value: unknown): FixtureDescriptor | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).sort().join("\0") !== FIXTURE_KEYS.join("\0")) {
    return null;
  }
  if (
    value.schema_version !== 1 ||
    value.contract_id !== "hushh-tech-no-hybrid-browser-auth-v1" ||
    value.authority !== "hushh-tech-uat" ||
    typeof value.persona !== "string" ||
    !PERSONAS.has(value.persona as NoHybridBrowserPersona)
  ) {
    return null;
  }
  return value as unknown as FixtureDescriptor;
}

export function resolveNoHybridBrowserFixture(
  source: FixtureWindow | undefined =
    typeof window === "undefined" ? undefined : window,
): AuthSessionSnapshot | null {
  if (!source || source.location.origin !== FIXTURE_ORIGIN) return null;
  const descriptor = exactDescriptor(
    source[NO_HYBRID_BROWSER_FIXTURE_GLOBAL],
  );
  if (!descriptor) return null;

  const isAdmin = descriptor.persona === "firebase-admin";
  const createdAt = "2026-01-01T00:00:00.000Z";
  const user = {
    id: `no-hybrid-${descriptor.persona}`,
    aud: "authenticated",
    role: "authenticated",
    email: `${descriptor.persona}@example.test`,
    app_metadata: {
      authority: descriptor.authority,
      fund_admin: isAdmin,
      fixture_persona: descriptor.persona,
    },
    user_metadata: {},
    identities: [],
    created_at: createdAt,
    updated_at: createdAt,
    last_sign_in_at: createdAt,
    is_anonymous: false,
  };
  const session = {
    access_token: `no-hybrid-local-fixture:${descriptor.persona}`,
    refresh_token: "no-hybrid-local-fixture:refresh-disabled",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: 4_102_444_800,
    user,
  };
  return { status: "authenticated", session, user };
}

export function clearNoHybridBrowserFixture(
  source: FixtureWindow | undefined =
    typeof window === "undefined" ? undefined : window,
): void {
  if (!source || source.location.origin !== FIXTURE_ORIGIN) return;
  delete source[NO_HYBRID_BROWSER_FIXTURE_GLOBAL];
}
