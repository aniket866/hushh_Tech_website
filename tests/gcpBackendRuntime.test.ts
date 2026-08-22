import { afterEach, describe, expect, it } from "vitest";

import dataHandler from "../api/gcp-data.js";
import { actorObjectPath, normalizeObjectPath } from "../api/gcp-storage.js";
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
  CLOUD_SQL_IAM_USER: "hushh-tech-web-uat@hushh-tech-uat.iam",
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
    expect(() => runtimeConfig({ ...validEnv(), GCP_PROJECT: "hushh-tech-prod" })).toThrow("UAT-only");
    expect(() => runtimeConfig({ ...validEnv(), CLOUD_SQL_DATABASE: "postgres" })).toThrow("authority");
    expect(() => runtimeConfig({ ...validEnv(), GCP_STORAGE_BUCKET_PREFIX: "other" })).toThrow("authority");
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
    expect(() => compileTableQuery({ table: "onboarding_data", operation: "delete", filters: [] })).toThrow("filters are required");
    expect(() => compileTableQuery({ table: "onboarding_data", operation: "update", values: { account_type: "x" }, filters: [] })).toThrow("filters are required");
    expect(() => compileTableQuery({ table: "onboarding_data", operation: "select", filters: [], limit: -1 })).toThrow("limit is invalid");
    expect(() => compileTableQuery({ table: "onboarding_data", operation: "select", filters: "all" })).toThrow("filters are invalid");
  });

  it("normalizes storage paths under the authenticated user and rejects traversal", () => {
    expect(actorObjectPath("user-a", "user-a/media/file.png")).toBe("user-a/media/file.png");
    expect(actorObjectPath("user-a", "user-b/media/file.png")).toBe("user-a/user-b/media/file.png");
    expect(actorObjectPath("user-a", "", { allowEmpty: true })).toBe("user-a/");
    expect(() => actorObjectPath("user/a", "media/file.png")).toThrow("Invalid storage actor");
    expect(() => actorObjectPath("..", "media/file.png")).toThrow("Invalid storage actor");
    for (const value of ["../secret", "media/../secret", "media//file", "media\\file", "media\u0000file"]) {
      expect(() => normalizeObjectPath(value)).toThrow("Invalid object path");
    }
  });

  it("rolls back before reporting a mutation cardinality mismatch", async () => {
    process.env = { ...process.env, ...validEnv() };
    const statements: string[] = [];
    const client = {
      async query(query: string | { text: string }) {
        const text = typeof query === "string" ? query : query.text;
        statements.push(text);
        if (text.startsWith("UPDATE")) return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
        return { rows: [], rowCount: null };
      },
      release() { statements.push("RELEASE"); },
    };
    const fakePool = { async connect() { return client; } };

    await expect(executeDataRequest({
      kind: "table",
      table: "onboarding_data",
      operation: "update",
      values: { account_type: "individual" },
      filters: [{ operator: "eq", column: "user_id", value: "legacy-user" }],
      cardinality: "single",
    }, "firebase-user", { pool: fakePool })).rejects.toMatchObject({ code: "CARDINALITY_MISMATCH" });

    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(statements.indexOf("ROLLBACK")).toBeGreaterThan(statements.findIndex((entry) => entry.startsWith("UPDATE")));
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
