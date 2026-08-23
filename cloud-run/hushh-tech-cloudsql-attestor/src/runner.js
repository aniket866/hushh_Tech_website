import { CLEANUP_DEADLINE_MS, TARGET, WORKER_DEADLINE_MS } from "./constants.js";
import {
  buildCapturedEvidence,
  normalizeBoundsResult,
  normalizeCatalogResult,
} from "./evidence.js";
import { AttestorError } from "./errors.js";
import { loadAndValidateQueryContract } from "./query-contract.js";

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function abortError(signal) {
  return signal.reason instanceof AttestorError
    ? signal.reason
    : new AttestorError("ATTESTATION_ABORTED");
}

function raceWithAbort(operation, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  const operationPromise = Promise.resolve().then(operation);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operationPromise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function closeWithin(operation, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new AttestorError("CATALOG_CHECK_FAILED")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function validateCommand(result, command) {
  if (Array.isArray(result) || !result || result.command !== command) {
    throw new AttestorError("CATALOG_RESULT_INVALID");
  }
}

function makeSafeRunError(error, metrics) {
  const safe = error instanceof AttestorError ? error : new AttestorError("RUNTIME_CONNECTION_FAILED");
  safe.attestorMetrics = Object.freeze({ ...metrics });
  return safe;
}

export async function loadRuntimeDependencies() {
  const [connectorModule, pgModule] = await Promise.all([
    import("@google-cloud/cloud-sql-connector"),
    import("pg"),
  ]);
  return Object.freeze({
    Connector: connectorModule.Connector,
    IpAddressTypes: connectorModule.IpAddressTypes,
    AuthTypes: connectorModule.AuthTypes,
    Pool: pgModule.default.Pool,
  });
}

export async function runAttestation({
  config,
  runtime,
  queryContract = loadAndValidateQueryContract(),
  deadlineMs = WORKER_DEADLINE_MS,
} = {}) {
  if (!config?.execute || config.target !== TARGET || !runtime) {
    throw new AttestorError("TARGET_BOUNDARY_VIOLATION");
  }

  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new AttestorError("WORKER_DEADLINE_EXCEEDED")),
    deadlineMs,
  );
  const metrics = {
    connectorCreated: false,
    poolCreated: false,
    connectorCloseCalled: false,
    poolCloseCalled: false,
    connectorCalls: 0,
    connectionAttempts: 0,
    queryStatements: 0,
  };
  let connector;
  let pool;
  let client;
  let transactionStarted = false;
  let transactionRolledBack = false;
  let normalized;
  let failure;

  try {
    connector = new runtime.Connector();
    metrics.connectorCreated = true;
    metrics.connectorCalls = 1;
    const connectorOptions = await raceWithAbort(
      () =>
        connector.getOptions({
          instanceConnectionName: `${TARGET.project}:${TARGET.region}:${TARGET.instance}`,
          ipType: runtime.IpAddressTypes.PRIVATE,
          authType: runtime.AuthTypes.IAM,
        }),
      controller.signal,
    );
    if (!exactKeys(connectorOptions, ["stream"]) || typeof connectorOptions.stream !== "function") {
      throw new AttestorError("CONNECTOR_CONTRACT_INVALID");
    }

    pool = new runtime.Pool({
      stream: connectorOptions.stream,
      user: TARGET.auditIamDatabaseUser,
      database: TARGET.database,
      // A function returning undefined bypasses node-postgres' pgpass lookup and
      // fails closed if a server ever requests a password.
      password: () => undefined,
      max: 1,
      min: 0,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 1_000,
      allowExitOnIdle: true,
    });
    metrics.poolCreated = true;
    metrics.connectionAttempts = 1;
    client = await raceWithAbort(() => pool.connect(), controller.signal);

    const beginResult = await raceWithAbort(
      () => client.query({ text: queryContract.begin }),
      controller.signal,
    );
    metrics.queryStatements += 1;
    validateCommand(beginResult, "BEGIN");
    transactionStarted = true;

    for (const statement of queryContract.session) {
      const setResult = await raceWithAbort(
        () => client.query({ text: statement }),
        controller.signal,
      );
      metrics.queryStatements += 1;
      validateCommand(setResult, "SET");
    }

    const boundsResult = await raceWithAbort(
      () => client.query({ text: queryContract.bounds }),
      controller.signal,
    );
    metrics.queryStatements += 1;
    normalizeBoundsResult(boundsResult);

    const catalogResult = await raceWithAbort(
      () => client.query({ text: queryContract.catalog }),
      controller.signal,
    );
    metrics.queryStatements += 1;
    normalized = normalizeCatalogResult(catalogResult);

    const rollbackResult = await raceWithAbort(
      () => client.query({ text: queryContract.rollback }),
      controller.signal,
    );
    metrics.queryStatements += 1;
    validateCommand(rollbackResult, "ROLLBACK");
    transactionRolledBack = true;
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(deadline);
    if (client && transactionStarted && !transactionRolledBack && !controller.signal.aborted) {
      try {
        const rollbackResult = await closeWithin(
          () => client.query({ text: queryContract.rollback }),
          CLEANUP_DEADLINE_MS,
        );
        metrics.queryStatements += 1;
        validateCommand(rollbackResult, "ROLLBACK");
      } catch {
        failure = failure ?? new AttestorError("CATALOG_CHECK_FAILED");
      }
    }
    if (client) {
      try {
        client.release(Boolean(failure) || controller.signal.aborted);
      } catch {
        failure = failure ?? new AttestorError("CATALOG_CHECK_FAILED");
      }
    }
    if (pool) {
      metrics.poolCloseCalled = true;
      try {
        await closeWithin(() => pool.end(), CLEANUP_DEADLINE_MS);
      } catch {
        failure = failure ?? new AttestorError("CATALOG_CHECK_FAILED");
      }
    }
    if (connector) {
      metrics.connectorCloseCalled = true;
      try {
        connector.close();
      } catch {
        failure = failure ?? new AttestorError("CATALOG_CHECK_FAILED");
      }
    }
  }

  if (failure) throw makeSafeRunError(failure, metrics);
  return buildCapturedEvidence({ normalized, imageDigest: config.imageDigest, cleanup: metrics });
}
