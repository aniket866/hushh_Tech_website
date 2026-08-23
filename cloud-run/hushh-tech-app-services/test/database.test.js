import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDmlOnlyRoleRow,
  createDatabaseRuntime,
  verifyDmlOnlyRuntime,
  withFirebaseTransaction,
} from "../src/database.js";
import { RuntimeError } from "../src/errors.js";
import {
  observedColumnPrivileges,
  observedSequencePrivileges,
  observedTablePrivileges,
  SERVICE_COLUMN_PRIVILEGE_ALLOWLISTS,
  SERVICE_SEQUENCE_PRIVILEGE_ALLOWLISTS,
  SERVICE_TABLE_PRIVILEGE_ALLOWLISTS,
} from "../src/table-privileges.js";

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
      if (normalized.includes("set_config('app.firebase_fund_admin'")) {
        return { rows: [{ firebase_fund_admin: parameters[0] }] };
      }
      if (normalized.includes("current_setting('app.firebase_uid'")) {
        contextReads += 1;
        return {
          rows: [
            {
              firebase_uid:
                leakedAfterCommit && contextReads === 1 ? "leaked-user" : null,
              firebase_fund_admin: null,
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
    calls.slice(0, 7).map(({ sql }) => sql),
    [
      "RESET app.firebase_uid",
      "RESET app.firebase_fund_admin",
      "BEGIN",
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT set_config('app.firebase_uid', $1, true) AS firebase_uid",
      "SELECT set_config('app.firebase_fund_admin', $1, true) AS firebase_fund_admin",
      "SELECT 42 AS answer",
    ],
  );
  assert.deepEqual(calls[3].parameters, ["1500ms"]);
  assert.deepEqual(calls[4].parameters, ["firebase-user-1"]);
  assert.deepEqual(calls[5].parameters, ["false"]);
  assert.equal(
    calls.some(({ sql }) => sql === "COMMIT"),
    true,
  );
  assert.equal(
    calls.filter(({ sql }) => sql === "RESET app.firebase_uid").length,
    2,
  );
  assert.equal(
    calls.filter(({ sql }) => sql === "RESET app.firebase_fund_admin").length,
    2,
  );
});

test("database transactions install fund admin only as a transaction-local boolean", async () => {
  const { client, calls } = transactionClient();
  await withFirebaseTransaction(
    { connect: async () => client },
    "firebase-fund-admin",
    async () => true,
    { fundAdmin: true },
  );
  const setting = calls.find(({ sql }) =>
    sql.includes("set_config('app.firebase_fund_admin'"),
  );
  assert.deepEqual(setting.parameters, ["true"]);
  assert.equal(
    calls.filter(({ sql }) => sql === "RESET app.firebase_fund_admin").length,
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
  assert.equal(
    calls.some(({ sql }) => sql === "ROLLBACK"),
    true,
  );
  assert.equal(
    calls.some(({ sql }) => sql === "COMMIT"),
    false,
  );
  assert.equal(client.releasedWith, null);
});

test("an aborted handler can never commit its database transaction", async () => {
  const { client, calls } = transactionClient();
  const controller = new AbortController();
  const deadline = new RuntimeError(
    "HANDLER_DEADLINE_EXCEEDED",
    "Service unavailable.",
    504,
  );
  await assert.rejects(
    withFirebaseTransaction(
      { connect: async () => client },
      "firebase-user-abort",
      async () => {
        controller.abort(deadline);
        return "must-not-commit";
      },
      { statementTimeoutMs: 1_000, signal: controller.signal },
    ),
    (error) => runtimeCode(error, "HANDLER_DEADLINE_EXCEEDED"),
  );
  assert.equal(
    calls.some(({ sql }) => sql === "ROLLBACK"),
    true,
  );
  assert.equal(
    calls.some(({ sql }) => sql === "COMMIT"),
    false,
  );
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
  const serviceOwner = "worker";
  const expectedUser = "hushh-tech-worker-uat@hushh-tech-uat.iam";
  const safeRow = {
    current_user: expectedUser,
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
    rolbypassrls: false,
    can_create_database: false,
    can_create_temporary_tables: false,
    can_create_public_schema: false,
    application_schema_create_count: "0",
    inherited_privileged_role_count: "0",
    non_dml_table_privilege_count: "0",
    executable_application_routine_count: "164",
    executable_security_definer_routine_count: "0",
    executable_procedure_count: "0",
    effective_table_dml_privileges: [],
    effective_column_privileges: [],
    effective_sequence_privileges: [],
    accessible_table_rls_disabled_count: "0",
    accessible_table_rls_not_forced_count: "0",
    owned_application_schema_count: "0",
    owned_application_table_count: "0",
    owned_application_sequence_count: "0",
    owned_application_routine_count: "0",
  };
  assert.equal(assertDmlOnlyRoleRow(safeRow, expectedUser, serviceOwner), true);
  assert.equal(
    assertDmlOnlyRoleRow(
      { ...safeRow, effective_table_dml_privileges: "[]" },
      expectedUser,
      serviceOwner,
    ),
    true,
  );
  assert.throws(
    () =>
      assertDmlOnlyRoleRow(
        { ...safeRow, rolsuper: true },
        expectedUser,
        serviceOwner,
      ),
    (error) => runtimeCode(error, "DATABASE_ROLE_UNSAFE"),
  );
  assert.throws(
    () =>
      assertDmlOnlyRoleRow(
        { ...safeRow, can_create_temporary_tables: true },
        expectedUser,
        serviceOwner,
      ),
    (error) => runtimeCode(error, "DATABASE_ROLE_UNSAFE"),
  );
  assert.throws(
    () =>
      assertDmlOnlyRoleRow(
        { ...safeRow, application_schema_create_count: "1" },
        expectedUser,
        serviceOwner,
      ),
    (error) => runtimeCode(error, "DATABASE_ROLE_UNSAFE"),
  );
  assert.throws(
    () =>
      assertDmlOnlyRoleRow(
        { ...safeRow, rolbypassrls: true },
        expectedUser,
        serviceOwner,
      ),
    (error) => runtimeCode(error, "DATABASE_ROLE_UNSAFE"),
  );
  assert.throws(
    () =>
      assertDmlOnlyRoleRow(
        { ...safeRow, inherited_privileged_role_count: "1" },
        expectedUser,
        serviceOwner,
      ),
    (error) => runtimeCode(error, "DATABASE_ROLE_UNSAFE"),
  );
  assert.throws(
    () =>
      assertDmlOnlyRoleRow(
        { ...safeRow, non_dml_table_privilege_count: "1" },
        expectedUser,
        serviceOwner,
      ),
    (error) =>
      runtimeCode(error, "DATABASE_ROLE_UNSAFE") &&
      error.diagnosticCode === "NON_DML_TABLE_PRIVILEGE_DRIFT",
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
    await verifyDmlOnlyRuntime(
      { connect: async () => safeClient },
      expectedUser,
      serviceOwner,
    ),
    true,
  );
  assert.match(roleQuery, /WITH RECURSIVE effective_role_oids/);
  assert.match(roleQuery, /pg_auth_members/);
  assert.match(roleQuery, /rolbypassrls/);
  assert.match(roleQuery, /non_dml_table_privilege_count/);
  assert.match(roleQuery, /'TEMPORARY'\) AS can_create_temporary_tables/);
  assert.match(roleQuery, /WITH GRANT OPTION/);
  assert.match(roleQuery, /'grantable'/);
  assert.match(roleQuery, /application_schema_create_count/);
  assert.match(roleQuery, /pg_namespace AS application_schemas/);
  assert.match(roleQuery, /effective_table_dml_privileges/);
  assert.match(roleQuery, /has_table_privilege/);
  assert.match(roleQuery, /effective_column_privileges/);
  assert.match(roleQuery, /pg_attribute/);
  assert.match(roleQuery, /aclexplode/);
  assert.match(roleQuery, /column_acl\.grantee = 0/);
  assert.match(roleQuery, /effective_sequence_privileges/);
  assert.match(roleQuery, /has_sequence_privilege/);
  assert.match(roleQuery, /accessible_base_relations/);
  assert.match(roleQuery, /relrowsecurity/);
  assert.match(roleQuery, /relforcerowsecurity/);
  assert.match(roleQuery, /owned_application_schema_count/);
  assert.match(roleQuery, /owned_application_table_count/);
  assert.match(roleQuery, /owned_application_sequence_count/);
  assert.match(roleQuery, /owned_application_routine_count/);
  assert.equal(roleQuery.includes("NOT LIKE 'pg\\_%' ESCAPE '\\'"), true);
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
    verifyDmlOnlyRuntime(
      { connect: async () => unsafeClient },
      expectedUser,
      serviceOwner,
    ),
    (error) => runtimeCode(error, "DATABASE_ROLE_UNSAFE"),
  );
  assert.ok(unsafeClient.releasedWith instanceof Error);
});

test("runtime readiness rejects broad DML, weak RLS, and application ownership", () => {
  const serviceOwner = "worker";
  const expectedUser = "hushh-tech-worker-uat@hushh-tech-uat.iam";
  const safeRow = {
    current_user: expectedUser,
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
    rolbypassrls: false,
    can_create_database: false,
    can_create_temporary_tables: false,
    can_create_public_schema: false,
    application_schema_create_count: "0",
    inherited_privileged_role_count: "0",
    non_dml_table_privilege_count: "0",
    executable_application_routine_count: "164",
    executable_security_definer_routine_count: "0",
    executable_procedure_count: "0",
    effective_table_dml_privileges: [],
    effective_column_privileges: [],
    effective_sequence_privileges: [],
    accessible_table_rls_disabled_count: "0",
    accessible_table_rls_not_forced_count: "0",
    owned_application_schema_count: "0",
    owned_application_table_count: "0",
    owned_application_sequence_count: "0",
    owned_application_routine_count: "0",
  };
  const unsafeCases = [
    {
      name: "broad table DML",
      change: {
        effective_table_dml_privileges: [
          {
            schema: "public",
            table: "profiles",
            privilege: "SELECT",
            kind: "r",
          },
        ],
      },
    },
    {
      name: "disabled RLS",
      change: { accessible_table_rls_disabled_count: "1" },
    },
    {
      name: "column-level access",
      change: {
        effective_column_privileges: [
          {
            schema: "public",
            table: "profiles",
            column: "email",
            privilege: "SELECT",
            kind: "r",
          },
        ],
      },
    },
    {
      name: "sequence access",
      change: {
        effective_sequence_privileges: [
          {
            schema: "public",
            sequence: "profiles_id_seq",
            privilege: "USAGE",
          },
        ],
      },
    },
    {
      name: "unforced RLS",
      change: { accessible_table_rls_not_forced_count: "1" },
    },
    {
      name: "schema ownership",
      change: { owned_application_schema_count: "1" },
    },
    {
      name: "table ownership",
      change: { owned_application_table_count: "1" },
    },
    {
      name: "sequence ownership",
      change: { owned_application_sequence_count: "1" },
    },
    {
      name: "routine ownership",
      change: { owned_application_routine_count: "1" },
    },
    {
      name: "security-definer routine execution",
      change: { executable_security_definer_routine_count: "1" },
    },
    {
      name: "procedure execution",
      change: { executable_procedure_count: "1" },
    },
  ];
  for (const { name, change } of unsafeCases) {
    assert.throws(
      () =>
        assertDmlOnlyRoleRow(
          { ...safeRow, ...change },
          expectedUser,
          serviceOwner,
        ),
      (error) => runtimeCode(error, "DATABASE_ROLE_UNSAFE"),
      name,
    );
  }
});

test("effective DML observations preserve and reject every grant option", () => {
  const table = {
    schema: "public",
    table: "profiles",
    privilege: "SELECT",
    kind: "r",
    grantable: false,
  };
  const column = {
    ...table,
    column: "email",
  };
  const sequence = {
    schema: "public",
    sequence: "profiles_id_seq",
    privilege: "USAGE",
    grantable: false,
  };
  assert.deepEqual(observedTablePrivileges([table]), [
    "public.profiles:SELECT",
  ]);
  assert.deepEqual(observedColumnPrivileges([column]), [
    "public.profiles.email:SELECT",
  ]);
  assert.deepEqual(observedSequencePrivileges([sequence]), [
    "public.profiles_id_seq:USAGE",
  ]);
  for (const [observe, entry] of [
    [observedTablePrivileges, table],
    [observedColumnPrivileges, column],
    [observedSequencePrivileges, sequence],
  ]) {
    assert.equal(observe([{ ...entry, grantable: true }]), null);
    assert.equal(observe([{ ...entry, grantable: "false" }]), null);
    assert.equal(observe([{ ...entry, grantable: undefined }]), null);
  }
});

test("only engagement has the exact five-column NDA read allowlist", () => {
  assert.deepEqual(Object.keys(SERVICE_TABLE_PRIVILEGE_ALLOWLISTS).sort(), [
    "content-api",
    "engagement-api-worker",
    "financial-api",
    "identity-api",
    "investor-api",
    "signed-webhook-service",
    "worker",
  ]);
  for (const privileges of Object.values(SERVICE_TABLE_PRIVILEGE_ALLOWLISTS)) {
    assert.deepEqual(privileges, []);
    assert.equal(Object.isFrozen(privileges), true);
  }
  assert.deepEqual(
    Object.keys(SERVICE_COLUMN_PRIVILEGE_ALLOWLISTS).sort(),
    Object.keys(SERVICE_TABLE_PRIVILEGE_ALLOWLISTS).sort(),
  );
  assert.deepEqual(
    Object.keys(SERVICE_SEQUENCE_PRIVILEGE_ALLOWLISTS).sort(),
    Object.keys(SERVICE_TABLE_PRIVILEGE_ALLOWLISTS).sort(),
  );
  assert.deepEqual(
    SERVICE_COLUMN_PRIVILEGE_ALLOWLISTS["engagement-api-worker"],
    [
      "public.nda_signatures.id:SELECT",
      "public.nda_signatures.nda_version:SELECT",
      "public.nda_signatures.pdf_url:SELECT",
      "public.nda_signatures.signed_at:SELECT",
      "public.nda_signatures.user_id:SELECT",
    ],
  );
  for (const [owner, privileges] of Object.entries(
    SERVICE_COLUMN_PRIVILEGE_ALLOWLISTS,
  )) {
    if (owner !== "engagement-api-worker") assert.deepEqual(privileges, []);
    assert.equal(Object.isFrozen(privileges), true);
  }
  for (const privileges of Object.values(
    SERVICE_SEQUENCE_PRIVILEGE_ALLOWLISTS,
  )) {
    assert.deepEqual(privileges, []);
    assert.equal(Object.isFrozen(privileges), true);
  }
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
    instanceConnectionName: "hushh-tech-uat:us-central1:hushh-tech-app-pg-uat",
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
  assert.equal(FakePool.instance.options.query_timeout, 15_000);
  assert.equal(FakePool.instance.options.statement_timeout, 15_000);
  assert.equal("password" in FakePool.instance.options, false);
  await runtime.close();
  assert.equal(FakePool.instance.ended, true);
  assert.equal(FakeConnector.instance.closed, true);
});
