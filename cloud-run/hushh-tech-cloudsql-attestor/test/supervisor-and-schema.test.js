import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runSupervisor } from "../src/supervisor.js";
import {
  buildNotExecutedEvidence,
  serializeEvidence,
  validateEvidence,
} from "../src/evidence.js";
import { captureWriter } from "./helpers.js";

function fakeChild({ onStart } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  queueMicrotask(() => onStart?.(child));
  return child;
}

test("supervisor reseals the default-off worker output without activating runtime", async () => {
  const output = captureWriter();
  const workerEvidence = buildNotExecutedEvidence();
  const exitCode = await runSupervisor({
    env: {},
    stdout: output.stdout,
    spawnWorker() {
      return fakeChild({
        onStart(child) {
          child.stdout.end(serializeEvidence(workerEvidence));
          child.emit("close", 0, null);
        },
      });
    },
  });
  const evidence = JSON.parse(output.read());
  assert.equal(exitCode, 0);
  assert.equal(evidence.status, "NOT_EXECUTED");
  assert.equal(evidence.execution.hardProcessSupervisor, true);
  assert.equal(evidence.execution.connectorCalls, 0);
  assert.equal(evidence.execution.connectionAttempts, 0);
  assert.equal(validateEvidence(evidence), true);
});

test("hard deadline kills a hung worker and emits only a fixed sanitized blocker", async () => {
  const output = captureWriter();
  let child;
  const exitCode = await runSupervisor({
    env: {},
    stdout: output.stdout,
    hardDeadlineMs: 5,
    spawnWorker() {
      child = fakeChild({
        onStart(running) {
          running.stderr.write(
            "dial 10.0.0.9 Bearer raw-secret-token principal@example.invalid",
          );
        },
      });
      return child;
    },
  });
  const serialized = output.read();
  const evidence = JSON.parse(serialized);
  assert.equal(exitCode, 1);
  assert.deepEqual(child.killSignals, ["SIGKILL"]);
  assert.deepEqual(evidence.blockers, ["HARD_PROCESS_DEADLINE_EXCEEDED"]);
  assert.equal(evidence.execution.hardProcessSupervisor, true);
  assert.doesNotMatch(serialized, /10\.0\.0\.9|Bearer|principal@|raw-secret/i);
});

test("oversized or malformed worker output is discarded rather than reflected", async () => {
  for (const workerOutput of [
    "x".repeat(16_385),
    '{"raw":"postgres://principal@example.invalid:secret@10.0.0.8/db"}',
  ]) {
    const output = captureWriter();
    const exitCode = await runSupervisor({
      env: {},
      stdout: output.stdout,
      spawnWorker() {
        return fakeChild({
          onStart(child) {
            child.stdout.end(workerOutput);
            child.emit("close", workerOutput.length > 16_384 ? null : 0, null);
          },
        });
      },
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(JSON.parse(output.read()).blockers, ["WORKER_OUTPUT_INVALID"]);
    assert.doesNotMatch(output.read(), /postgres:\/\/|principal@|10\.0\.0\.8|secret/i);
  }
});

test("synchronous worker spawn failure is reduced to a fixed blocker", async () => {
  const output = captureWriter();
  const exitCode = await runSupervisor({
    env: {},
    stdout: output.stdout,
    spawnWorker() {
      throw new Error("Bearer raw-spawn-secret");
    },
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(output.read()).blockers, ["WORKER_EXIT_FAILED"]);
  assert.doesNotMatch(output.read(), /Bearer|raw-spawn-secret/i);
});

test("evidence schema fixes every nested object and collection position", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../contracts/attestation-evidence.schema.json", import.meta.url), "utf8"),
  );
  for (const name of ["target", "bindings", "execution", "checks"]) {
    assert.equal(schema.properties[name].additionalProperties, false, name);
    assert.deepEqual(
      [...schema.properties[name].required].sort(),
      Object.keys(schema.properties[name].properties).sort(),
      name,
    );
  }
  assert.equal(schema.$defs.collection.additionalProperties, false);
  assert.equal(schema.properties.collections.minItems, 12);
  assert.equal(schema.properties.collections.maxItems, 12);
  assert.equal(schema.properties.collections.prefixItems.length, 12);
  assert.equal(schema.properties.collections.items, false);
});
