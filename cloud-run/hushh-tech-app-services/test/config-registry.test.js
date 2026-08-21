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

test("all seven owners bind to their exact UAT runtime database identity", () => {
  assert.equal(SERVICE_OWNERS.length, 7);
  for (const serviceOwner of SERVICE_OWNERS) {
    const config = readRuntimeConfig(
      runtimeEnv({
        SERVICE_OWNER: serviceOwner,
        SERVICE_AUDIENCE: `https://${SERVICE_NAMES[serviceOwner]}-175298245599.us-central1.run.app`,
        PGUSER: `${ACCOUNT_STEMS[serviceOwner]}-uat@hushh-tech-uat.iam`,
      }),
    );
    assert.equal(config.serviceOwner, serviceOwner);
    assert.equal(config.databaseUser, `${ACCOUNT_STEMS[serviceOwner]}-uat@hushh-tech-uat.iam`);
    assert.ok(serviceRule(serviceOwner));
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
  ];
  for (const change of changes) {
    assert.throws(() => readRuntimeConfig(runtimeEnv(change)), ConfigurationError);
  }
});

test("frozen registry is exact and enables no function", () => {
  assert.equal(validateRegistry(LEGACY_FUNCTIONS), true);
  assert.equal(LEGACY_FUNCTIONS.length, 112);
  assert.equal(REGISTRY_METADATA.count, 112);
  assert.equal(
    REGISTRY_METADATA.digest,
    "76737491439f7898cb488125c3630ae605a666018848181fe88fc2916d22bbb3",
  );
  assert.equal(new Set(LEGACY_FUNCTIONS.map(({ slug }) => slug)).size, 112);
  assert.equal(
    LEGACY_FUNCTIONS.filter(
      ({ migration_state }) => migration_state === "PORTED_AND_VERIFIED",
    ).length,
    0,
  );
  assert.equal(
    LEGACY_FUNCTIONS.filter(
      ({ migration_state }) => migration_state === "INVENTORY_FROZEN",
    ).length,
    112,
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
});

test("each registry entry belongs only to its locked service surface", () => {
  for (const entry of LEGACY_FUNCTIONS) {
    const owners = SERVICE_OWNERS.filter((owner) => serviceOwnsEntry(owner, entry));
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
  assert.equal(LEGACY_FUNCTION_REGISTRY["get-secrets"].auth_mode, "none_feature_retired");
});

test("registry tampering fails digest validation", () => {
  const altered = LEGACY_FUNCTIONS.map((entry) => ({ ...entry }));
  altered[0].owner_group = "identity-api";
  assert.throws(() => validateRegistry(altered), /digest/);
});
