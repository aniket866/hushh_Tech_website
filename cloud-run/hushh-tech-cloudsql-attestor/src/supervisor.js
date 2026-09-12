import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseConfig } from "./config.js";
import { parseConnectionDiagnostic } from "./errors.js";
import { HARD_PROCESS_DEADLINE_MS, MAX_OUTPUT_BYTES } from "./constants.js";
import {
  bindSupervisorEvidence,
  buildFailedExecutionEvidence,
  buildNotExecutedEvidence,
  serializeEvidence,
  validateEvidence,
} from "./evidence.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UNKNOWN_METRICS = Object.freeze({
  connectorCreated: null,
  poolCreated: null,
  connectorCloseCalled: null,
  poolCloseCalled: null,
  connectorCalls: null,
  connectionAttempts: null,
  queryStatements: null,
});

function defaultSpawnWorker(env) {
  return spawn(process.execPath, [resolve(PACKAGE_ROOT, "src/cli.js")], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function safeFailure({ env, blocker }) {
  try {
    const config = parseConfig(env);
    if (config.execute && config.imageDigest) {
      return buildFailedExecutionEvidence({
        blocker,
        imageDigest: config.imageDigest,
        metrics: UNKNOWN_METRICS,
        hardProcessSupervisor: true,
      });
    }
  } catch {
    // The fixed blocker below is the only output; config errors are never logged.
  }
  return buildNotExecutedEvidence({ blocker, hardProcessSupervisor: true });
}

export async function runSupervisor({
  env = process.env,
  stdout = process.stdout,
  spawnWorker = defaultSpawnWorker,
  hardDeadlineMs = HARD_PROCESS_DEADLINE_MS,
} = {}) {
  let child;
  try {
    child = spawnWorker(env);
  } catch {
    const evidence = safeFailure({ env, blocker: "WORKER_EXIT_FAILED" });
    stdout.write(serializeEvidence(evidence));
    return 1;
  }
  let output = Buffer.alloc(0);
  let diagnosticOutput = Buffer.alloc(0);
  let outputOverflow = false;
  let settled = false;

  const result = await new Promise((resolveResult) => {
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolveResult(value);
    };
    const deadline = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.kill("SIGKILL");
      finish({ blocker: "HARD_PROCESS_DEADLINE_EXCEEDED", exitCode: 1 });
    }, hardDeadlineMs);

    child.stdout?.on("data", (chunk) => {
      if (outputOverflow) return;
      output = Buffer.concat([output, Buffer.from(chunk)]);
      if (output.length > MAX_OUTPUT_BYTES) {
        outputOverflow = true;
        output = Buffer.alloc(0);
        child.kill("SIGKILL");
      }
    });
    child.stderr?.on("data", (chunk) => {
      if (diagnosticOutput.length <= 4096) {
        diagnosticOutput = Buffer.concat([diagnosticOutput, Buffer.from(chunk)]);
      }
    });
    child.once("error", () => finish({ blocker: "WORKER_EXIT_FAILED", exitCode: 1 }));
    child.once("close", (code, signal) => {
      if (outputOverflow) {
        finish({ blocker: "WORKER_OUTPUT_INVALID", exitCode: 1 });
      } else if (signal) {
        finish({ blocker: "WORKER_EXIT_FAILED", exitCode: 1 });
      } else {
        finish({ output, exitCode: code });
      }
    });
  });

  let evidence;
  if (result.blocker) {
    evidence = safeFailure({ env, blocker: result.blocker });
  } else {
    try {
      const workerEvidence = JSON.parse(result.output.toString("utf8"));
      validateEvidence(workerEvidence);
      const expectedExit = workerEvidence.status === "CAPTURED" || workerEvidence.status === "NOT_EXECUTED" ? 0 : 1;
      if (result.exitCode !== expectedExit) throw new Error("worker exit/evidence mismatch");
      evidence = bindSupervisorEvidence(workerEvidence);
    } catch {
      evidence = safeFailure({ env, blocker: "WORKER_OUTPUT_INVALID" });
    }
  }

  stdout.write(serializeEvidence(evidence));
  const diagnostic = parseConnectionDiagnostic(diagnosticOutput.toString("utf8"));
  if (diagnostic) console.error(JSON.stringify(diagnostic));
  return evidence.status === "CAPTURED" || evidence.status === "NOT_EXECUTED" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runSupervisor();
}
