import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigurationError,
  readRuntimeConfig,
  SERVICE_OWNERS,
} from "../src/config.js";
import {
  LEGACY_FUNCTIONS,
  LEGACY_FUNCTION_REGISTRY,
  REGISTRY_METADATA,
  serviceOwnsEntry,
  serviceRule,
  validateRegistry,
} from "../src/registry.js";
import { runtimeEnv } from "./helpers.js";

const ACCOUNT_STEMS = Object.freeze({
  "investor-api": "hushh-tech-investor-api",
  "identity-api": "hushh-tech-identity-api",
  "financial-api": "hushh-tech-financial-api",
  "content-api": "hushh-tech-content-api",
  "engagement-api-worker": "hushh-tech-engagement-api",
  "signed-webhook-service": "hushh-tech-webhooks",
  worker: "hushh-tech-worker",
});
const SERVICE_NAMES = Object.freeze({
  "investor-api": "hushh-tech-investor-api",
  "identity-api": "hushh-tech-identity-api",
  "financial-api": "hushh-tech-financial-api",
  "content-api": "hushh-tech-content-api",
  "engagement-api-worker": "hushh-tech-engagement-api",
  "signed-webhook-service": "hushh-tech-webhooks",
  worker: "hushh-tech-worker",
});
const PROJECTS = Object.freeze({
  uat: Object.freeze({
    id: "hushh-tech-uat",
    number: "175298245599",
    audience: "hushh-tech-uat",
    instance: "hushh-tech-uat:us-central1:hushh-tech-app-pg-uat",
  }),
  prod: Object.freeze({
    id: "hushh-tech-prod",
    number: "646258530541",
    audience: "hushh-tech-prod",
    instance: "hushh-tech-prod:us-central1:hushh-tech-app-pg-prod",
  }),
});

function expectedCaller(serviceOwner, stage, projectId) {
  const account =
    serviceOwner === "worker"
      ? `hushh-tech-task-runner-${stage}`
      : `hushh-tech-web-${stage}`;
  return `${account}@${projectId}.iam.gserviceaccount.com`;
}

function ownerRuntimeEnv(serviceOwner, stage, overrides = {}) {
  const project = PROJECTS[stage];
  return runtimeEnv({
    SERVICE_OWNER: serviceOwner,
    GOOGLE_CLOUD_PROJECT: project.id,
    SERVICE_AUDIENCE: `https://${SERVICE_NAMES[serviceOwner]}-${project.number}.us-central1.run.app`,
    ALLOWED_GOOGLE_CALLERS: expectedCaller(serviceOwner, stage, project.id),
    FIREBASE_PROJECT_ID: project.id,
    PRODUCT_AUDIENCE: project.audience,
    INSTANCE_CONNECTION_NAME: project.instance,
    PGUSER: `${ACCOUNT_STEMS[serviceOwner]}-${stage}@${project.id}.iam`,
    ...overrides,
  });
}

test("all seven owners bind to their exact UAT and production identities", () => {
  assert.equal(SERVICE_OWNERS.length, 7);
  for (const stage of Object.keys(PROJECTS)) {
    const project = PROJECTS[stage];
    for (const serviceOwner of SERVICE_OWNERS) {
      const config = readRuntimeConfig(ownerRuntimeEnv(serviceOwner, stage));
      assert.equal(config.serviceOwner, serviceOwner);
      assert.equal(
        config.databaseUser,
        `${ACCOUNT_STEMS[serviceOwner]}-${stage}@${project.id}.iam`,
      );
      assert.equal(config.firebaseProjectId, project.id);
      assert.deepEqual(config.allowedGoogleCallers, [
        expectedCaller(serviceOwner, stage, project.id),
      ]);
      assert.equal(config.handlerDeadlineMs, 20_000);
      assert.equal(config.databaseStatementTimeoutMs, 15_000);
      assert.ok(config.databaseStatementTimeoutMs < config.handlerDeadlineMs);
      assert.ok(serviceRule(serviceOwner));
    }
  }
});

test("every owner rejects missing, extra, cross-project, and wrong-role callers", () => {
  for (const stage of Object.keys(PROJECTS)) {
    const project = PROJECTS[stage];
    const otherStage = stage === "uat" ? "prod" : "uat";
    const otherProject = PROJECTS[otherStage];
    for (const serviceOwner of SERVICE_OWNERS) {
      const exact = expectedCaller(serviceOwner, stage, project.id);
      const wrongRole =
        serviceOwner === "worker"
          ? expectedCaller("identity-api", stage, project.id)
          : expectedCaller("worker", stage, project.id);
      const invalidCallers = [
        "",
        `${exact},${wrongRole}`,
        expectedCaller(serviceOwner, otherStage, otherProject.id),
        wrongRole,
        `unexpected@${project.id}.iam.gserviceaccount.com`,
      ];
      for (const caller of invalidCallers) {
        assert.throws(
          () =>
            readRuntimeConfig(
              ownerRuntimeEnv(serviceOwner, stage, {
                ALLOWED_GOOGLE_CALLERS: caller,
              }),
            ),
          ConfigurationError,
        );
      }
    }
  }
});

test("configuration rejects environment, authority, ingress, and database drift", () => {
  const changes = [
    { SERVICE_OWNER: "unknown" },
    { GOOGLE_CLOUD_PROJECT: "hushh-tech-other" },
    { CLOUD_RUN_INGRESS_MODE: "all" },
    { PRIVATE_INGRESS_ENFORCED: "false" },
    { SERVICE_AUDIENCE: "https://example.com" },
    {
      SERVICE_AUDIENCE:
        "https://hushh-tech-investor-api-175298245599.us-central1.run.app",
    },
    {
      SERVICE_AUDIENCE:
        "https://hushh-tech-identity-api-646258530541.us-central1.run.app",
    },
    { FIREBASE_PROJECT_ID: "other-authority" },
    { PRODUCT_AUDIENCE: "hushh-tech-prod" },
    { PRODUCT_CLIENT_APP_ID: "other-app" },
    { INSTANCE_CONNECTION_NAME: "other:region:database" },
    { PGDATABASE: "postgres" },
    { PGUSER: "wrong@hushh-tech-uat.iam" },
    { DATABASE_URL: "postgresql://forbidden.invalid/database" },
    { PGPASSWORD: "not-allowed" },
    { ALLOWED_GOOGLE_CALLERS: "human@example.com" },
    { HANDLER_DEADLINE_MS: "1000" },
    {
      HANDLER_DEADLINE_MS: "15000",
      DB_STATEMENT_TIMEOUT_MS: "15000",
    },
  ];
  for (const change of changes) {
    assert.throws(
      () => readRuntimeConfig(runtimeEnv(change)),
      ConfigurationError,
    );
  }
});

test("public stock quotes require exact investor ownership and provider coupling", () => {
  const enabled = readRuntimeConfig(
    ownerRuntimeEnv("investor-api", "uat", {
      HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED: "true",
      FINNHUB_API_KEY: "test-key-not-a-secret",
      PUBLIC_STOCK_QUOTES_RATE_LIMIT: "17",
      PUBLIC_STOCK_QUOTES_PROVIDER_REQUESTS_PER_MINUTE: "2",
      FINNHUB_QUOTE_TIMEOUT_MS: "2500",
    }),
  );
  assert.equal(enabled.publicStockQuotesEnabled, true);
  assert.equal(enabled.publicStockQuotesRateLimit, 17);
  assert.equal(enabled.publicStockQuotesProviderRequestRateLimit, 2);
  assert.equal(enabled.finnhubQuoteTimeoutMs, 2500);
  assert.equal(enabled.finnhubApiKey, "test-key-not-a-secret");

  for (const invalid of [
    ownerRuntimeEnv("investor-api", "uat", {
      HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED: "true",
    }),
    ownerRuntimeEnv("investor-api", "uat", {
      FINNHUB_API_KEY: "test-key-not-a-secret",
    }),
    ownerRuntimeEnv("identity-api", "uat", {
      HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED: "true",
      FINNHUB_API_KEY: "test-key-not-a-secret",
    }),
    ownerRuntimeEnv("investor-api", "uat", {
      HUSHH_TECH_PUBLIC_STOCK_QUOTES_ENABLED: "yes",
      FINNHUB_API_KEY: "test-key-not-a-secret",
    }),
  ]) {
    assert.throws(() => readRuntimeConfig(invalid), ConfigurationError);
  }
});

test("registry enables only geocode and keeps NDA fail closed", () => {
  assert.equal(validateRegistry(LEGACY_FUNCTIONS), true);
  assert.equal(LEGACY_FUNCTIONS.length, 112);
  assert.equal(REGISTRY_METADATA.count, 112);
  assert.equal(
    REGISTRY_METADATA.digest,
    "00b022ae3eab4a559fb5e70a90f55283e738a5fa81ed34a2e1aafb20e8479d55",
  );
  assert.equal(new Set(LEGACY_FUNCTIONS.map(({ slug }) => slug)).size, 112);
  assert.deepEqual(
    LEGACY_FUNCTIONS.filter(
      ({ migration_state }) => migration_state === "PORTED_AND_VERIFIED",
    ).map(({ slug }) => slug),
    ["hushh-location-geocode"],
  );
  assert.equal(
    LEGACY_FUNCTIONS.filter(
      ({ migration_state }) => migration_state === "INVENTORY_FROZEN",
    ).length,
    111,
  );
  assert.equal(
    LEGACY_FUNCTIONS.filter(
      ({ final_disposition }) => final_disposition === "PORT_TO_GCP",
    ).length,
    111,
  );
  assert.deepEqual(
    LEGACY_FUNCTIONS.filter(
      ({ final_disposition }) => final_disposition === "RETIRE_WITH_410",
    ).map(({ slug }) => slug),
    ["get-secrets"],
  );
  assert.equal(
    LEGACY_FUNCTION_REGISTRY["hushh-location-geocode"].migration_state,
    "PORTED_AND_VERIFIED",
  );
  assert.equal(
    LEGACY_FUNCTION_REGISTRY["nda-admin-fetch"].migration_state,
    "INVENTORY_FROZEN",
  );
});

test("each registry entry belongs only to its locked service surface", () => {
  for (const entry of LEGACY_FUNCTIONS) {
    const owners = SERVICE_OWNERS.filter((owner) =>
      serviceOwnsEntry(owner, entry),
    );
    if (entry.owner_group === "financial-api-worker") {
      assert.deepEqual(owners.sort(), ["financial-api", "worker"]);
    } else if (entry.owner_group === "engagement-api-worker") {
      assert.deepEqual(owners.sort(), ["engagement-api-worker", "worker"]);
    } else if (entry.owner_group === "security-retirement") {
      assert.deepEqual(owners, ["identity-api"]);
    } else {
      assert.equal(owners.length, 1, entry.slug);
    }
  }
  assert.equal(
    LEGACY_FUNCTION_REGISTRY["get-secrets"].auth_mode,
    "none_feature_retired",
  );
});

test("registry tampering fails digest validation", () => {
  const altered = LEGACY_FUNCTIONS.map((entry) => ({ ...entry }));
  altered[0].owner_group = "identity-api";
  assert.throws(() => validateRegistry(altered), /digest/);
});
