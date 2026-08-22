import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER_NAME = `hushh-tech-attestor-pg17-test-${process.pid}`;
const POSTGRES_IMAGE = "postgres:17-alpine";
const AUDIT_USER = "hushh-tech-audit-uat@hushh-tech-uat.iam";

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 1_048_576,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function psql(database, commands) {
  const args = [
    "exec",
    CONTAINER_NAME,
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    database,
  ];
  for (const command of commands) args.push("-c", command);
  return docker(args);
}

function captureChecks() {
  const output = docker([
    "exec",
    CONTAINER_NAME,
    "psql",
    "-X",
    "-q",
    "-v",
    "ON_ERROR_STOP=1",
    "-t",
    "-A",
    "-F",
    "|",
    "-U",
    "postgres",
    "-d",
    "hushh_tech_app",
    "-c",
    `SET ROLE "${AUDIT_USER}";`,
    "-c",
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;",
    "-c",
    "SET LOCAL statement_timeout = '10s';",
    "-c",
    "SET LOCAL lock_timeout = '1s';",
    "-c",
    "SET LOCAL idle_in_transaction_session_timeout = '15s';",
    "-c",
    "SET LOCAL search_path = pg_catalog;",
    "-c",
    "SET LOCAL work_mem = '4MB';",
    "-f",
    "/attestor/sql/catalog-bounds.v1.sql",
    "-f",
    "/attestor/sql/catalog-attestation.v1.sql",
    "-c",
    "ROLLBACK;",
  ]);
  const identityLine = output
    .split("\n")
    .find((line) => line.startsWith("database_identity|") && line.split("|").length === 4);
  if (!identityLine) throw new Error("sanitized database_identity result missing");
  return JSON.parse(identityLine.split("|")[3]);
}

function assertCheck(checks, name, expected) {
  if (checks[name] !== expected) {
    throw new Error(`${name} must be ${expected}`);
  }
}

let started = false;
try {
  try {
    docker(["container", "inspect", CONTAINER_NAME]);
    throw new Error("isolated PostgreSQL test container name collision");
  } catch (error) {
    if (error.message === "isolated PostgreSQL test container name collision") throw error;
  }

  docker([
    "run",
    "--rm",
    "-d",
    "--name",
    CONTAINER_NAME,
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-v",
    `${PACKAGE_ROOT}:/attestor:ro`,
    POSTGRES_IMAGE,
  ]);
  started = true;

  let ready = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      docker(["exec", CONTAINER_NAME, "pg_isready", "-U", "postgres"]);
      ready = true;
      break;
    } catch {
      sleep(250);
    }
  }
  if (!ready) throw new Error("isolated PostgreSQL 17 did not become ready");

  psql("postgres", [
    "CREATE ROLE hushh_tech_schema_owner NOLOGIN; CREATE ROLE hushh_tech_migration NOLOGIN; CREATE ROLE hushh_tech_runtime NOLOGIN; CREATE ROLE hushh_tech_audit NOLOGIN; CREATE ROLE hushh_tech_rollback NOLOGIN; CREATE ROLE cloudsqliamserviceaccount NOLOGIN; CREATE ROLE \"hushh-tech-audit-uat@hushh-tech-uat.iam\" LOGIN;",
    "CREATE DATABASE hushh_tech_app;",
  ]);
  psql("hushh_tech_app", [
    "REVOKE CREATE, TEMPORARY ON DATABASE hushh_tech_app FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC;",
    `GRANT pg_read_all_data, hushh_tech_audit, cloudsqliamserviceaccount TO "${AUDIT_USER}";`,
  ]);

  const version = psql("hushh_tech_app", ["SHOW server_version_num;"]);
  if (!/170[0-9]{3}/.test(version)) throw new Error("PostgreSQL major version must be 17");

  const implicitFunctionDefaultAcl = captureChecks();
  assertCheck(
    implicitFunctionDefaultAcl,
    "auditWritableDefaultPrivilegesDenied",
    false,
  );

  psql("hushh_tech_app", [
    "ALTER DEFAULT PRIVILEGES FOR ROLE hushh_tech_schema_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;",
  ]);
  const migrationImplicitFunctionDefaultAcl = captureChecks();
  assertCheck(
    migrationImplicitFunctionDefaultAcl,
    "auditWritableDefaultPrivilegesDenied",
    false,
  );

  psql("hushh_tech_app", [
    "ALTER DEFAULT PRIVILEGES FOR ROLE hushh_tech_migration REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE hushh_tech_schema_owner GRANT EXECUTE ON FUNCTIONS TO PUBLIC;",
  ]);
  const schemaOwnerFunctionDefaultAcl = captureChecks();
  assertCheck(
    schemaOwnerFunctionDefaultAcl,
    "auditWritableDefaultPrivilegesDenied",
    false,
  );

  psql("hushh_tech_app", [
    "ALTER DEFAULT PRIVILEGES FOR ROLE hushh_tech_schema_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;",
  ]);
  const baseline = captureChecks();
  const failedBaselineChecks = Object.entries(baseline)
    .filter(([, value]) => value !== true)
    .map(([name]) => name);
  if (failedBaselineChecks.length > 0) {
    throw new Error(`baseline safe checks failed: ${failedBaselineChecks.join(",")}`);
  }

  psql("hushh_tech_app", [
    "GRANT CREATE ON SCHEMA public TO cloudsqliamserviceaccount;",
  ]);
  const providerMarkerWritePrivilege = captureChecks();
  assertCheck(providerMarkerWritePrivilege, "auditWritableMembershipDenied", false);
  psql("hushh_tech_app", [
    "REVOKE CREATE ON SCHEMA public FROM cloudsqliamserviceaccount;",
  ]);

  psql("hushh_tech_app", [`GRANT pg_execute_server_program TO "${AUDIT_USER}";`]);
  const privilegedMembership = captureChecks();
  assertCheck(privilegedMembership, "auditWritableMembershipDenied", false);
  psql("hushh_tech_app", [`REVOKE pg_execute_server_program FROM "${AUDIT_USER}";`]);

  psql("hushh_tech_app", [
    "ALTER DEFAULT PRIVILEGES FOR ROLE hushh_tech_schema_owner GRANT INSERT, UPDATE, DELETE ON TABLES TO hushh_tech_audit;",
  ]);
  const writeDefaultAcl = captureChecks();
  assertCheck(writeDefaultAcl, "auditWritableMembershipDenied", true);
  assertCheck(writeDefaultAcl, "auditWritableDefaultPrivilegesDenied", false);

  process.stdout.write(
    `${JSON.stringify({
      valid: true,
      postgresMajor: 17,
      implicitFunctionDefaultAclRejected: true,
      migrationImplicitFunctionDefaultAclRejected: true,
      schemaOwnerFunctionDefaultAclRejected: true,
      providerMarkerWritePrivilegeRejected: true,
      pgExecuteServerProgramRejected: true,
      writeDefaultAclRejected: true,
      liveCloudSql: false,
    })}\n`,
  );
} finally {
  if (started) {
    try {
      docker(["stop", CONTAINER_NAME], { stdio: "ignore" });
    } catch {
      // The container uses --rm; no broad cleanup fallback is permitted.
    }
  }
}
