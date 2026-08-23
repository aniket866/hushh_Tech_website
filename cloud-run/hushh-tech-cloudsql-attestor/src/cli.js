import { pathToFileURL } from "node:url";

import { parseConfig } from "./config.js";
import { validateRuntimeContracts } from "./contracts.js";
import {
  buildFailedExecutionEvidence,
  buildNotExecutedEvidence,
  serializeEvidence,
} from "./evidence.js";
import { safeErrorCode } from "./errors.js";
import { loadAndValidateQueryContract } from "./query-contract.js";
import { loadRuntimeDependencies, runAttestation } from "./runner.js";

const EMPTY_ATTEMPT_METRICS = Object.freeze({
  connectorCreated: false,
  poolCreated: false,
  connectorCloseCalled: false,
  poolCloseCalled: false,
  connectorCalls: 0,
  connectionAttempts: 0,
  queryStatements: 0,
});

export async function executeCli({
  env = process.env,
  stdout = process.stdout,
  loadRuntime = loadRuntimeDependencies,
  run = runAttestation,
} = {}) {
  let config;
  try {
    config = parseConfig(env);
    validateRuntimeContracts();
    const queryContract = loadAndValidateQueryContract();
    if (!config.execute) {
      stdout.write(serializeEvidence(buildNotExecutedEvidence()));
      return 0;
    }

    const runtime = await loadRuntime();
    const evidence = await run({ config, runtime, queryContract });
    stdout.write(serializeEvidence(evidence));
    return evidence.status === "CAPTURED" ? 0 : 1;
  } catch (error) {
    const blocker = safeErrorCode(error);
    const evidence = config?.execute && config.imageDigest
      ? buildFailedExecutionEvidence({
          blocker,
          imageDigest: config.imageDigest,
          metrics: error?.attestorMetrics ?? EMPTY_ATTEMPT_METRICS,
        })
      : buildNotExecutedEvidence({ blocker });
    stdout.write(serializeEvidence(evidence));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await executeCli();
}
