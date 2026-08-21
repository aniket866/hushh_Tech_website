import { createHash } from "node:crypto";

import { google } from "googleapis";

const FIRESTORE_PROJECT_ID = "hushh-tech-uat";
const FIRESTORE_DATABASE_ID = "(default)";
const FIRESTORE_COLLECTION = "hushh_research_export_consumptions";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export class HushhResearchReplayStoreError extends Error {
  constructor(code) {
    super(
      code === "export_replay_detected"
        ? "This encrypted Research export was already consumed."
        : "The encrypted Research export could not be consumed.",
    );
    this.name = "HushhResearchReplayStoreError";
    this.code = code;
  }
}

function unavailable() {
  return new HushhResearchReplayStoreError("replay_store_unavailable");
}

function replayDocumentId(replayKey) {
  return createHash("sha256").update(replayKey, "utf8").digest("hex");
}

async function defaultAccessToken() {
  const auth = new google.auth.GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  const client = await auth.getClient();
  const result = await client.getAccessToken();
  const token = typeof result === "string" ? result : result?.token;
  if (!token) throw unavailable();
  return token;
}

/**
 * Creates an atomic, cross-instance replay-consumption ledger backed by the
 * existing hushh-tech-uat default Firestore database. Firestore's
 * createDocument precondition is the lock: the same deterministic document ID
 * can be created once and returns HTTP 409 on every later attempt.
 */
export function createHushhResearchExportReplayStore({
  env = process.env,
  fetchImpl = globalThis.fetch,
  getAccessToken = defaultAccessToken,
} = {}) {
  return Object.freeze({
    async consume(replayKey, expiresAtMs, nowMs = Date.now()) {
      if (
        String(env.GOOGLE_CLOUD_PROJECT ?? "").trim() !== FIRESTORE_PROJECT_ID ||
        String(env.NODE_ENV ?? "").trim().toLowerCase() === "production" ||
        typeof replayKey !== "string" ||
        replayKey.length < 1 ||
        !Number.isSafeInteger(nowMs) ||
        !Number.isSafeInteger(expiresAtMs) ||
        expiresAtMs <= nowMs ||
        typeof fetchImpl !== "function"
      ) {
        throw unavailable();
      }

      const keyHash = replayDocumentId(replayKey);
      const collection = encodeURIComponent(FIRESTORE_COLLECTION);
      const documentId = encodeURIComponent(keyHash);
      const url =
        `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}` +
        `/databases/${FIRESTORE_DATABASE_ID}/documents/${collection}` +
        `?documentId=${documentId}`;

      try {
        const token = await getAccessToken();
        if (typeof token !== "string" || !token) throw unavailable();
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            fields: {
              replay_key_sha256: { stringValue: keyHash },
              consumed_at: { timestampValue: new Date(nowMs).toISOString() },
              expires_at: {
                timestampValue: new Date(expiresAtMs).toISOString(),
              },
            },
          }),
        });

        if (response?.status === 409) {
          throw new HushhResearchReplayStoreError("export_replay_detected");
        }
        if (!response?.ok) throw unavailable();
      } catch (error) {
        if (error instanceof HushhResearchReplayStoreError) throw error;
        throw unavailable();
      }
    },
  });
}

export const HUSHH_RESEARCH_REPLAY_FIRESTORE = Object.freeze({
  projectId: FIRESTORE_PROJECT_ID,
  databaseId: FIRESTORE_DATABASE_ID,
  collection: FIRESTORE_COLLECTION,
});
