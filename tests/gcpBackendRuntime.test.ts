import { afterEach, describe, expect, it } from "vitest";

import dataHandler from "../api/gcp-data.js";
import {
  compileTableQuery,
  executeDataRequest,
  RPC_NAMES,
  runtimeConfig,
  STORAGE_BUCKETS,
  TABLE_OPERATIONS,
  verifyFirebaseBearer,
} from "../api/shared/gcpDataRuntime.js";

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

const validEnv = () => ({
  GCP_DATA_RUNTIME_ENABLED: "true",
  GOOGLE_CLOUD_PROJECT: "hushh-tech-uat",
  CLOUD_SQL_INSTANCE_CONNECTION_NAME: "hushh-tech-uat:us-central1:hushh-tech-app-pg-uat",
  CLOUD_SQL_DATABASE: "hushh_tech_app",
  CLOUD_SQL_IAM_USER: "web@hushh-tech-uat.iam",
  FIREBASE_PROJECT_ID: "hushh-tech-uat",
  GCP_STORAGE_BUCKET_PREFIX: "hushh-tech-uat",
});

describe("GCP backend runtime boundary", () => {
  it("is default-off and cannot point at production", () => {
    expect(() => runtimeConfig({})).toThrow("not enabled");
    expect(() => runtimeConfig({ ...validEnv(), GOOGLE_CLOUD_PROJECT: "hushh-tech-prod" })).toThrow("UAT-only");
  });

  it("pins every authority to the UAT project", () => {
    const config = runtimeConfig(validEnv());
    expect(config).toEqual(expect.objectContaining({
      instanceConnectionName: "hushh-tech-uat:us-central1:hushh-tech-app-pg-uat",
      database: "hushh_tech_app",
      firebaseProjectId: "hushh-tech-uat",
    }));
    expect(() => runtimeConfig({ ...validEnv(), FIREBASE_PROJECT_ID: "hushh-tech-prod" })).toThrow("authority");
  });

  it("uses an explicit operation/table/RPC/bucket manifest", () => {
    expect(Object.keys(TABLE_OPERATIONS).length).toBeGreaterThan(40);
    expect(TABLE_OPERATIONS.onboarding_data).toContain("upsert");
    expect(RPC_NAMES.has("sign_global_nda")).toBe(true);
    expect(STORAGE_BUCKETS.has("assets")).toBe(true);
    expect((TABLE_OPERATIONS as Record<string, unknown>).arbitrary_table).toBeUndefined();
    expect(RPC_NAMES.has("arbitrary_rpc")).toBe(false);
    expect(STORAGE_BUCKETS.has("arbitrary-bucket")).toBe(false);
  });

  it("parameterizes values and rejects identifier injection", () => {
    const query = compileTableQuery({
      kind: "table",
      table: "onboarding_data",
      operation: "select",
      columns: "user_id,account_type",
      filters: [{ operator: "eq", column: "user_id", value: "x' OR TRUE --" }],
      orders: [{ column: "user_id", ascending: true }],
      limit: 1,
    });
    expect(query.text).toContain('"user_id" = $1');
    expect(query.text).not.toContain("OR TRUE");
    expect(query.values).toEqual(["x' OR TRUE --"]);
    expect(() => compileTableQuery({ table: "onboarding_data;DROP TABLE users", operation: "select" })).toThrow("not manifested");
    expect(() => compileTableQuery({ table: "onboarding_data", operation: "select", columns: "*,users(*)" })).toThrow("flat manifested columns");
  });

  it("requires a Firebase bearer before any data operation", async () => {
    process.env = { ...process.env, ...validEnv() };
    await expect(verifyFirebaseBearer("")).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
  });

  it("fails closed before opening Cloud SQL when the switch is off", async () => {
    process.env.GCP_DATA_RUNTIME_ENABLED = "false";
    await expect(executeDataRequest({ kind: "table", table: "users", operation: "select" }, "uid"))
      .rejects.toMatchObject({ status: 503, code: "GCP_DATA_DISABLED" });
  });

  it("returns a sanitized default-off API response", async () => {
    process.env.GCP_DATA_RUNTIME_ENABLED = "false";
    const req = { method: "POST", headers: {}, body: {} };
    let status = 0;
    let payload: any = null;
    const res = {
      status(value: number) { status = value; return this; },
      json(value: unknown) { payload = value; return this; },
      setHeader() {},
    };
    await dataHandler(req as any, res as any);
    expect(status).toBe(503);
    expect(payload).toEqual({ error: { code: "GCP_DATA_DISABLED", message: "GCP data service unavailable." } });
  });
});
