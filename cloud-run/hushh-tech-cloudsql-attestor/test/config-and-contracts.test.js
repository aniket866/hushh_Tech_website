import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import {
  EXPECTED_EXECUTION_CONTRACT_SHA256,
  EXPECTED_QUERY_SET_SHA256,
  EXPECTED_SOURCE_SHA256,
} from "../src/constants.js";
import { ENV, parseConfig } from "../src/config.js";
import { validateRuntimeContracts } from "../src/contracts.js";
import {
  buildConnectionDiagnostic,
  parseConnectionDiagnostic,
  serializeConnectionDiagnostic,
} from "../src/errors.js";
import { loadAndValidateQueryContract } from "../src/query-contract.js";
import { activationEnv } from "./helpers.js";

const hashes = {
  contract: EXPECTED_EXECUTION_CONTRACT_SHA256,
  querySet: EXPECTED_QUERY_SET_SHA256,
  source: EXPECTED_SOURCE_SHA256,
};

test("defaults to disabled and accepts only the exact UAT target", () => {
  assert.deepEqual(parseConfig({}), {
    execute: false,
    target: parseConfig({}).target,
    imageDigest: null,
  });
  assert.throws(
    () => parseConfig({ [ENV.project]: "hushh-tech-prod" }),
    (error) => error.code === "TARGET_BOUNDARY_VIOLATION",
  );
  assert.throws(
    () => parseConfig({ [ENV.region]: "europe-west1" }),
    (error) => error.code === "TARGET_BOUNDARY_VIOLATION",
  );
  assert.throws(
    () => parseConfig({ [ENV.execute]: "TRUE" }),
    (error) => error.code === "TARGET_BOUNDARY_VIOLATION",
  );
});

test("rejects password, URL, credential-file, host, and token env inputs", () => {
  for (const key of [
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
    "GOOGLE_APPLICATION_CREDENTIALS",
    "HUSHH_TECH_CLOUDSQL_ATTESTOR_PASSWORD",
    "HUSHH_TECH_CLOUDSQL_ATTESTOR_HOST",
    "HUSHH_TECH_CLOUDSQL_ATTESTOR_TOKEN",
  ]) {
    assert.throws(
      () => parseConfig({ [key]: "forbidden" }),
      (error) => error.code === "FORBIDDEN_CREDENTIAL_ENV",
      key,
    );
  }
  assert.throws(
    () => parseConfig({ PGPASSFILE: "" }),
    (error) => error.code === "FORBIDDEN_CREDENTIAL_ENV",
  );
});

test("real node-postgres client cannot fall through to a PGPASSFILE password", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hushh-tech-attestor-pgpass-"));
  const passfile = join(directory, "pgpass");
  const sentinel = "must-never-load-from-pgpass";
  writeFileSync(passfile, `private.invalid:5432:hushh_tech_app:audit:${sentinel}\n`, {
    mode: 0o600,
  });
  const previous = process.env.PGPASSFILE;
  process.env.PGPASSFILE = passfile;
  t.after(() => {
    if (previous === undefined) delete process.env.PGPASSFILE;
    else process.env.PGPASSFILE = previous;
    rmSync(directory, { recursive: true, force: true });
  });

  const client = new pg.Client({
    host: "private.invalid",
    port: 5432,
    database: "hushh_tech_app",
    user: "audit",
    password: () => undefined,
  });
  await new Promise((resolve, reject) => {
    client.connection.once("error", reject);
    client._checkPgPass(resolve);
  });
  assert.equal(client.password, null);
  assert.equal(client.connectionParameters.password, null);
  assert.notEqual(client.password, sentinel);
});

test("requires exact contract roots and an immutable-form image digest claim", () => {
  const valid = activationEnv({
    expectedContract: hashes.contract,
    expectedQuerySet: hashes.querySet,
    expectedSource: hashes.source,
  });
  assert.equal(parseConfig(valid).execute, true);

  for (const key of [ENV.approvedContract, ENV.approvedQuerySet, ENV.approvedSource]) {
    assert.throws(
      () => parseConfig({ ...valid, [key]: "0".repeat(64) }),
      (error) => error.code === "ACTIVATION_CONTRACT_MISMATCH",
      key,
    );
  }
  assert.throws(
    () => parseConfig({ ...valid, [ENV.imageDigest]: "mutable-image-tag" }),
    (error) => error.code === "IMAGE_DIGEST_REQUIRED",
  );
});

test("validates exact source and execution contracts", () => {
  assert.deepEqual(validateRuntimeContracts(), {
    sourceSha256: EXPECTED_SOURCE_SHA256,
    executionContractSha256: EXPECTED_EXECUTION_CONTRACT_SHA256,
  });

  const source = JSON.parse(
    readFileSync(new URL("../contracts/source-manifest.v1.json", import.meta.url), "utf8"),
  );
  const execution = JSON.parse(
    readFileSync(new URL("../contracts/execution-contract.v1.json", import.meta.url), "utf8"),
  );
  const forgedSource = structuredClone(source);
  forgedSource.files[0].sha256 = "0".repeat(64);
  assert.throws(
    () => validateRuntimeContracts({ sourceManifest: forgedSource, executionContract: execution }),
    (error) => error.code === "SOURCE_CONTRACT_DRIFT",
  );
  const forgedTarget = structuredClone(execution);
  forgedTarget.target.project = "hushh-tech-prod";
  assert.throws(
    () => validateRuntimeContracts({ sourceManifest: source, executionContract: forgedTarget }),
    (error) => error.code === "ACTIVATION_CONTRACT_MISMATCH",
  );
});

test("connection diagnostics preserve only safe provider fields", () => {
  const error = Object.assign(new Error("private connection secret"), {
    code: "ETIMEDOUT",
    errno: -110,
    syscall: "connect",
    hostname: "private.invalid",
    address: "10.0.0.8",
    port: 5432,
  });
  const diagnostic = buildConnectionDiagnostic(error, "POST_CONNECT");
  assert.deepEqual(diagnostic, {
    kind: "HUSHH_TECH_UAT_CLOUDSQL_CONNECTION_DIAGNOSTIC",
    stage: "TCP",
    name: "Error",
    code: "ETIMEDOUT",
    errno: "-110",
    syscall: "connect",
    hostname: "private.invalid",
    address: "10.0.0.8",
    port: 5432,
    sqlState: null,
  });
  const serialized = serializeConnectionDiagnostic(diagnostic);
  assert.doesNotMatch(serialized, /private connection secret/i);
  assert.deepEqual(parseConnectionDiagnostic(serialized), diagnostic);
  assert.equal(
    buildConnectionDiagnostic(
      Object.assign(new Error("bad"), { code: "28P01", hostname: "bad@secret" }),
      "POST_CONNECT",
    ).stage,
    "DB_AUTH",
  );
  assert.equal(parseConnectionDiagnostic('{"raw":"secret"}'), null);
});

test("rejects any mutation or psql-style/multi-statement query shape", () => {
  const contract = loadAndValidateQueryContract();
  assert.equal(contract.statementCount, 9);
  assert.equal(contract.bounds.match(/;/g)?.length, 1);
  assert.equal(contract.catalog.match(/;/g)?.length, 1);
  assert.doesNotMatch(contract.bounds, /^\\/m);
  assert.doesNotMatch(contract.catalog, /^\\/m);
  assert.ok(
    (contract.catalog.match(/procedure\.prokind IN \('f', 'p'\)/g)?.length ?? 0) >= 3,
  );
  assert.match(contract.catalog, /CASE WHEN procedure\.prokind IN \('f', 'p'\)[\s\S]*pg_get_functiondef/);
  assert.match(contract.catalog, /CASE WHEN candidate\.relkind = 'S'[\s\S]*has_sequence_privilege/);
  assert.match(contract.catalog, /CASE WHEN candidate_object\.relkind = 'S'[\s\S]*has_sequence_privilege/);
  assert.match(contract.catalog, /CASE WHEN candidate\.relkind <> 'S'[\s\S]*has_table_privilege/);
  assert.match(contract.catalog, /CASE WHEN candidate_object\.relkind <> 'S'[\s\S]*has_table_privilege/);
  assert.throws(
    () => loadAndValidateQueryContract({ boundsSql: contract.bounds.replace(/^WITH/, "DELETE") }),
    (error) => error.code === "QUERY_CONTRACT_DRIFT",
  );
  assert.throws(
    () => loadAndValidateQueryContract({ catalogSql: contract.catalog.replace(/^WITH/, "DELETE") }),
    (error) => error.code === "QUERY_CONTRACT_DRIFT",
  );
  assert.throws(
    () => loadAndValidateQueryContract({ catalogSql: `${contract.catalog}\nSELECT 1;` }),
    (error) => error.code === "QUERY_CONTRACT_DRIFT",
  );
  assert.throws(
    () => loadAndValidateQueryContract({ boundsSql: `\\set leaked 1\n${contract.bounds}` }),
    (error) => error.code === "QUERY_CONTRACT_DRIFT",
  );
});
