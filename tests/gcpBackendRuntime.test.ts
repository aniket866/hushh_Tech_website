import { afterEach, describe, expect, it } from "vitest";

import dataHandler from "../api/gcp-data.js";
import { actorObjectPath, normalizeObjectPath } from "../api/gcp-storage.js";
import {
  compileTableQuery,
  compileRpcQuery,
  executeDataRequest,
  BLOCKED_RPCS,
  BLOCKED_STORAGE_BUCKETS,
  BLOCKED_TABLES,
  RPC_NAMES,
  resolveLegacyUserUuid,
  runtimeConfig,
  STORAGE_BUCKETS,
  storageRuntime,
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
    expect(BLOCKED_RPCS.has("sign_global_nda")).toBe(true);
    expect(BLOCKED_TABLES.has("hushh_ai_users")).toBe(true);
    expect(BLOCKED_STORAGE_BUCKETS.has("assets")).toBe(true);
    expect(RPC_NAMES.has("sign_global_nda")).toBe(false);
    expect(STORAGE_BUCKETS.has("assets")).toBe(false);
    expect((TABLE_OPERATIONS as Record<string, unknown>).arbitrary_table).toBeUndefined();
    expect(RPC_NAMES.has("arbitrary_rpc")).toBe(false);
    expect(STORAGE_BUCKETS.has("arbitrary-bucket")).toBe(false);
    expect([...RPC_NAMES].sort()).toEqual([
      "check_user_nda_status",
      "sign_global_nda",
      "track_product_usage",
    ]);
  });

  it("compiles NDA status with server-derived identity and rejects cross-user arguments", () => {
    const query = compileRpcQuery({
      kind: "rpc",
      name: "check_user_nda_status",
      args: { p_user_id: "firebase-user" },
    }, "firebase-user");

    expect(query.values).toEqual([]);
    expect(query.text).toContain("hushh_identity.current_legacy_user_uuid()");
    expect(query.text).toContain("public.nda_signatures");
    expect(() => compileRpcQuery({
      kind: "rpc",
      name: "check_user_nda_status",
      args: { p_user_id: "another-user" },
    }, "firebase-user")).toThrow(/identity does not match/);
  });

  it("compiles product usage as an atomic, user-scoped upsert", () => {
    const query = compileRpcQuery({
      kind: "rpc",
      name: "track_product_usage",
      args: { p_product_name: "hushh-ai", p_metadata: { platform: "web" } },
    }, "firebase-user");

    expect(query.values).toEqual(["hushh-ai", { platform: "web" }]);
    expect(query.text).toContain("current_legacy_user_uuid()");
    expect(query.text).toContain("ON CONFLICT (user_id, product_name) DO UPDATE");
    expect(query.text).toContain("usage_count = public.user_product_usage.usage_count + 1");
    expect(query.text).not.toContain("p_user_id");
    expect(() => compileRpcQuery({
      kind: "rpc",
      name: "track_product_usage",
      args: { p_product_name: "" },
    }, "firebase-user")).toThrow(/Product name is invalid/);
  });

  it("compiles NDA signing with an atomic upsert and no client-selected user", () => {
    const query = compileRpcQuery({
      kind: "rpc",
      name: "sign_global_nda",
      args: {
        p_signer_name: "Ada Example",
        p_nda_version: "v1.0",
        p_pdf_url: null,
        p_signer_ip: "unknown",
        p_documents_acknowledged: ["fund-a"],
        p_consent_version: "2026-06-02",
      },
    }, "firebase-user");

    expect(query.values).toEqual([
      "Ada Example",
      "v1.0",
      null,
      "unknown",
      ["fund-a"],
      "2026-06-02",
    ]);
    expect(query.text).toContain("current_legacy_user_uuid()");
    expect(query.text).toContain("ON CONFLICT (user_id) DO UPDATE");
    expect(query.text).toContain("documents_acknowledged");
    expect(query.text).not.toContain("p_user_id");
  });

  it("does not invoke withheld or public RPCs through the authenticated data path", () => {
    for (const name of [
      "get_public_investor_profile",
      "increment_hushh_ai_uploads",
      "increment_intelligence_uploads",
    ]) {
      expect(() => compileRpcQuery({ kind: "rpc", name, args: {} }, "firebase-user"))
        .toThrow(/not manifested/);
    }
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

  it("returns scalar RPC compatibility data and commits the transaction", async () => {
    process.env = { ...process.env, ...validEnv() };
    const statements: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      async query(query: string | { text: string; values?: unknown[] }, values?: unknown[]) {
        const text = typeof query === "string" ? query : query.text;
        const queryValues = typeof query === "string" ? values : query.values;
        statements.push({ text, values: queryValues });
        if (text.includes("AS result")) return { rows: [{ result: { success: true } }], rowCount: 1 };
        return { rows: [], rowCount: null };
      },
      release() {},
    };
    const fakePool = { async connect() { return client; } };

    await expect(executeDataRequest({
      kind: "rpc",
      name: "track_product_usage",
      args: { p_product_name: "hushh-ai", p_metadata: {} },
    }, "firebase-user", { pool: fakePool })).resolves.toEqual({
      data: { success: true },
      count: 1,
    });
    expect(statements.map(({ text }) => text)).toContain("COMMIT");
  });

  it("requires a Firebase bearer before any data operation", async () => {
    process.env = { ...process.env, ...validEnv() };
    await expect(verifyFirebaseBearer("")).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
  });

  it("fails blocked data, RPC, and storage contracts before opening a target", async () => {
    process.env = { ...process.env, ...validEnv() };
    await expect(executeDataRequest({ kind: "table", table: "hushh_ai_users", operation: "select" }, "uid"))
      .rejects.toMatchObject({ status: 503, code: "DATA_CONTRACT_BLOCKED" });
    await expect(executeDataRequest({ kind: "rpc", name: "sign_global_nda", args: {} }, "uid"))
      .rejects.toMatchObject({ status: 503, code: "RPC_CONTRACT_BLOCKED" });
    expect(() => storageRuntime().bucket("assets")).toThrow("Storage contract is not available in UAT");
  });

  it("resolves Firebase users to migrated legacy UUIDs inside the runtime context", async () => {
    process.env = { ...process.env, ...validEnv() };
    const legacyUserId = "00000000-0000-4000-8000-000000000001";
    const statements: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      async query(query: string | { text: string }, values?: unknown[]) {
        const text = typeof query === "string" ? query : query.text;
        statements.push({ text, values });
        if (text.includes("current_legacy_user_uuid")) {
          return { rows: [{ legacy_user_uuid: legacyUserId }], rowCount: 1 };
        }
        return { rows: [], rowCount: null };
      },
      release() { statements.push({ text: "RELEASE" }); },
    };
    const fakePool = { async connect() { return client; } };

    await expect(resolveLegacyUserUuid("firebase-user", { pool: fakePool })).resolves.toBe(legacyUserId);

    expect(statements).toEqual([
      { text: "BEGIN", values: undefined },
      { text: "SELECT set_config('app.firebase_uid', $1, true)", values: ["firebase-user"] },
      { text: "SELECT hushh_identity.current_legacy_user_uuid() AS legacy_user_uuid", values: undefined },
      { text: "COMMIT", values: undefined },
      { text: "RESET app.firebase_uid", values: undefined },
      { text: "RELEASE" },
    ]);
  });

  it("returns null when a Firebase user has no active legacy identity link", async () => {
    process.env = { ...process.env, ...validEnv() };
    const client = {
      async query() { return { rows: [{ legacy_user_uuid: null }], rowCount: 1 }; },
      release() {},
    };
    const fakePool = { async connect() { return client; } };

    await expect(resolveLegacyUserUuid("firebase-user", { pool: fakePool })).resolves.toBeNull();
  });

  it.each([
    "firebase-user-a",
    "firebase-user-b",
    "firebase-admin",
  ])("rejects the local browser fixture token for %s at the real verifier", async (persona) => {
    process.env = { ...process.env, ...validEnv() };
    await expect(
      verifyFirebaseBearer(`Bearer no-hybrid-local-fixture:${persona}`),
    ).rejects.toThrow();
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
