/**
 * Plaid Link diagnostics — fire-and-forget client logger that ships
 * every notable financial-link / Plaid Link event to the
 * `plaid-diagnostics-log` GcpBackend edge function.
 *
 * Drop-in policy:
 * - Calls are non-blocking. We never await responses on the hot path.
 * - We never throw — diagnostics breaking should not break the flow.
 * - We never include PII (no email, no legal name, no bank credentials).
 * - We cluster events by `sessionId` so a full attempt can be replayed.
 *
 * Usage:
 *   import { logPlaidEvent, beginPlaidSession } from './plaidDiagnostics';
 *
 *   const sessionId = beginPlaidSession();
 *   logPlaidEvent('page_mount', { plaidStep: 'idle' });
 */
import { getAuthenticatedSession } from "../../auth/session";
import config from "../../resources/config/config";

const SESSION_STORAGE_KEY = "hushh:plaid_link_diag_session";

const generateUuid = (): string => {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for very old browsers — collision risk is negligible here.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

const safeSessionRead = (): string | null => {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
};

const safeSessionWrite = (value: string) => {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, value);
  } catch {
    // sessionStorage unavailable (private browsing) — silently skip.
  }
};

/**
 * Start (or restore) a logging session. Call once on financial-link
 * mount. All subsequent `logPlaidEvent` calls in the same tab will share
 * the returned sessionId so a single user attempt clusters together.
 */
export function beginPlaidSession(): string {
  const existing = safeSessionRead();
  if (existing) return existing;
  const next = generateUuid();
  safeSessionWrite(next);
  return next;
}

/** Wipe the current diagnostic session — call after a successful Plaid
 *  Link completion so the next attempt starts clean. */
export function endPlaidSession(): void {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

const captureBrowserContext = (): Record<string, unknown> => {
  if (typeof window === "undefined") return {};
  try {
    return {
      userAgent: navigator.userAgent?.slice(0, 256) ?? null,
      language: navigator.language ?? null,
      languages: Array.isArray(navigator.languages)
        ? navigator.languages.slice(0, 5)
        : null,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      devicePixelRatio: window.devicePixelRatio ?? null,
      online: typeof navigator.onLine === "boolean" ? navigator.onLine : null,
      timezone:
        Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    };
  } catch {
    return {};
  }
};

const capturePageState = (extras: Record<string, unknown> = {}): Record<string, unknown> => {
  if (typeof window === "undefined") return extras;
  try {
    const search = window.location.search || "";
    const params = new URLSearchParams(search);
    return {
      pathname: window.location.pathname,
      search,
      hash: window.location.hash || null,
      hasOAuthStateId: params.has("oauth_state_id"),
      isReviewMode: params.get("mode") === "review",
      ...extras,
    };
  } catch {
    return extras;
  }
};

const getFunctionsUrl = (): string | null => {
  if (!config.GCP_API_BASE_URL) return null;
  return `${config.GCP_API_BASE_URL}/functions/v1`;
};

const getAuthHeader = async (): Promise<Record<string, string>> => {
  try {
    if (!config.gcpBackendClient) return {};
    const session = await getAuthenticatedSession(config.gcpBackendClient);
    if (session?.access_token) {
      return { Authorization: `Bearer ${session.access_token}` };
    }
  } catch {
    // Unauthenticated visitor on financial-link is fine — we log anonymously.
  }
  return {};
};

export interface PlaidDiagnosticPayload {
  /** Hook step machine state if known. */
  plaidStep?: string;
  /** Plaid SDK metadata (institution, accounts, exit code). */
  plaidMetadata?: Record<string, unknown>;
  /** Error capture: { message, stack, code, source }. */
  errorDetails?: Record<string, unknown>;
  /** Extra context to attach to page_state. */
  pageState?: Record<string, unknown>;
  /** Explicit userId override (rare; we usually derive from JWT). */
  userId?: string | null;
}

/**
 * Fire-and-forget logger. Never awaits, never throws to the caller.
 */
export function logPlaidEvent(
  eventType: string,
  payload: PlaidDiagnosticPayload = {},
): void {
  if (typeof window === "undefined") return;
  const functionsUrl = getFunctionsUrl();
  if (!functionsUrl) return;

  const sessionId = beginPlaidSession();
  const browser = captureBrowserContext();
  const pageState = capturePageState(payload.pageState);

  // Use queueMicrotask + dynamic fetch so we don't block React rendering.
  queueMicrotask(async () => {
    try {
      const headers = await getAuthHeader();
      await fetch(`${functionsUrl}/plaid-diagnostics-log`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        keepalive: true,
        body: JSON.stringify({
          session_id: sessionId,
          user_id: payload.userId ?? null,
          event_type: eventType,
          plaid_step: payload.plaidStep ?? null,
          plaid_metadata: payload.plaidMetadata ?? {},
          error_details: payload.errorDetails ?? {},
          page_state: pageState,
          browser_context: browser,
        }),
      });
    } catch {
      // Diagnostics are lossy-OK. Console only.
      // eslint-disable-next-line no-console
      console.warn("[plaidDiagnostics] log failed", eventType);
    }
  });
}

/**
 * Install a one-shot window error listener that captures errors thrown
 * by Plaid's CDN scripts (e.g., the famous `findScriptTag` failure that
 * surfaces when our React component unmounts mid-OAuth). Idempotent —
 * safe to call from multiple components.
 */
let globalListenerInstalled = false;
export function installGlobalPlaidErrorListener(): void {
  if (typeof window === "undefined") return;
  if (globalListenerInstalled) return;
  globalListenerInstalled = true;

  window.addEventListener("error", (event: ErrorEvent) => {
    const source = String(event.filename || "");
    const message = String(event.message || "");
    const isPlaidCdn =
      source.includes("cdn.plaid.com") ||
      source.includes("plaid.com/link") ||
      message.toLowerCase().includes("plaid");
    if (!isPlaidCdn) return;
    logPlaidEvent("uncaught_plaid_error", {
      errorDetails: {
        message: message.slice(0, 512),
        source: source.slice(0, 512),
        lineNumber: event.lineno ?? null,
        columnNumber: event.colno ?? null,
        stack: event.error?.stack
          ? String(event.error.stack).slice(0, 2048)
          : null,
      },
    });
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason = String(event.reason || "");
    if (!reason.toLowerCase().includes("plaid")) return;
    logPlaidEvent("unhandled_plaid_rejection", {
      errorDetails: {
        message: reason.slice(0, 512),
        stack: (event.reason as any)?.stack
          ? String((event.reason as any).stack).slice(0, 2048)
          : null,
      },
    });
  });
}
