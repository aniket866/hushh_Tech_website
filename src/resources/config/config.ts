import { normalizeOAuthRedirectUrl } from "../../auth/authHost";
import { getOAuthRedirectUrl } from "../../utils/platform";
import { createGcpBackendClient } from "../../services/gcpBackend/client";
import type { GcpBackendClient } from "../../services/gcpBackend/types";

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
): Config {
  const apiBase = (env.VITE_GCP_API_BASE_URL || "").trim().replace(/\/$/, "");
  const base: Config = {
    GCP_API_BASE_URL: apiBase,
    redirect_url: normalizeOAuthRedirectUrl(
      env.VITE_GCP_AUTH_REDIRECT_URL,
      fallbackRedirectUrl,
    ),
  };

  const apiKey = readClientEnv(env.VITE_FIREBASE_API_KEY, "VITE_FIREBASE_API_KEY");
  const authDomain = readClientEnv(env.VITE_FIREBASE_AUTH_DOMAIN, "VITE_FIREBASE_AUTH_DOMAIN");
  const projectId = readClientEnv(env.VITE_FIREBASE_PROJECT_ID, "VITE_FIREBASE_PROJECT_ID");
  const appId = readClientEnv(env.VITE_FIREBASE_APP_ID, "VITE_FIREBASE_APP_ID");
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

const config = buildClientConfig(import.meta.env);
export default config;
