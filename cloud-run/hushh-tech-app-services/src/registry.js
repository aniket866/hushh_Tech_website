import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const REGISTRY_URL = new URL("../registry/functions.v1.json", import.meta.url);
const REGISTRY_VERSION = 1;
const REGISTRY_COUNT = 112;
const REGISTRY_DIGEST =
  "76737491439f7898cb488125c3630ae605a666018848181fe88fc2916d22bbb3";
const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

const OWNER_GROUP_COUNTS = Object.freeze({
  "content-api": 10,
  "engagement-api-worker": 16,
  "financial-api-worker": 48,
  "identity-api": 10,
  "investor-api": 21,
  "security-retirement": 1,
  "signed-webhook-service": 6,
});

const AUTH_MODES = new Set([
  "firebase_bearer",
  "firebase_bearer_or_google_service_identity",
  "firebase_bearer_recent_auth",
  "firebase_bearer_recent_auth_or_google_service_identity",
  "provider_signature_raw_body",
  "none_feature_retired",
]);

const SERVICE_RULES = Object.freeze({
  "investor-api": Object.freeze({
    actor: "firebase",
    ownerGroups: Object.freeze(["investor-api"]),
  }),
  "identity-api": Object.freeze({
    actor: "firebase",
    ownerGroups: Object.freeze(["identity-api", "security-retirement"]),
  }),
  "financial-api": Object.freeze({
    actor: "firebase",
    ownerGroups: Object.freeze(["financial-api-worker"]),
  }),
  "content-api": Object.freeze({
    actor: "firebase",
    ownerGroups: Object.freeze(["content-api"]),
  }),
  "engagement-api-worker": Object.freeze({
    actor: "firebase",
    ownerGroups: Object.freeze(["engagement-api-worker"]),
  }),
  "signed-webhook-service": Object.freeze({
    actor: "webhook",
    ownerGroups: Object.freeze(["signed-webhook-service"]),
  }),
  worker: Object.freeze({
    actor: "google-worker",
    ownerGroups: Object.freeze([
      "financial-api-worker",
      "engagement-api-worker",
    ]),
  }),
});

function canonicalDigest(entries) {
  return createHash("sha256")
    .update(JSON.stringify(entries), "utf8")
    .digest("hex");
}

function assertEntry(entry, index, slugs, counts) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Registry entry ${index} must be an object.`);
  }
  const requiredFields = [
    "slug",
    "owner_group",
    "auth_mode",
    "migration_state",
    "final_disposition",
  ];
  for (const field of requiredFields) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      throw new Error(`Registry entry ${index} is missing ${field}.`);
    }
  }
  if (!SLUG_PATTERN.test(entry.slug) || slugs.has(entry.slug)) {
    throw new Error(`Registry slug ${entry.slug} is invalid or duplicated.`);
  }
  slugs.add(entry.slug);
  if (!(entry.owner_group in OWNER_GROUP_COUNTS)) {
    throw new Error(`Registry owner for ${entry.slug} is not allowlisted.`);
  }
  counts[entry.owner_group] = (counts[entry.owner_group] ?? 0) + 1;
  if (!AUTH_MODES.has(entry.auth_mode)) {
    throw new Error(`Registry auth mode for ${entry.slug} is not allowlisted.`);
  }

  if (entry.final_disposition === "RETIRE_WITH_410") {
    if (
      entry.slug !== "get-secrets" ||
      entry.owner_group !== "security-retirement" ||
      entry.auth_mode !== "none_feature_retired"
    ) {
      throw new Error("Only the secret-disclosure tombstone may be retired.");
    }
    return;
  }

  if (
    entry.final_disposition !== "PORT_TO_GCP" ||
    entry.migration_state !== "INVENTORY_FROZEN"
  ) {
    throw new Error(
      `Registry entry ${entry.slug} is not frozen for unverified migration.`,
    );
  }
}

export function validateRegistry(entries) {
  if (!Array.isArray(entries) || entries.length !== REGISTRY_COUNT) {
    throw new Error(`Registry must contain exactly ${REGISTRY_COUNT} entries.`);
  }
  if (canonicalDigest(entries) !== REGISTRY_DIGEST) {
    throw new Error("Registry digest does not match the frozen inventory.");
  }

  const slugs = new Set();
  const counts = Object.create(null);
  entries.forEach((entry, index) => assertEntry(entry, index, slugs, counts));
  for (const [ownerGroup, expected] of Object.entries(OWNER_GROUP_COUNTS)) {
    if (counts[ownerGroup] !== expected) {
      throw new Error(
        `Registry owner ${ownerGroup} must contain exactly ${expected} entries.`,
      );
    }
  }
  return true;
}

const parsedRegistry = JSON.parse(readFileSync(REGISTRY_URL, "utf8"));
validateRegistry(parsedRegistry);

export const LEGACY_FUNCTIONS = Object.freeze(
  parsedRegistry.map((entry) => Object.freeze({ ...entry })),
);

export const LEGACY_FUNCTION_REGISTRY = Object.freeze(
  Object.fromEntries(LEGACY_FUNCTIONS.map((entry) => [entry.slug, entry])),
);

export function getLegacyFunction(slug) {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) return null;
  return LEGACY_FUNCTION_REGISTRY[slug] ?? null;
}

export function serviceRule(serviceOwner) {
  return SERVICE_RULES[serviceOwner] ?? null;
}

export function serviceOwnsEntry(serviceOwner, entry) {
  const rule = serviceRule(serviceOwner);
  if (!rule || !entry || !rule.ownerGroups.includes(entry.owner_group)) {
    return false;
  }
  if (serviceOwner === "worker") {
    return entry.auth_mode.includes("google_service_identity");
  }
  return true;
}

export const REGISTRY_METADATA = Object.freeze({
  version: REGISTRY_VERSION,
  count: REGISTRY_COUNT,
  digest: REGISTRY_DIGEST,
  ownerGroupCounts: OWNER_GROUP_COUNTS,
});
