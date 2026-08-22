import { createClient } from "@/services/gcpBackend/types";

const env = typeof import.meta !== "undefined" ? import.meta.env : {};

function readClientEnv(value, name, fallback = "") {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  console.error(`[Config] Missing required client environment variable: ${name}`);
  return fallback;
}

const config = {
  GCP_API_BASE_URL: readClientEnv(env?.VITE_GCP_API_BASE_URL, "VITE_GCP_API_BASE_URL"),
  FIREBASE_API_KEY: readClientEnv(env?.VITE_FIREBASE_API_KEY, "VITE_FIREBASE_API_KEY"),
  guestModeAccessToken: env?.VITE_GUEST_MODE_ACCESS_TOKEN || "",
  redirect_url:
    env?.VITE_GCP_AUTH_REDIRECT_URL ||
    (typeof window !== "undefined" ? `${window.location.origin}/auth/callback` : "https://www.hushhtech.com/auth/callback"),
};

function createGcpBackendClient() {
  if (!config.GCP_API_BASE_URL || !config.FIREBASE_API_KEY) {
    return undefined;
  }

  const gcpBackend = createClient(config.GCP_API_BASE_URL, config.FIREBASE_API_KEY);
  return gcpBackend;
}

config.gcpBackendClient = createGcpBackendClient();

export default config;
