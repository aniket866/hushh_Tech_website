import { GoogleAuth } from "google-auth-library";

import { RuntimeError } from "../errors.js";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const CLOUD_TASKS_API = "https://cloudtasks.googleapis.com/v2";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIREBASE_UID_LIMIT = 128;

export const UAT_FINANCIAL_SYNC_TASK_QUEUE =
  "projects/hushh-tech-uat/locations/us-central1/queues/financial-sync";
export const UAT_FINANCIAL_WORKER_AUDIENCE =
  "https://hushh-tech-worker-175298245599.us-central1.run.app";
export const UAT_FINANCIAL_TASK_RUNNER =
  "hushh-tech-task-runner-uat@hushh-tech-uat.iam.gserviceaccount.com";
export const FINANCIAL_SYNC_WORKER_PATH =
  "/api/v1/legacy-functions/plaid-data-sync-product";

function validFirebaseUid(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= FIREBASE_UID_LIMIT &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function responseJson(response) {
  return response?.json?.().catch(() => ({})) ?? Promise.resolve({});
}

function taskPublisherError(error) {
  if (error instanceof RuntimeError) return error;
  return new RuntimeError(
    "FINANCIAL_SYNC_QUEUE_UNAVAILABLE",
    "Financial sync is unavailable.",
    503,
    { cause: error, diagnosticCode: "CLOUD_TASKS_PUBLISH_FAILED" },
  );
}

export async function defaultGoogleCloudAccessToken() {
  const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  const client = await auth.getClient();
  const result = await client.getAccessToken();
  const token = typeof result === "string" ? result : result?.token;
  if (typeof token !== "string" || !token) {
    throw new Error("Google service access token unavailable.");
  }
  return token;
}

export function financialSyncTaskName(taskQueue, jobId) {
  const normalizedJobId = String(jobId ?? "").trim().toLowerCase();
  if (
    taskQueue !== UAT_FINANCIAL_SYNC_TASK_QUEUE ||
    !UUID_PATTERN.test(normalizedJobId)
  ) {
    throw new RuntimeError(
      "FINANCIAL_OUTBOX_RECORD_INVALID",
      "Financial outbox publisher is unavailable.",
      503,
      { diagnosticCode: "OUTBOX_TASK_ID_INVALID" },
    );
  }
  return `${taskQueue}/tasks/financial-sync-${normalizedJobId.replaceAll("-", "")}`;
}

/**
 * The request-time financial writer uses this exact Cloud Tasks envelope. A
 * 409 means the deterministic task name is already accepted and therefore
 * counts as an outbox publication success.
 */
export function createFinancialSyncTaskPublisher({
  taskQueue,
  workerAudience,
  taskRunnerServiceAccount,
  fetchImpl = globalThis.fetch,
  getAccessToken = defaultGoogleCloudAccessToken,
} = {}) {
  if (
    taskQueue !== UAT_FINANCIAL_SYNC_TASK_QUEUE ||
    workerAudience !== UAT_FINANCIAL_WORKER_AUDIENCE ||
    taskRunnerServiceAccount !== UAT_FINANCIAL_TASK_RUNNER ||
    typeof fetchImpl !== "function" ||
    typeof getAccessToken !== "function"
  ) {
    throw new Error("Cloud Tasks financial sync configuration is required.");
  }

  return Object.freeze({
    async publish({ jobId, taskName, firebaseUid, signal } = {}) {
      const expectedTaskName = financialSyncTaskName(taskQueue, jobId);
      if (taskName !== expectedTaskName || !validFirebaseUid(firebaseUid)) {
        throw new RuntimeError(
          "FINANCIAL_OUTBOX_RECORD_INVALID",
          "Financial outbox publisher is unavailable.",
          503,
          { diagnosticCode: "OUTBOX_TASK_PAYLOAD_INVALID" },
        );
      }
      try {
        const token = await getAccessToken();
        if (typeof token !== "string" || !token) throw new Error("token unavailable");
        const response = await fetchImpl(`${CLOUD_TASKS_API}/${taskQueue}/tasks`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            task: {
              name: expectedTaskName,
              httpRequest: {
                httpMethod: "POST",
                url: `${workerAudience}${FINANCIAL_SYNC_WORKER_PATH}`,
                headers: {
                  "content-type": "application/json",
                  "x-hushh-firebase-uid": firebaseUid,
                },
                body: Buffer.from(JSON.stringify({ jobId }), "utf8").toString("base64"),
                oidcToken: {
                  serviceAccountEmail: taskRunnerServiceAccount,
                  audience: workerAudience,
                },
              },
            },
          }),
          redirect: "error",
          signal,
        });
        if (response?.ok || response?.status === 409) return;
        await responseJson(response);
        throw new Error("Cloud Tasks rejected the task.");
      } catch (error) {
        throw taskPublisherError(error);
      }
    },
  });
}
