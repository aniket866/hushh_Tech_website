import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDmlOnlyRoleRow,
  createDatabaseRuntime,
  verifyDmlOnlyRuntime,
  withFirebaseTransaction,
} from "../src/database.js";
import { RuntimeError } from "../src/errors.js";

function runtimeCode(error, code) {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.code, code);
  return true;
}

function transactionClient({ leakedAfterCommit = false } = {}) {
  const calls = [];
  let contextReads = 0;
  const client = {
    releasedWith: null,
    async query(sql, parameters) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, parameters });
      if (normalized.includes("set_config('app.firebase_uid'")) {
        return { rows: [{ firebase_uid: parameters[0] }] };
      }
      if (normalized.includes("current_setting('app.firebase_uid'")) {
        contextReads += 1;
        return {
          rows: [
            {
              firebase_uid:
                leakedAfterCommit && contextReads === 1 ? "leaked-user" : null,
            },
          ],
        };
      }
      if (normalized === "SELECT 42 AS answer") {
        return { rows: [{ answer: 42 }] };
      }
      return { rows: [] };
    },
    release(error) {
      this.releasedWith = error ?? null;
    },
  };
  return { client, calls };
}

test("database transactions install a transaction-local Firebase UID and clear it", async () => {
  const { client, calls } = transactionClient();
  const pool = { connect: async () => client };
  const result = await withFirebaseTransaction(
    pool,
    "firebase-user-1",
    async (connection) => {
      const query = await connection.query("SELECT 42 AS answer");
      return query.rows[0].answer;
    },
    { statementTimeoutMs: 1_500 },
  );

  assert.equal(result, 42);
  assert.equal(client.releasedWith, null);
  assert.deepEqual(
    calls.slice(0, 5).map(({ sql }) => sql),
    [
      "RESET app.firebase_uid",
      "BEGIN",
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT set_config('app.firebase_uid', $1, true) AS firebase_uid",
      "SELECT 42 AS answer",
    ],
  );
  assert.deepEqual(calls[2].parameters, ["1500ms"]);
  assert.deepEqual(calls[3].parameters, ["firebase-user-1"]);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), true);
  assert.equal(
    calls.filter(({ sql }) => sql === "RESET app.firebase_uid").length,
    2,
  );
});

test("database transactions roll back failures and never carry user context", async () => {
  const { client, calls } = transactionClient();
  const pool = { connect: async () => client };
  const failure = new Error("handler failed");
  await assert.rejects(
    withFirebaseTransaction(pool, "firebase-user-2", async () => {
      throw failure;
    }),
    failure,
  );
  assert.equal(calls.some(({ sql }) => sql === "ROLLBACK"), true);
  assert.equal(calls.some(({ sql }) => sql === "COMMIT"), false);
  assert.equal(client.releasedWith, null);
});

test("a leaked transaction context destroys the pooled connection", async () => {
  const { client } = transactionClient({ leakedAfterCommit: true });
  await assert.rejects(
    withFirebaseTransaction(
      { connect: async () => client },
      "firebase-user-3",
      async () => "ok",
    ),
    (error) => runtimeCode(error, "DATABASE_CONTEXT_LEAK"),
  );
  assert.ok(client.releasedWith instanceof Error);
});

test("runtime role verification allows DML-only and destroys unsafe clients", async () => {
  const expectedUser =
    "hushh-tech-worker-uat@hushh-tech-uat.iam";
  const safeRow = {
    current_user: expectedUser,
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
    rolbypassrls: false,
    can_create_database: false,
    can_create_public_schema: false,
    application_schema_create_count: "0",
    inherited_privileged_role_count: "0",
    non_dml_table_privilege_count: "0",
    executable_application_routine_count: "0",
  };
  assert.equal(assertDmlOnlyRoleRow(safeRow, expectedUser), true);
  assert.throws(
    () => assertDmlOnlyRoleRow({ ...safeRow, rolsuper: true }, expectedUser),
    (error) => runtimeCode(error, "DATABASE_ROLE_UNSAFE"),
  );
  assert.throws(
    () =>
      assertDmlOnlyRoleRow(
        { ...safeRow, application_schema_create_count: "1" },
        expectedUser,
      ),
    (error) => runtimeCode(error, "DATABASE_ROLE_UNSAFE"),
  );
  assert.throws(
    () =>
      assertDmlOnlyRoleRow({ ...safeRow, rolbypassrls: true }, expectedUser),
    (error) => runtimeCode(error, "DATABASE_ROLE_UNSAFE"),
  );
  assert.throws(
    () =>
      assertDmlOnlyRoleRow(
        { ...safeRow, inherited_privileged_role_count: "1" },
        expectedUser,
      ),
    (error) => runtimeCode(error, "DATABASE_ROLE_UNSAFE"),
  );
  assert.throws(
    () =>
      assertDmlOnlyRoleRow(
        { ...safeRow, non_dml_table_privilege_count: "1" },
        expectedUser,
      ),
    (error) => runtimeCode(error, "DATABASE_ROLE_UNSAFE"),
  );

  let roleQuery = "";
  const safeClient = {
    releasedWith: null,
    query: async (sql) => {
      if (String(sql).includes("FROM pg_roles")) {
        roleQuery = String(sql);
        return { rows: [safeRow] };
      }
      return { rows: [] };
    },
    release(error) {
      this.releasedWith = error ?? null;
    },
  };
  assert.equal(
    await verifyDmlOnlyRuntime({ connect: async () => safeClient }, expectedUser),
    true,
  );
  assert.match(roleQuery, /WITH RECURSIVE effective_role_oids/);
  assert.match(roleQuery, /pg_auth_members/);
  assert.match(roleQuery, /rolbypassrls/);
  assert.match(roleQuery, /non_dml_table_privilege_count/);
  assert.match(roleQuery, /application_schema_create_count/);
  assert.match(roleQuery, /pg_namespace AS application_schemas/);
  assert.equal(safeClient.releasedWith, null);

  const unsafeClient = {
    ...safeClient,
    releasedWith: null,
    query: async (sql) =>
      String(sql).includes("FROM pg_roles")
        ? { rows: [{ ...safeRow, can_create_public_schema: true }] }
        : { rows: [] },
  };
  await assert.rejects(
    verifyDmlOnlyRuntime({ connect: async () => unsafeClient }, expectedUser),
    (error) => runtimeCode(error, "DATABASE_ROLE_UNSAFE"),
  );
  assert.ok(unsafeClient.releasedWith instanceof Error);
});

test("Cloud SQL connector is private, IAM-authenticated, bounded, and passwordless", async () => {
  const connectorCalls = [];
  class FakeConnector {
    constructor() {
      this.closed = false;
      FakeConnector.instance = this;
    }
    async getOptions(options) {
      connectorCalls.push(options);
      return { host: "10.114.0.3", ssl: { rejectUnauthorized: true } };
    }
    close() {
      this.closed = true;
    }
  }
  class FakePool {
    constructor(options) {
      this.options = options;
      FakePool.instance = this;
    }
    on() {}
    async end() {
      this.ended = true;
    }
  }
  const config = {
    instanceConnectionName:
      "hushh-tech-uat:us-central1:hushh-tech-app-pg-uat",
    databaseUser: "hushh-tech-worker-uat@hushh-tech-uat.iam",
    database: "hushh_tech_app",
    databasePoolMax: 5,
    databaseConnectTimeoutMs: 5_000,
    databaseStatementTimeoutMs: 15_000,
    serviceOwner: "worker",
  };
  const runtime = await createDatabaseRuntime({
    config,
    ConnectorClass: FakeConnector,
    PoolClass: FakePool,
  });
  assert.deepEqual(connectorCalls, [
    {
      instanceConnectionName: config.instanceConnectionName,
      ipType: "PRIVATE",
      authType: "IAM",
    },
  ]);
  assert.equal(FakePool.instance.options.user, config.databaseUser);
  assert.equal(FakePool.instance.options.database, "hushh_tech_app");
  assert.equal(FakePool.instance.options.max, 5);
  assert.equal("password" in FakePool.instance.options, false);
  await runtime.close();
  assert.equal(FakePool.instance.ended, true);
  assert.equal(FakeConnector.instance.closed, true);
});
