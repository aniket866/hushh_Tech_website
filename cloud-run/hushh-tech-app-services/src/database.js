import { Connector } from "@google-cloud/cloud-sql-connector";
import pg from "pg";

import { RuntimeError } from "./errors.js";

const { Pool } = pg;
const FIREBASE_UID_LIMIT = 128;

function validFirebaseUid(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= FIREBASE_UID_LIMIT &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export async function createDatabaseRuntime({
  config,
  ConnectorClass = Connector,
  PoolClass = Pool,
  onPoolError = () => {},
} = {}) {
  if (!config) throw new Error("Database runtime configuration is required.");
  const connector = new ConnectorClass();
  let options;
  try {
    options = await connector.getOptions({
      instanceConnectionName: config.instanceConnectionName,
      ipType: "PRIVATE",
      authType: "IAM",
    });
  } catch (error) {
    connector.close();
    throw new RuntimeError(
      "DATABASE_UNAVAILABLE",
      "Database unavailable.",
      503,
      { cause: error },
    );
  }

  const pool = new PoolClass({
    ...options,
    user: config.databaseUser,
    database: config.database,
    max: config.databasePoolMax,
    min: 0,
    connectionTimeoutMillis: config.databaseConnectTimeoutMs,
    idleTimeoutMillis: 30_000,
    query_timeout: config.databaseStatementTimeoutMs + 1_000,
    statement_timeout: config.databaseStatementTimeoutMs,
    application_name: `hushh-tech-${config.serviceOwner}`,
  });
  pool.on?.("error", onPoolError);

  return Object.freeze({
    pool,
    connector,
    async close() {
      await pool.end();
      connector.close();
    },
  });
}

export function assertDmlOnlyRoleRow(row, expectedUser) {
  const inheritedPrivilegedRoleCount = Number(
    row?.inherited_privileged_role_count,
  );
  const nonDmlTablePrivilegeCount = Number(row?.non_dml_table_privilege_count);
  const executableApplicationRoutineCount = Number(
    row?.executable_application_routine_count,
  );
  const applicationSchemaCreateCount = Number(
    row?.application_schema_create_count,
  );
  if (
    !row ||
    row.current_user !== expectedUser ||
    row.rolsuper !== false ||
    row.rolcreaterole !== false ||
    row.rolcreatedb !== false ||
    row.rolreplication !== false ||
    row.rolbypassrls !== false ||
    row.can_create_database !== false ||
    row.can_create_public_schema !== false ||
    !Number.isSafeInteger(applicationSchemaCreateCount) ||
    applicationSchemaCreateCount !== 0 ||
    !Number.isSafeInteger(inheritedPrivilegedRoleCount) ||
    inheritedPrivilegedRoleCount !== 0 ||
    !Number.isSafeInteger(nonDmlTablePrivilegeCount) ||
    nonDmlTablePrivilegeCount !== 0 ||
    !Number.isSafeInteger(executableApplicationRoutineCount) ||
    executableApplicationRoutineCount !== 0
  ) {
    throw new RuntimeError(
      "DATABASE_ROLE_UNSAFE",
      "Database role is not runtime-safe.",
      503,
    );
  }
  return true;
}

export async function verifyDmlOnlyRuntime(pool, expectedUser) {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query("RESET app.firebase_uid");
    const result = await client.query(`
      WITH RECURSIVE effective_role_oids(oid) AS (
        SELECT oid
        FROM pg_roles
        WHERE rolname = current_user
        UNION
        SELECT memberships.roleid
        FROM pg_auth_members AS memberships
        INNER JOIN effective_role_oids AS inherited
          ON memberships.member = inherited.oid
      ),
      effective_roles AS (
        SELECT roles.*
        FROM pg_roles AS roles
        INNER JOIN effective_role_oids AS effective
          ON effective.oid = roles.oid
      )
      SELECT
        current_user,
        roles.rolsuper,
        roles.rolcreaterole,
        roles.rolcreatedb,
        roles.rolreplication,
        roles.rolbypassrls,
        has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database,
        has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public_schema,
        (
          SELECT count(*)
          FROM effective_roles AS inherited
          WHERE inherited.rolname <> current_user
            AND (
              inherited.rolsuper
              OR inherited.rolcreaterole
              OR inherited.rolcreatedb
              OR inherited.rolreplication
              OR inherited.rolbypassrls
              OR has_database_privilege(
                inherited.rolname,
                current_database(),
                'CREATE'
              )
              OR has_schema_privilege(
                inherited.rolname,
                'public',
                'CREATE'
              )
              OR EXISTS (
                SELECT 1
                FROM pg_namespace AS application_schemas
                WHERE application_schemas.nspname <> 'information_schema'
                  AND application_schemas.nspname NOT LIKE 'pg\_%' ESCAPE '\'
                  AND has_schema_privilege(
                    inherited.rolname,
                    application_schemas.oid,
                    'CREATE'
                  )
              )
            )
        ) AS inherited_privileged_role_count,
        (
          SELECT count(*)
          FROM pg_namespace AS application_schemas
          WHERE application_schemas.nspname <> 'information_schema'
            AND application_schemas.nspname NOT LIKE 'pg\_%' ESCAPE '\'
            AND has_schema_privilege(
              current_user,
              application_schemas.oid,
              'CREATE'
            )
        ) AS application_schema_create_count,
        (
          SELECT count(*)
          FROM information_schema.table_privileges AS grants
          WHERE grants.privilege_type NOT IN (
            'SELECT', 'INSERT', 'UPDATE', 'DELETE'
          )
            AND grants.table_schema <> 'information_schema'
            AND grants.table_schema NOT LIKE 'pg\_%' ESCAPE '\'
            AND (
              grants.grantee = 'PUBLIC'
              OR grants.grantee IN (
                SELECT inherited.rolname
                FROM effective_roles AS inherited
              )
            )
        ) AS non_dml_table_privilege_count,
        (
          SELECT count(*)
          FROM pg_proc AS routines
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = routines.pronamespace
          WHERE schemas.nspname NOT IN ('pg_catalog', 'information_schema')
            AND EXISTS (
              SELECT 1
              FROM effective_roles AS inherited
              WHERE has_function_privilege(
                inherited.rolname,
                routines.oid,
                'EXECUTE'
              )
            )
        ) AS executable_application_routine_count
      FROM pg_roles AS roles
      WHERE roles.rolname = current_user
    `);
    if (result.rows.length !== 1) {
      throw new RuntimeError(
        "DATABASE_ROLE_UNSAFE",
        "Database role is not runtime-safe.",
        503,
      );
    }
    return assertDmlOnlyRoleRow(result.rows[0], expectedUser);
  } catch (error) {
    destroy = true;
    throw error;
  } finally {
    client.release(destroy ? new Error("Discard unsafe database client.") : undefined);
  }
}

async function readFirebaseContext(client) {
  const result = await client.query(
    "SELECT current_setting('app.firebase_uid', true) AS firebase_uid",
  );
  return result.rows[0]?.firebase_uid ?? null;
}

export async function withFirebaseTransaction(
  pool,
  firebaseUid,
  work,
  { statementTimeoutMs = 15_000 } = {},
) {
  if (!validFirebaseUid(firebaseUid) || typeof work !== "function") {
    throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
  }

  const client = await pool.connect();
  let transactionOpen = false;
  let result;
  let failure = null;
  let destroy = false;

  try {
    await client.query("RESET app.firebase_uid");
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      "SELECT set_config('statement_timeout', $1, true)",
      [`${statementTimeoutMs}ms`],
    );
    const context = await client.query(
      "SELECT set_config('app.firebase_uid', $1, true) AS firebase_uid",
      [firebaseUid],
    );
    if (context.rows[0]?.firebase_uid !== firebaseUid) {
      throw new RuntimeError(
        "DATABASE_CONTEXT_REJECTED",
        "Database unavailable.",
        503,
      );
    }

    result = await work(client);
    await client.query("COMMIT");
    transactionOpen = false;
    const leaked = await readFirebaseContext(client);
    if (leaked !== null && leaked !== "") {
      destroy = true;
      throw new RuntimeError(
        "DATABASE_CONTEXT_LEAK",
        "Database unavailable.",
        503,
      );
    }
  } catch (error) {
    failure = error;
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
        transactionOpen = false;
      } catch (rollbackError) {
        destroy = true;
        failure = new RuntimeError(
          "DATABASE_UNAVAILABLE",
          "Database unavailable.",
          503,
          { cause: rollbackError },
        );
      }
    }
  }

  try {
    await client.query("RESET app.firebase_uid");
    const leaked = await readFirebaseContext(client);
    if (leaked !== null && leaked !== "") {
      destroy = true;
      failure ??= new RuntimeError(
        "DATABASE_CONTEXT_LEAK",
        "Database unavailable.",
        503,
      );
    }
  } catch (cleanupError) {
    destroy = true;
    failure ??= new RuntimeError(
      "DATABASE_UNAVAILABLE",
      "Database unavailable.",
      503,
      { cause: cleanupError },
    );
  } finally {
    client.release(destroy ? new Error("Discard contaminated database client.") : undefined);
  }

  if (failure) throw failure;
  return result;
}
