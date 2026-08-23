import { normalizeOAuthRedirectUrl } from "../../auth/authHost";
import { getOAuthRedirectUrl } from "../../utils/platform";
import { createGcpBackendClient } from "../../services/gcpBackend/client";
import type { GcpBackendClient } from "../../services/gcpBackend/types";
import { resolveNoHybridBrowserFixture } from "../../auth/noHybridBrowserFixture";
import { isHushhResearchAuthRoute } from "../../services/hushhResearch/contracts";

export interface ClientEnvConfig {
  VITE_FIREBASE_API_KEY?: string;
  VITE_FIREBASE_AUTH_DOMAIN?: string;
  VITE_FIREBASE_PROJECT_ID?: string;
  VITE_FIREBASE_STORAGE_BUCKET?: string;
  VITE_FIREBASE_APP_ID?: string;
  VITE_GCP_API_BASE_URL?: string;
  VITE_GCP_AUTH_REDIRECT_URL?: string;
  VITE_PLAID_REDIRECT_URI?: string;
  VITE_NDA_GENERATION_URL?: string;
}

interface Config {
  GCP_API_BASE_URL: string;
  redirect_url: string;
  gcpBackendClient?: GcpBackendClient;
}

function readClientEnv(value: string | undefined, name: string, fallback = ""): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  console.error(`[Config] Missing required client environment variable: ${name}`);
  return fallback;
}

export function buildClientConfig(
  env: ClientEnvConfig,
  fallbackRedirectUrl = getOAuthRedirectUrl(),
  pathname = "",
): Config {
  const apiBase = (env.VITE_GCP_API_BASE_URL || "").trim().replace(/\/$/, "");
  const base: Config = {
    GCP_API_BASE_URL: apiBase,
    redirect_url: normalizeOAuthRedirectUrl(
      env.VITE_GCP_AUTH_REDIRECT_URL,
      fallbackRedirectUrl,
    ),
  };

  // A Research launch uses its own Firebase authority. On a direct auth entry,
  // do not initialize the ordinary Hushh Tech client at all. If the user
  // reaches the route through SPA navigation, HushhResearchHardEntryGuard
  // performs one reload and this branch makes that reload a clean boundary.
  if (isHushhResearchAuthRoute(pathname)) {
    return base;
  }

  const browserFixture = resolveNoHybridBrowserFixture();
  const apiKey = browserFixture
    ? "no-hybrid-local-fixture-api-key"
    : readClientEnv(env.VITE_FIREBASE_API_KEY, "VITE_FIREBASE_API_KEY");
  const authDomain = browserFixture
    ? "hushh-tech-uat.firebaseapp.com"
    : readClientEnv(env.VITE_FIREBASE_AUTH_DOMAIN, "VITE_FIREBASE_AUTH_DOMAIN");
  const projectId = browserFixture
    ? "hushh-tech-uat"
    : readClientEnv(env.VITE_FIREBASE_PROJECT_ID, "VITE_FIREBASE_PROJECT_ID");
  const appId = browserFixture
    ? "no-hybrid-local-fixture-app"
    : readClientEnv(env.VITE_FIREBASE_APP_ID, "VITE_FIREBASE_APP_ID");
  if (apiKey && authDomain && projectId && appId) {
    base.gcpBackendClient = createGcpBackendClient({
      apiKey,
      authDomain,
      projectId,
      appId,
      storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET?.trim(),
    });
  }
  return base;
}

const config = buildClientConfig(
  import.meta.env,
  getOAuthRedirectUrl(),
  typeof window === "undefined" ? "" : window.location.pathname,
);
export default config;
