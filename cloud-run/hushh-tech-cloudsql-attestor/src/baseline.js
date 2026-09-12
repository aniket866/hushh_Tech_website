import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASELINE_URL = new URL("../contracts/attestation-baseline.v1.json", import.meta.url);
const EXPECTED_SOURCE_SHA256 =
  "a924487ab2660d2f7aa9226111a53de6539c590b52db4b2f2971bebc1ef774618";
const CATALOG_KEYS = Object.freeze([
  "publicTables",
  "publicSequences",
  "publicTriggers",
  "explicitIndexes",
  "forcedRlsTables",
  "publicPolicies",
  "operationalPolicies",
  "executorPolicies",
  "reviewedExtensions",
  "identityFunctions",
  "migrationFunctions",
  "triggerFunctions",
]);

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function loadBaseline() {
  const baseline = JSON.parse(readFileSync(fileURLToPath(BASELINE_URL), "utf8"));
  if (
    !exactKeys(baseline, [
      "version",
      "kind",
      "sourceArtifact",
      "sourceExpectedSha256",
      "target",
      "expectedCatalog",
      "policyEvidence",
      "reviewedExtensions",
    ]) ||
    baseline.version !== 1 ||
    baseline.kind !== "HUSHH_TECH_UAT_CLOUDSQL_ATTESTATION_BASELINE" ||
    baseline.sourceArtifact !==
      "migration/cloud-run/hushh-tech-schema-data-verifier-uat/expected-manifest.v1.json" ||
    baseline.sourceExpectedSha256 !== EXPECTED_SOURCE_SHA256 ||
    !exactKeys(baseline.target, ["project", "region", "instance", "database"]) ||
    JSON.stringify(baseline.target) !==
      JSON.stringify({
        project: "hushh-tech-uat",
        region: "us-central1",
        instance: "hushh-tech-app-pg-uat",
        database: "hushh_tech_app",
      }) ||
    !exactKeys(baseline.expectedCatalog, CATALOG_KEYS) ||
    CATALOG_KEYS.some(
      (key) => !Number.isSafeInteger(baseline.expectedCatalog[key]) || baseline.expectedCatalog[key] < 0,
    ) ||
    !Array.isArray(baseline.reviewedExtensions) ||
    baseline.reviewedExtensions.join(",") !== "pgcrypto,uuid-ossp,vector" ||
    !exactKeys(baseline.policyEvidence, ["public", "operational"]) ||
    !exactKeys(baseline.policyEvidence.public, ["mode", "expectedCount"]) ||
    !exactKeys(baseline.policyEvidence.operational, ["mode", "expectedCount"]) ||
    baseline.policyEvidence.public.mode !== "aggregate-only" ||
    baseline.policyEvidence.operational.mode !== "aggregate-only" ||
    baseline.policyEvidence.public.expectedCount !== baseline.expectedCatalog.publicPolicies ||
    baseline.policyEvidence.operational.expectedCount !== baseline.expectedCatalog.operationalPolicies
  ) {
    throw new Error("ATTESTATION_BASELINE_INVALID");
  }
  return Object.freeze(baseline);
}

export function compareBaseline(observed, baseline = loadBaseline()) {
  if (!exactKeys(observed, CATALOG_KEYS)) throw new Error("BASELINE_OBSERVATION_INVALID");
  const matched = [];
  const drifted = [];
  for (const key of CATALOG_KEYS) {
    if (observed[key] === baseline.expectedCatalog[key]) matched.push(key);
    else drifted.push({ key, expected: baseline.expectedCatalog[key], observed: observed[key] });
  }
  return Object.freeze({
    status: drifted.length === 0 ? "ATTESTED" : "BLOCKED",
    sourceArtifact: baseline.sourceArtifact,
    sourceExpectedSha256: baseline.sourceExpectedSha256,
    expected: baseline.expectedCatalog,
    observed,
    matched,
    missing: [],
    drifted,
    unexpected: [],
  });
}

export function classifyObjects(expected, observed, key = (value) => value.name) {
  if (!Array.isArray(expected) || !Array.isArray(observed)) {
    throw new Error("OBJECT_BASELINE_INVALID");
  }
  const expectedByKey = new Map(expected.map((value) => [key(value), value]));
  const observedByKey = new Map(observed.map((value) => [key(value), value]));
  if (expectedByKey.size !== expected.length || observedByKey.size !== observed.length) {
    throw new Error("OBJECT_BASELINE_DUPLICATE_KEY");
  }
  const matched = [];
  const missing = [];
  const drifted = [];
  const unexpected = [];
  for (const [name, expectedValue] of expectedByKey) {
    const observedValue = observedByKey.get(name);
    if (!observedValue) missing.push(name);
    else if (canonicalJson(expectedValue) === canonicalJson(observedValue)) matched.push(name);
    else drifted.push(name);
  }
  for (const name of observedByKey.keys()) {
    if (!expectedByKey.has(name)) unexpected.push(name);
  }
  return Object.freeze({ matched, missing, drifted, unexpected });
}
