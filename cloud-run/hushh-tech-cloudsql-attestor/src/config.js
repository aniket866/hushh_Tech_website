import {
  EXPECTED_EXECUTION_CONTRACT_SHA256,
  EXPECTED_QUERY_SET_SHA256,
  EXPECTED_SOURCE_SHA256,
  TARGET,
} from "./constants.js";
import { AttestorError } from "./errors.js";

export const ENV = Object.freeze({
  execute: "HUSHH_TECH_CLOUDSQL_ATTESTOR_EXECUTE",
  project: "HUSHH_TECH_CLOUDSQL_ATTESTOR_PROJECT",
  region: "HUSHH_TECH_CLOUDSQL_ATTESTOR_REGION",
  instance: "HUSHH_TECH_CLOUDSQL_ATTESTOR_INSTANCE",
  database: "HUSHH_TECH_CLOUDSQL_ATTESTOR_DATABASE",
  user: "HUSHH_TECH_CLOUDSQL_ATTESTOR_IAM_DB_USER",
  approvedContract: "HUSHH_TECH_CLOUDSQL_ATTESTOR_APPROVED_CONTRACT_SHA256",
  approvedQuerySet: "HUSHH_TECH_CLOUDSQL_ATTESTOR_APPROVED_QUERY_SET_SHA256",
  approvedSource: "HUSHH_TECH_CLOUDSQL_ATTESTOR_APPROVED_SOURCE_SHA256",
  imageDigest: "HUSHH_TECH_CLOUDSQL_ATTESTOR_IMAGE_DIGEST",
});

const FORBIDDEN_CREDENTIAL_ENV = Object.freeze([
  "PGPASSWORD",
  "PGPASSFILE",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGHOST",
  "PGHOSTADDR",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGOPTIONS",
  "PGSSLMODE",
  "PGSSLKEY",
  "PGSSLCERT",
  "PGSSLROOTCERT",
  "PGSSLCRL",
  "PGREQUIREPEER",
  "PGCHANNELBINDING",
  "PGCONNECT_TIMEOUT",
  "PGAPPNAME",
  "DATABASE_URL",
  "DB_PASSWORD",
  "CLOUD_SQL_PASSWORD",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "HUSHH_TECH_CLOUDSQL_ATTESTOR_PASSWORD",
  "HUSHH_TECH_CLOUDSQL_ATTESTOR_SECRET",
  "HUSHH_TECH_CLOUDSQL_ATTESTOR_TOKEN",
  "HUSHH_TECH_CLOUDSQL_ATTESTOR_PRIVATE_KEY",
  "HUSHH_TECH_CLOUDSQL_ATTESTOR_HOST",
  "HUSHH_TECH_CLOUDSQL_ATTESTOR_PORT",
  "HUSHH_TECH_CLOUDSQL_ATTESTOR_URL",
]);

const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function assertNoCredentialEnv(env) {
  if (FORBIDDEN_CREDENTIAL_ENV.some((key) => env[key] !== undefined)) {
    throw new AttestorError("FORBIDDEN_CREDENTIAL_ENV");
  }
}

function assertExactWhenPresent(env, key, expected) {
  if (env[key] !== undefined && env[key] !== expected) {
    throw new AttestorError("TARGET_BOUNDARY_VIOLATION");
  }
}

export function parseConfig(env = {}) {
  assertNoCredentialEnv(env);
  assertExactWhenPresent(env, ENV.project, TARGET.project);
  assertExactWhenPresent(env, ENV.region, TARGET.region);
  assertExactWhenPresent(env, ENV.instance, TARGET.instance);
  assertExactWhenPresent(env, ENV.database, TARGET.database);
  assertExactWhenPresent(env, ENV.user, TARGET.auditIamDatabaseUser);

  const gate = env[ENV.execute] ?? "false";
  if (gate !== "false" && gate !== "true") {
    throw new AttestorError("TARGET_BOUNDARY_VIOLATION");
  }
  const execute = gate === "true";
  if (!execute) {
    return Object.freeze({ execute: false, target: TARGET, imageDigest: null });
  }

  const requiredTarget = [ENV.project, ENV.region, ENV.instance, ENV.database, ENV.user];
  if (requiredTarget.some((key) => env[key] === undefined)) {
    throw new AttestorError("TARGET_BOUNDARY_VIOLATION");
  }
  if (
    env[ENV.approvedContract] !== EXPECTED_EXECUTION_CONTRACT_SHA256 ||
    env[ENV.approvedQuerySet] !== EXPECTED_QUERY_SET_SHA256 ||
    env[ENV.approvedSource] !== EXPECTED_SOURCE_SHA256
  ) {
    throw new AttestorError("ACTIVATION_CONTRACT_MISMATCH");
  }
  if (!IMAGE_DIGEST_PATTERN.test(env[ENV.imageDigest] ?? "")) {
    throw new AttestorError("IMAGE_DIGEST_REQUIRED");
  }

  return Object.freeze({
    execute: true,
    target: TARGET,
    imageDigest: env[ENV.imageDigest],
  });
}
