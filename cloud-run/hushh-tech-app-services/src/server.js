import { createApp } from "./app.js";
import { createFirebaseProductVerifier } from "./auth/firebase.js";
import { createGoogleServiceVerifier } from "./auth/google.js";
import { readRuntimeConfig } from "./config.js";
import {
  createDatabaseRuntime,
  verifyDmlOnlyRuntime,
} from "./database.js";
import { createWebhookVerifier } from "./webhooks.js";

const config = readRuntimeConfig();
const database = await createDatabaseRuntime({
  config,
  onPoolError: () => {
    console.error(
      JSON.stringify({
        level: "error",
        code: "DATABASE_POOL_ERROR",
        service_owner: config.serviceOwner,
      }),
    );
  },
});

const app = createApp({
  config,
  database,
  verifyGoogleServiceRequest: createGoogleServiceVerifier({ config }),
  verifyFirebaseProductRequest: createFirebaseProductVerifier({ config }),
  verifyWebhookRequest: createWebhookVerifier({ verifiers: {} }),
  verifyReadiness: () =>
    verifyDmlOnlyRuntime(database.pool, config.databaseUser),
  handlers: Object.freeze({}),
  log: (record) => console.log(JSON.stringify(record)),
});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      level: "info",
      code: "SERVICE_STARTED",
      service_owner: config.serviceOwner,
      port: config.port,
    }),
  );
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1_000;

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(
    JSON.stringify({
      level: "info",
      code: "SERVICE_STOPPING",
      service_owner: config.serviceOwner,
      signal,
    }),
  );
  const forceExit = setTimeout(() => process.exit(1), 9_000);
  forceExit.unref();
  server.closeIdleConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await database.close();
  clearTimeout(forceExit);
  process.exit(0);
}

process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));
