import { CHECK_NAMES, COLLECTIONS } from "../src/constants.js";
import { ENV, parseConfig } from "../src/config.js";

export const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;

export function activationEnv(overrides = {}) {
  const env = {
    [ENV.execute]: "true",
    [ENV.project]: "hushh-tech-uat",
    [ENV.region]: "us-central1",
    [ENV.instance]: "hushh-tech-app-pg-uat",
    [ENV.database]: "hushh_tech_app",
    [ENV.user]: "hushh-tech-audit-uat@hushh-tech-uat.iam",
    [ENV.approvedContract]: overrides.expectedContract,
    [ENV.approvedQuerySet]: overrides.expectedQuerySet,
    [ENV.approvedSource]: overrides.expectedSource,
    [ENV.imageDigest]: IMAGE_DIGEST,
    ...overrides,
  };
  delete env.expectedContract;
  delete env.expectedQuerySet;
  delete env.expectedSource;
  return env;
}

export function activeConfig(hashes) {
  return parseConfig(
    activationEnv({
      expectedContract: hashes.contract,
      expectedQuerySet: hashes.querySet,
      expectedSource: hashes.source,
    }),
  );
}

export function catalogResult({ checks = {}, mutateRow } = {}) {
  const safeChecks = Object.fromEntries(CHECK_NAMES.map((name) => [name, checks[name] ?? true]));
  const rows = COLLECTIONS.map((collection, index) => ({
    collection,
    row_count: String(index),
    canonical_sha256: (index + 1).toString(16).repeat(64).slice(0, 64),
    checks: index === 0 ? safeChecks : null,
  }));
  if (mutateRow) mutateRow(rows);
  return { command: "SELECT", rowCount: rows.length, rows };
}

export function boundsResult({ mutateRow } = {}) {
  const rows = COLLECTIONS.map((collection, index) => ({
    collection,
    row_count: String(index),
    max_row_bytes: index === 0 ? "4096" : "0",
  }));
  if (mutateRow) mutateRow(rows);
  return { command: "SELECT", rowCount: rows.length, rows };
}

export function fakeRuntime({
  bounds = boundsResult(),
  catalog = catalogResult(),
  connectorOptions = { stream: () => ({}) },
  getOptions,
  query,
} = {}) {
  const record = {
    connectorConstructed: 0,
    connectorArgs: [],
    connectorCloseCalls: 0,
    poolConfigs: [],
    poolConnectCalls: 0,
    poolEndCalls: 0,
    releaseArgs: [],
    queries: [],
  };

  class Connector {
    constructor() {
      record.connectorConstructed += 1;
    }
    async getOptions(options) {
      record.connectorArgs.push(options);
      if (getOptions) return getOptions(options);
      return connectorOptions;
    }
    close() {
      record.connectorCloseCalls += 1;
    }
  }

  const client = {
    async query(config) {
      record.queries.push(config);
      if (query) return query(config, record.queries.length);
      if (config.text.startsWith("BEGIN")) return { command: "BEGIN" };
      if (config.text.startsWith("SET LOCAL")) return { command: "SET" };
      if (config.text === "ROLLBACK;") return { command: "ROLLBACK" };
      if (config.text.includes(" AS max_row_bytes")) return bounds;
      return catalog;
    },
    release(destroy) {
      record.releaseArgs.push(destroy);
    },
  };

  class Pool {
    constructor(config) {
      record.poolConfigs.push(config);
    }
    async connect() {
      record.poolConnectCalls += 1;
      return client;
    }
    async end() {
      record.poolEndCalls += 1;
    }
  }

  return {
    runtime: {
      Connector,
      Pool,
      IpAddressTypes: { PRIVATE: "PRIVATE", PUBLIC: "PUBLIC" },
      AuthTypes: { IAM: "IAM", PASSWORD: "PASSWORD" },
    },
    record,
  };
}

export function captureWriter() {
  let value = "";
  return {
    stdout: {
      write(chunk) {
        value += chunk;
        return true;
      },
    },
    read() {
      return value;
    },
  };
}
