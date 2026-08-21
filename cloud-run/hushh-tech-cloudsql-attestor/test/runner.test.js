import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECK_NAMES,
  EXPECTED_EXECUTION_CONTRACT_SHA256,
  EXPECTED_QUERY_SET_SHA256,
  EXPECTED_SOURCE_SHA256,
} from "../src/constants.js";
import { runAttestation } from "../src/runner.js";
import { activeConfig, boundsResult, catalogResult, fakeRuntime } from "./helpers.js";

const config = activeConfig({
  contract: EXPECTED_EXECUTION_CONTRACT_SHA256,
  querySet: EXPECTED_QUERY_SET_SHA256,
  source: EXPECTED_SOURCE_SHA256,
});

test("uses exact PRIVATE/IAM connector and passwordless one-connection pool", async () => {
  const { runtime, record } = fakeRuntime();
  const evidence = await runAttestation({ config, runtime });

  assert.equal(evidence.status, "CAPTURED");
  assert.deepEqual(record.connectorArgs, [
    {
      instanceConnectionName: "hushh-tech-uat:us-central1:hushh-tech-app-pg-uat",
      ipType: "PRIVATE",
      authType: "IAM",
    },
  ]);
  assert.equal(record.poolConfigs.length, 1);
  assert.equal(record.poolConfigs[0].user, "hushh-tech-audit-uat@hushh-tech-uat.iam");
  assert.equal(record.poolConfigs[0].database, "hushh_tech_app");
  assert.equal(record.poolConfigs[0].max, 1);
  assert.equal(typeof record.poolConfigs[0].password, "function");
  assert.equal(await record.poolConfigs[0].password(), undefined);
  assert.equal(record.poolConfigs[0].host, undefined);
  assert.equal(record.queries.length, 9);
  assert.match(record.queries[0].text, /^BEGIN .* READ ONLY;$/);
  assert.equal(record.queries.at(-1).text, "ROLLBACK;");
  assert.deepEqual(record.releaseArgs, [false]);
  assert.equal(record.poolEndCalls, 1);
  assert.equal(record.connectorCloseCalls, 1);
});

test("fails closed on connector option drift before pool construction", async () => {
  const { runtime, record } = fakeRuntime({
    connectorOptions: { stream: () => ({}), host: "private.invalid" },
  });
  await assert.rejects(
    () => runAttestation({ config, runtime }),
    (error) =>
      error.code === "CONNECTOR_CONTRACT_INVALID" &&
      error.attestorMetrics.connectorCloseCalled === true,
  );
  assert.equal(record.poolConfigs.length, 0);
  assert.equal(record.connectorCloseCalls, 1);
});

test("rejects multi-result catalog shapes and closes pool and connector", async () => {
  const { runtime, record } = fakeRuntime({ catalog: [catalogResult()] });
  await assert.rejects(
    () => runAttestation({ config, runtime }),
    (error) =>
      error.code === "CATALOG_RESULT_INVALID" &&
      error.attestorMetrics.poolCloseCalled === true &&
      error.attestorMetrics.connectorCloseCalled === true,
  );
  assert.deepEqual(record.releaseArgs, [true]);
  assert.equal(record.poolEndCalls, 1);
  assert.equal(record.connectorCloseCalls, 1);
});

test("worker deadline aborts a pending connector call and still closes it", async () => {
  const { runtime, record } = fakeRuntime({
    getOptions: () => new Promise(() => {}),
  });
  await assert.rejects(
    () => runAttestation({ config, runtime, deadlineMs: 5 }),
    (error) =>
      error.code === "WORKER_DEADLINE_EXCEEDED" &&
      error.attestorMetrics.connectorCreated === true &&
      error.attestorMetrics.connectorCloseCalled === true &&
      error.attestorMetrics.connectionAttempts === 0,
  );
  assert.equal(record.connectorCloseCalls, 1);
  assert.equal(record.poolEndCalls, 0);
});

test("fails closed on a catalog bound before the digest query", async () => {
  const exceeded = boundsResult({
    mutateRow(rows) {
      rows[4].max_row_bytes = "262145";
    },
  });
  const { runtime, record } = fakeRuntime({ bounds: exceeded });
  await assert.rejects(
    () => runAttestation({ config, runtime }),
    (error) =>
      error.code === "CATALOG_BOUNDS_EXCEEDED" &&
      error.attestorMetrics.poolCloseCalled === true &&
      error.attestorMetrics.connectorCloseCalled === true,
  );
  assert.equal(record.queries.some((entry) => entry.text.includes("safe_checks AS")), false);
  assert.equal(record.queries.at(-1).text, "ROLLBACK;");
});

test("raw provider errors are replaced by a fixed blocker and cleanup still runs", async () => {
  const sensitive = "dial 10.0.0.8 with Bearer raw-secret-token-value";
  const { runtime, record } = fakeRuntime({
    query(config) {
      if (config.text.startsWith("BEGIN")) return { command: "BEGIN" };
      if (config.text.startsWith("SET LOCAL")) return { command: "SET" };
      if (config.text === "ROLLBACK;") return { command: "ROLLBACK" };
      throw new Error(sensitive);
    },
  });
  await assert.rejects(
    () => runAttestation({ config, runtime }),
    (error) =>
      error.code === "RUNTIME_CONNECTION_FAILED" &&
      !JSON.stringify(error).includes(sensitive) &&
      error.attestorMetrics.poolCloseCalled === true,
  );
  assert.deepEqual(record.releaseArgs, [true]);
  assert.equal(record.poolEndCalls, 1);
  assert.equal(record.connectorCloseCalls, 1);
});

test("false reviewed checks produce blockers rather than an attested claim", async () => {
  const falseChecks = Object.fromEntries(CHECK_NAMES.map((name) => [name, true]));
  falseChecks.transactionReadOnly = false;
  falseChecks.applicationRelationsEmpty = false;
  const { runtime } = fakeRuntime({ catalog: catalogResult({ checks: falseChecks }) });
  const evidence = await runAttestation({ config, runtime });
  assert.equal(evidence.status, "BLOCKED");
  assert.deepEqual(evidence.blockers, [
    "TRANSACTION_NOT_READ_ONLY",
    "APPLICATION_RELATIONS_PRESENT",
  ]);
});
