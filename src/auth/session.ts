import type { Session, GcpBackendClient, User } from "@/services/gcpBackend/types";
import {
  resolveOAuthHost,
  type OAuthHostResolution,
} from "./authHost";
import config from "../resources/config/config";
import {
  DEFAULT_AUTH_REDIRECT,
  sanitizeInternalRedirect,
} from "../utils/security";

export type AuthSessionStatus =
  | "booting"
  | "authenticated"
  | "anonymous"
  | "invalidated";

export type AuthSessionReason =
  | "signed_out"
  | "expired"
  | "deleted"
  | "invalid_session";

export type OAuthProvider = "google" | "apple";

export type OAuthStartFailureReason =
  | "missing_client"
  | "unsupported_host"
  | "provider_error"
  | "missing_authorize_url";

export type OAuthStartResult =
  | {
      ok: true;
      provider: OAuthProvider;
      redirectTo: string;
    }
  | {
      ok: false;
      provider: OAuthProvider;
      reason: OAuthStartFailureReason;
      message: string;
      redirectTo?: string;
    };

export interface AuthSessionSnapshot {
  status: AuthSessionStatus;
  session: Session | null;
  user: User | null;
  reason?: AuthSessionReason;
}

export interface AuthBroadcastEvent {
  at: number;
  reason: AuthSessionReason;
}

export const AUTH_EVENT_STORAGE_KEY = "hushh_auth_event";

const LEGACY_AUTH_STORAGE_KEYS = [
  "isLoggedIn",
  "showWelcomeToast",
  "showWelcomeToastUserId",
];

export function clearLegacyAuthStorage() {
  if (typeof window === "undefined") {
    return;
  }

  LEGACY_AUTH_STORAGE_KEYS.forEach((key) => {
    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
  });
}

function getGcpBackendAuthStorageKey(
  client: GcpBackendClient | undefined = config.gcpBackendClient
) {
  const authStorageKey = (client?.auth as unknown as { storageKey?: unknown })
    ?.storageKey;
  if (typeof authStorageKey === "string" && authStorageKey.trim()) {
    return authStorageKey.trim();
  }

  try {
    const projectRef = new URL(config.GCP_API_BASE_URL).hostname.split(".")[0];
    return projectRef ? `sb-${projectRef}-auth-token` : null;
  } catch {
    return null;
  }
}

export function clearPersistedGcpBackendAuthSession(
  client: GcpBackendClient | undefined = config.gcpBackendClient
) {
  if (typeof window === "undefined") {
    return;
  }

  const baseKey = getGcpBackendAuthStorageKey(client);
  if (!baseKey) {
    return;
  }

  const authKeys = [baseKey, `${baseKey}-code-verifier`, `${baseKey}-user`];
  for (const storage of [window.localStorage, window.sessionStorage]) {
    authKeys.forEach((key) => storage.removeItem(key));
  }
}

export function buildOAuthRedirectTo(
  provider: OAuthProvider,
  search: string = window.location.search,
  callbackUrl: string = `${window.location.origin}/auth/callback`
) {
  const currentParams = new URLSearchParams(search);
  const rawRedirectPath = currentParams.get("redirect");
  const redirectPath = rawRedirectPath
    ? sanitizeInternalRedirect(rawRedirectPath, DEFAULT_AUTH_REDIRECT)
    : null;

  let redirectTo = callbackUrl;
  if (redirectPath) {
    redirectTo = `${redirectTo}?redirect=${encodeURIComponent(redirectPath)}`;
  }

  if (provider === "google") {
    return {
      redirectTo,
      queryParams: { access_type: "offline", prompt: "consent" },
    };
  }

  return {
    redirectTo,
    scopes: "name email",
  };
}

function getOAuthHostResolution(): OAuthHostResolution {
  return resolveOAuthHost(
    window.location.pathname,
    window.location.search,
    config.redirect_url,
    window.location.origin
  );
}

export async function startUnifiedOAuth(
  provider: OAuthProvider,
  client: GcpBackendClient | undefined = config.gcpBackendClient
): Promise<OAuthStartResult> {
  try {
    const hostResolution = getOAuthHostResolution();
    if (!hostResolution.supported) {
      return {
        ok: false,
        provider,
        reason: "unsupported_host",
        message: `Sign-in is only available on ${hostResolution.canonicalOrigin}.`,
        redirectTo: hostResolution.canonicalEntryUrl,
      };
    }

    if (!client) {
      return {
        ok: false,
        provider,
        reason: "missing_client",
        message:
          "Authentication is not configured for this build. Missing GcpBackend client configuration.",
      };
    }

    const options = buildOAuthRedirectTo(
      provider,
      window.location.search,
      hostResolution.callbackUrl
    );
    const { data, error } = await client.auth.signInWithOAuth({
      provider,
      options,
    });

    if (error) {
      return {
        ok: false,
        provider,
        reason: "provider_error",
        message: error.message || `Unable to start ${provider} sign-in.`,
      };
    }

    if (data?.url) {
      window.location.assign(data.url);
      return {
        ok: true,
        provider,
        redirectTo: data.url,
      };
    }

    // Firebase owns the browser navigation when signInWithRedirect resolves.
    // A null URL therefore means the redirect was accepted, not rejected.
    return {
      ok: true,
      provider,
      redirectTo: hostResolution.callbackUrl,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Unable to start ${provider} sign-in.`;
    return {
      ok: false,
      provider,
      reason: "provider_error",
      message,
    };
  }
}

export function getAuthInvalidationReason(error?: {
  message?: string;
  status?: number;
} | null): AuthSessionReason {
  const message = error?.message?.toLowerCase() || "";
  if (error?.status === 401 || message.includes("expired")) {
    return "expired";
  }

  return "invalid_session";
}

/**
 * Timeout duration for the server-side getUser() validation call.
 * If the call takes longer than this, we fall back to trusting the local session.
 * This prevents the "Verifying access..." infinite loading bug.
 */
const VALIDATE_SESSION_TIMEOUT_MS = 5000;

export async function validateSessionCandidate(
  client: GcpBackendClient | undefined,
  session: Session | null
): Promise<AuthSessionSnapshot> {
  if (!client || !session?.access_token || !session.user?.id) {
    return {
      status: "anonymous",
      session: null,
      user: null,
    };
  }

  if (typeof client.auth.getUser !== "function") {
    return {
      status: "authenticated",
      session,
      user: session.user as User,
    };
  }

  try {
    // Race getUser() against a timeout to prevent infinite loading.
    // If the server call hangs (network issues, OAuth race condition),
    // we fall back to trusting the local session data.
    const getUserPromise = client.auth.getUser();
    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), VALIDATE_SESSION_TIMEOUT_MS)
    );

    const result = await Promise.race([getUserPromise, timeoutPromise]);

    // Timeout — fall back to trusting the local session
    if (result === "timeout") {
      console.warn(
        "[AuthSession] getUser() timed out after %dms, trusting local session",
        VALIDATE_SESSION_TIMEOUT_MS
      );
      return {
        status: "authenticated",
        session,
        user: session.user as User,
      };
    }

    const {
      data: { user },
      error,
    } = result;

    if (error || !user || user.id !== session.user.id) {
      return {
        status: "invalidated",
        session: null,
        user: null,
        reason: getAuthInvalidationReason(error),
      };
    }

    return {
      status: "authenticated",
      session,
      user,
    };
  } catch (error) {
    console.error("[AuthSession] Session validation failed:", error);
    return {
      status: "invalidated",
      session: null,
      user: null,
      reason: "invalid_session",
    };
  }
}

/**
 * Soft revalidation — reads session from localStorage only, no network call.
 * Used for focus/visibility events where we just need to confirm the session
 * still exists locally. GcpBackend's autoRefreshToken handles token renewal
 * automatically in the background.
 */
export async function getLocalSession(
  client: GcpBackendClient | undefined = config.gcpBackendClient
): Promise<AuthSessionSnapshot> {
  if (!client) {
    return { status: "anonymous", session: null, user: null };
  }

  try {
    const {
      data: { session },
      error,
    } = await client.auth.getSession();

    if (!session || !session.access_token || !session.user?.id) {
      return {
        status: error ? "invalidated" : "anonymous",
        session: null,
        user: null,
        reason: error ? getAuthInvalidationReason(error) : undefined,
      };
    }

    // Trust the local session — no server-side getUser() call
    return {
      status: "authenticated",
      session,
      user: session.user as User,
    };
  } catch (error) {
    console.error("[AuthSession] Failed to read local session:", error);
    return {
      status: "invalidated",
      session: null,
      user: null,
      reason: "invalid_session",
    };
  }
}

/**
 * Full revalidation — reads session from localStorage AND validates with
 * a server-side getUser() call. Used for initial boot and auth state changes.
 */
export async function getValidatedSession(
  client: GcpBackendClient | undefined = config.gcpBackendClient
): Promise<AuthSessionSnapshot> {
  if (!client) {
    return {
      status: "anonymous",
      session: null,
      user: null,
    };
  }

  try {
    const {
      data: { session },
      error,
    } = await client.auth.getSession();

    if (!session) {
      return {
        status: error ? "invalidated" : "anonymous",
        session: null,
        user: null,
        reason: error ? getAuthInvalidationReason(error) : undefined,
      };
    }

    return validateSessionCandidate(client, session);
  } catch (error) {
    console.error("[AuthSession] Failed to read current session:", error);
    return {
      status: "invalidated",
      session: null,
      user: null,
      reason: "invalid_session",
    };
  }
}

export async function getAuthenticatedSession(
  client: GcpBackendClient | undefined = config.gcpBackendClient,
  errorMessage = "User not logged in. Please sign in again."
): Promise<Session> {
  const snapshot = await getValidatedSession(client);

  if (snapshot.status !== "authenticated" || !snapshot.session?.access_token) {
    throw new Error(errorMessage);
  }

  return snapshot.session;
}

export async function clearGcpBackendSession(
  client: GcpBackendClient | undefined = config.gcpBackendClient,
  options: { storageOnly?: boolean } = {}
) {
  if (!client) {
    clearPersistedGcpBackendAuthSession(client);
    return;
  }

  if (options.storageOnly) {
    clearPersistedGcpBackendAuthSession(client);
    return;
  }

  try {
    await client.auth.signOut({ scope: "local" as any });
  } catch (error) {
    console.warn("[AuthSession] Local sign-out fallback failed:", error);
  } finally {
    clearPersistedGcpBackendAuthSession(client);
  }
}

export function broadcastAuthEvent(reason: AuthSessionReason) {
  if (typeof window === "undefined") {
    return;
  }

  const payload: AuthBroadcastEvent = {
    at: Date.now(),
    reason,
  };

  try {
    window.localStorage.setItem(AUTH_EVENT_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("[AuthSession] Failed to broadcast auth event:", error);
  }
}

export function parseAuthBroadcastEvent(
  rawValue: string | null
): AuthBroadcastEvent | null {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<AuthBroadcastEvent>;
    if (
      typeof parsed?.at === "number" &&
      typeof parsed?.reason === "string"
    ) {
      return parsed as AuthBroadcastEvent;
    }
  } catch (error) {
    console.warn("[AuthSession] Failed to parse auth event:", error);
  }

  return null;
}
