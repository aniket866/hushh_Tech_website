/**
 * Access tokens and a thin REST helper for the GCP admin APIs.
 *
 * There is no gcloud CLI in the deploy container, so the UAT deploy talks to Cloud Build, Cloud
 * Run Admin v2, GCS and Firestore over REST. Everything here is shared plumbing: mint a token
 * from the service-account key, and make an authenticated request that fails loudly with the
 * API's own error body rather than a bare status code.
 *
 * Credentials come from GCP_DEPLOY_SA_KEY_B64 (base64 service-account JSON) and are never
 * written to disk or logged.
 */

import { GoogleAuth } from "google-auth-library";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

let cached = null;

/**
 * Local runs may provide a short-lived, operator-owned key. Cloud Build runs with
 * its trigger service account and should use Application Default Credentials (ADC)
 * instead; a deploy key must never be copied into a build trigger or image.
 */
export const serviceAccount = () => {
  const encoded = process.env.GCP_DEPLOY_SA_KEY_B64;
  if (!encoded) return null;
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
};

/** Tokens last an hour; a build can outlive that, so re-mint when we are inside the last minute. */
export const accessToken = async () => {
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
  const credentials = serviceAccount();
  const options = { scopes: [SCOPE] };
  if (credentials) options.credentials = credentials;
  const auth = new GoogleAuth(options);
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("failed to mint an access token");
  cached = { token, expiresAt: Date.now() + 55 * 60_000 };
  return token;
};

/**
 * Authenticated fetch. `body` is JSON unless `raw` is set (GCS media uploads send bytes).
 * Non-2xx throws with the response body attached — GCP's errors are the useful part.
 */
export const api = async (url, { method = "GET", body, raw, headers = {}, expect = "json" } = {}) => {
  const token = await accessToken();
  const init = { method, headers: { Authorization: `Bearer ${token}`, ...headers } };
  if (raw !== undefined) {
    init.body = raw;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} ${url} → ${response.status}\n${text.slice(0, 2000)}`);
    error.status = response.status;
    error.bodyText = text;
    throw error;
  }
  if (expect === "text") return text;
  return text ? JSON.parse(text) : null;
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
