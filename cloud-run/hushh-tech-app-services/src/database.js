import { Connector } from "@google-cloud/cloud-sql-connector";
import pg from "pg";

import { RuntimeError } from "./errors.js";
import {
  expectedColumnPrivileges,
  expectedSequencePrivileges,
  expectedTablePrivileges,
  observedColumnPrivileges,
  observedSequencePrivileges,
  observedTablePrivileges,
} from "./table-privileges.js";

const { Pool } = pg;
const FIREBASE_UID_LIMIT = 128;
const FIREBASE_PROJECT_IDS = new Set(["hushh-tech-uat", "hushh-tech-prod"]);
const TRANSACTION_ISOLATION_LEVELS = new Set(["read committed", "serializable"]);
const SECURITY_DEFINER_ROUTINES_BY_SERVICE = Object.freeze({
  "financial-api": Object.freeze([
    "hushh_identity.current_legacy_user_uuid()",
  ]),
  worker: Object.freeze(["hushh_identity.current_legacy_user_uuid()"]),
});

function validFirebaseUid(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= FIREBASE_UID_LIMIT &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validFirebaseProject(value) {
  return value === null || FIREBASE_PROJECT_IDS.has(value);
}

function expectedSecurityDefinerRoutines(serviceOwner, financialResolver) {
  return financialResolver === true
    ? SECURITY_DEFINER_ROUTINES_BY_SERVICE[serviceOwner] ?? []
    : [];
}

function observedSecurityDefinerRoutines(value) {
  let entries = value;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(entries)) return null;
  const routines = [];
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      entry.schema !== "hushh_identity" ||
      entry.routine !== "current_legacy_user_uuid" ||
      entry.arguments !== "" ||
      entry.grantable !== false
    ) {
      return null;
    }
    routines.push(`${entry.schema}.${entry.routine}()`);
  }
  routines.sort();
  return new Set(routines).size === routines.length ? routines : null;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof RuntimeError) throw signal.reason;
  throw new RuntimeError("HANDLER_ABORTED", "Service unavailable.", 503);
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
    query_timeout: config.databaseStatementTimeoutMs,
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

export function assertDmlOnlyRoleRow(
  row,
  expectedUser,
  serviceOwner,
  { financialResolver = false } = {},
) {
  const inheritedPrivilegedRoleCount = Number(
    row?.inherited_privileged_role_count,
  );
  const nonDmlTablePrivilegeCount = Number(row?.non_dml_table_privilege_count);
  const executableApplicationRoutineCount = Number(
    row?.executable_application_routine_count,
  );
  const executableSecurityDefinerRoutineCount = Number(
    row?.executable_security_definer_routine_count,
  );
  const executableProcedureCount = Number(row?.executable_procedure_count);
  const applicationSchemaCreateCount = Number(
    row?.application_schema_create_count,
  );
  const canCreateTemporaryTables = row?.can_create_temporary_tables;
  const accessibleTableRlsDisabledCount = Number(
    row?.accessible_table_rls_disabled_count,
  );
  const accessibleTableRlsNotForcedCount = Number(
    row?.accessible_table_rls_not_forced_count,
  );
  const ownedApplicationSchemaCount = Number(
    row?.owned_application_schema_count,
  );
  const ownedApplicationTableCount = Number(row?.owned_application_table_count);
  const ownedApplicationSequenceCount = Number(
    row?.owned_application_sequence_count,
  );
  const ownedApplicationRoutineCount = Number(
    row?.owned_application_routine_count,
  );
  const expectedTablePrivilegeList = expectedTablePrivileges(serviceOwner);
  const observedTablePrivilegeList = observedTablePrivileges(
    row?.effective_table_dml_privileges,
  );
  const expectedColumnPrivilegeList = expectedColumnPrivileges(serviceOwner);
  const observedColumnPrivilegeList = observedColumnPrivileges(
    row?.effective_column_privileges,
  );
  const expectedSequencePrivilegeList =
    expectedSequencePrivileges(serviceOwner);
  const observedSequencePrivilegeList = observedSequencePrivileges(
    row?.effective_sequence_privileges,
  );
  const expectedSecurityDefinerRoutineList =
    expectedSecurityDefinerRoutines(serviceOwner, financialResolver);
  const observedSecurityDefinerRoutineList = observedSecurityDefinerRoutines(
    row?.effective_security_definer_routines,
  );
  const exactTablePrivileges =
    observedTablePrivilegeList !== null &&
    observedTablePrivilegeList.length === expectedTablePrivilegeList.length &&
    observedTablePrivilegeList.every(
      (privilege, index) => privilege === expectedTablePrivilegeList[index],
    );
  const exactColumnPrivileges =
    observedColumnPrivilegeList !== null &&
    observedColumnPrivilegeList.length === expectedColumnPrivilegeList.length &&
    observedColumnPrivilegeList.every(
      (privilege, index) => privilege === expectedColumnPrivilegeList[index],
    );
  const exactSequencePrivileges =
    observedSequencePrivilegeList !== null &&
    observedSequencePrivilegeList.length ===
      expectedSequencePrivilegeList.length &&
    observedSequencePrivilegeList.every(
      (privilege, index) => privilege === expectedSequencePrivilegeList[index],
    );
  const exactSecurityDefinerRoutines =
    observedSecurityDefinerRoutineList !== null &&
    observedSecurityDefinerRoutineList.length ===
      expectedSecurityDefinerRoutineList.length &&
    observedSecurityDefinerRoutineList.every(
      (routine, index) => routine === expectedSecurityDefinerRoutineList[index],
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
    canCreateTemporaryTables !== false ||
    row.can_create_public_schema !== false ||
    !Number.isSafeInteger(applicationSchemaCreateCount) ||
    applicationSchemaCreateCount !== 0 ||
    !Number.isSafeInteger(inheritedPrivilegedRoleCount) ||
    inheritedPrivilegedRoleCount !== 0 ||
    !Number.isSafeInteger(nonDmlTablePrivilegeCount) ||
    nonDmlTablePrivilegeCount !== 0 ||
    !Number.isSafeInteger(executableApplicationRoutineCount) ||
    executableApplicationRoutineCount < 0 ||
    !Number.isSafeInteger(executableSecurityDefinerRoutineCount) ||
    executableSecurityDefinerRoutineCount !==
      expectedSecurityDefinerRoutineList.length ||
    !Number.isSafeInteger(executableProcedureCount) ||
    executableProcedureCount !== 0 ||
    !Number.isSafeInteger(accessibleTableRlsDisabledCount) ||
    accessibleTableRlsDisabledCount !== 0 ||
    !Number.isSafeInteger(accessibleTableRlsNotForcedCount) ||
    accessibleTableRlsNotForcedCount !== 0 ||
    !Number.isSafeInteger(ownedApplicationSchemaCount) ||
    ownedApplicationSchemaCount !== 0 ||
    !Number.isSafeInteger(ownedApplicationTableCount) ||
    ownedApplicationTableCount !== 0 ||
    !Number.isSafeInteger(ownedApplicationSequenceCount) ||
    ownedApplicationSequenceCount !== 0 ||
    !Number.isSafeInteger(ownedApplicationRoutineCount) ||
    ownedApplicationRoutineCount !== 0 ||
    !exactTablePrivileges ||
    !exactColumnPrivileges ||
    !exactSequencePrivileges ||
    !exactSecurityDefinerRoutines
  ) {
    let diagnosticCode = "ROLE_INVARIANT_DRIFT";
    if (!row || row.current_user !== expectedUser) {
      diagnosticCode = "ROLE_IDENTITY_DRIFT";
    } else if (
      row.rolsuper !== false ||
      row.rolcreaterole !== false ||
      row.rolcreatedb !== false ||
      row.rolreplication !== false ||
      row.rolbypassrls !== false
    ) {
      diagnosticCode = "ROLE_FLAG_DRIFT";
    } else if (row.can_create_database !== false) {
      diagnosticCode = "DATABASE_CREATE_PRIVILEGE_DRIFT";
    } else if (canCreateTemporaryTables !== false) {
      diagnosticCode = "DATABASE_TEMP_PRIVILEGE_DRIFT";
    } else if (
      row.can_create_public_schema !== false ||
      !Number.isSafeInteger(applicationSchemaCreateCount) ||
      applicationSchemaCreateCount !== 0
    ) {
      diagnosticCode = "SCHEMA_CREATE_PRIVILEGE_DRIFT";
    } else if (
      !Number.isSafeInteger(inheritedPrivilegedRoleCount) ||
      inheritedPrivilegedRoleCount !== 0
    ) {
      diagnosticCode = "INHERITED_PRIVILEGE_DRIFT";
    } else if (
      !Number.isSafeInteger(nonDmlTablePrivilegeCount) ||
      nonDmlTablePrivilegeCount !== 0
    ) {
      diagnosticCode = "NON_DML_TABLE_PRIVILEGE_DRIFT";
    } else if (
      !Number.isSafeInteger(executableApplicationRoutineCount) ||
      executableApplicationRoutineCount < 0
    ) {
      diagnosticCode = "ROUTINE_OBSERVATION_INVALID";
    } else if (
      !Number.isSafeInteger(executableSecurityDefinerRoutineCount) ||
      executableSecurityDefinerRoutineCount !==
        expectedSecurityDefinerRoutineList.length ||
      !exactSecurityDefinerRoutines
    ) {
      diagnosticCode = "SECURITY_DEFINER_EXECUTE_PRIVILEGE_DRIFT";
    } else if (
      !Number.isSafeInteger(executableProcedureCount) ||
      executableProcedureCount !== 0
    ) {
      diagnosticCode = "PROCEDURE_EXECUTE_PRIVILEGE_DRIFT";
    } else if (
      !Number.isSafeInteger(accessibleTableRlsDisabledCount) ||
      accessibleTableRlsDisabledCount !== 0
    ) {
      diagnosticCode = "ROW_SECURITY_DISABLED_DRIFT";
    } else if (
      !Number.isSafeInteger(accessibleTableRlsNotForcedCount) ||
      accessibleTableRlsNotForcedCount !== 0
    ) {
      diagnosticCode = "ROW_SECURITY_NOT_FORCED_DRIFT";
    } else if (
      !Number.isSafeInteger(ownedApplicationSchemaCount) ||
      ownedApplicationSchemaCount !== 0 ||
      !Number.isSafeInteger(ownedApplicationTableCount) ||
      ownedApplicationTableCount !== 0 ||
      !Number.isSafeInteger(ownedApplicationSequenceCount) ||
      ownedApplicationSequenceCount !== 0 ||
      !Number.isSafeInteger(ownedApplicationRoutineCount) ||
      ownedApplicationRoutineCount !== 0
    ) {
      diagnosticCode = "APPLICATION_OWNERSHIP_DRIFT";
    } else if (!exactTablePrivileges) {
      diagnosticCode = "TABLE_PRIVILEGE_ALLOWLIST_DRIFT";
    } else if (!exactColumnPrivileges) {
      diagnosticCode = "COLUMN_PRIVILEGE_ALLOWLIST_DRIFT";
    } else if (!exactSequencePrivileges) {
      diagnosticCode = "SEQUENCE_PRIVILEGE_ALLOWLIST_DRIFT";
    }
    throw new RuntimeError(
      "DATABASE_ROLE_UNSAFE",
      "Database role is not runtime-safe.",
      503,
      { diagnosticCode },
    );
  }
  return true;
}

export async function verifyDmlOnlyRuntime(
  pool,
  expectedUser,
  serviceOwner,
  { financialResolver = false } = {},
) {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query("RESET app.firebase_uid");
    await client.query("RESET app.firebase_fund_admin");
    await client.query("RESET app.firebase_project");
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
      ),
      application_relations AS (
        SELECT
          relations.oid,
          schemas.nspname AS schema_name,
          relations.relname AS table_name,
          relations.relkind,
          relations.relowner,
          relations.relrowsecurity,
          relations.relforcerowsecurity
        FROM pg_class AS relations
        INNER JOIN pg_namespace AS schemas
          ON schemas.oid = relations.relnamespace
        WHERE schemas.nspname <> 'information_schema'
          AND schemas.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
          AND relations.relkind IN ('r', 'p', 'v', 'm', 'f')
      ),
      effective_table_dml_privileges AS (
        SELECT DISTINCT
          relations.oid AS relation_oid,
          relations.schema_name,
          relations.table_name,
          relations.relkind,
          relations.relrowsecurity,
          relations.relforcerowsecurity,
          privilege_types.privilege_type,
          EXISTS (
            SELECT 1
            FROM effective_roles AS inherited
            WHERE has_table_privilege(
              inherited.rolname,
              relations.oid,
              privilege_types.privilege_type || ' WITH GRANT OPTION'
            )
          ) AS is_grantable
        FROM application_relations AS relations
        CROSS JOIN (
          VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')
        ) AS privilege_types(privilege_type)
        WHERE EXISTS (
          SELECT 1
          FROM effective_roles AS inherited
          WHERE has_table_privilege(
            inherited.rolname,
            relations.oid,
            privilege_types.privilege_type
          )
        )
      ),
      effective_column_privileges AS (
        SELECT
          relations.oid AS relation_oid,
          relations.schema_name,
          relations.table_name,
          relations.relkind,
          relations.relrowsecurity,
          relations.relforcerowsecurity,
          attributes.attname AS column_name,
          upper(column_acl.privilege_type) AS privilege_type,
          bool_or(column_acl.is_grantable) AS is_grantable
        FROM application_relations AS relations
        INNER JOIN pg_attribute AS attributes
          ON attributes.attrelid = relations.oid
          AND attributes.attnum > 0
          AND attributes.attisdropped IS NOT TRUE
        CROSS JOIN LATERAL aclexplode(attributes.attacl) AS column_acl
        WHERE column_acl.grantee = 0
          OR column_acl.grantee IN (
            SELECT oid FROM effective_role_oids
          )
        GROUP BY
          relations.oid,
          relations.schema_name,
          relations.table_name,
          relations.relkind,
          relations.relrowsecurity,
          relations.relforcerowsecurity,
          attributes.attname,
          upper(column_acl.privilege_type)
      ),
      application_sequences AS (
        SELECT
          sequences.oid,
          schemas.nspname AS schema_name,
          sequences.relname AS sequence_name,
          sequences.relowner
        FROM pg_class AS sequences
        INNER JOIN pg_namespace AS schemas
          ON schemas.oid = sequences.relnamespace
        WHERE schemas.nspname <> 'information_schema'
          AND schemas.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
          AND sequences.relkind = 'S'
      ),
      effective_sequence_privileges AS (
        SELECT DISTINCT
          sequences.oid AS sequence_oid,
          sequences.schema_name,
          sequences.sequence_name,
          privilege_types.privilege_type,
          EXISTS (
            SELECT 1
            FROM effective_roles AS inherited
            WHERE has_sequence_privilege(
              inherited.rolname,
              sequences.oid,
              privilege_types.privilege_type || ' WITH GRANT OPTION'
            )
          ) AS is_grantable
        FROM application_sequences AS sequences
        CROSS JOIN (
          VALUES ('SELECT'), ('UPDATE'), ('USAGE')
        ) AS privilege_types(privilege_type)
        WHERE EXISTS (
          SELECT 1
          FROM effective_roles AS inherited
          WHERE has_sequence_privilege(
            inherited.rolname,
            sequences.oid,
            privilege_types.privilege_type
          )
        )
      ),
      effective_security_definer_routines AS (
        SELECT DISTINCT
          schemas.nspname AS schema_name,
          routines.proname AS routine_name,
          pg_get_function_identity_arguments(routines.oid) AS arguments,
          EXISTS (
            SELECT 1
            FROM effective_roles AS inherited
            WHERE has_function_privilege(
              inherited.rolname,
              routines.oid,
              'EXECUTE WITH GRANT OPTION'
            )
          ) AS is_grantable
        FROM pg_proc AS routines
        INNER JOIN pg_namespace AS schemas
          ON schemas.oid = routines.pronamespace
        WHERE schemas.nspname NOT IN ('pg_catalog', 'information_schema')
          AND routines.prokind = 'f'
          AND routines.prosecdef IS TRUE
          AND EXISTS (
            SELECT 1
            FROM effective_roles AS inherited
            WHERE has_function_privilege(
              inherited.rolname,
              routines.oid,
              'EXECUTE'
            )
          )
      ),
      accessible_base_relations AS (
        SELECT DISTINCT
          privileges.relation_oid,
          privileges.relrowsecurity,
          privileges.relforcerowsecurity
        FROM effective_table_dml_privileges AS privileges
        WHERE privileges.relkind IN ('r', 'p')
        UNION
        SELECT DISTINCT
          privileges.relation_oid,
          privileges.relrowsecurity,
          privileges.relforcerowsecurity
        FROM effective_column_privileges AS privileges
        WHERE privileges.relkind IN ('r', 'p')
      )
      SELECT
        current_user,
        roles.rolsuper,
        roles.rolcreaterole,
        roles.rolcreatedb,
        roles.rolreplication,
        roles.rolbypassrls,
        has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database,
        has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_create_temporary_tables,
        has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public_schema,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'schema', privileges.schema_name,
                'table', privileges.table_name,
                'privilege', privileges.privilege_type,
                'kind', privileges.relkind,
                'grantable', privileges.is_grantable
              )
              ORDER BY
                privileges.schema_name,
                privileges.table_name,
                privileges.privilege_type
            )
            FROM effective_table_dml_privileges AS privileges
          ),
          '[]'::jsonb
        ) AS effective_table_dml_privileges,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'schema', privileges.schema_name,
                'table', privileges.table_name,
                'column', privileges.column_name,
                'privilege', privileges.privilege_type,
                'kind', privileges.relkind,
                'grantable', privileges.is_grantable
              )
              ORDER BY
                privileges.schema_name,
                privileges.table_name,
                privileges.column_name,
                privileges.privilege_type
            )
            FROM effective_column_privileges AS privileges
          ),
          '[]'::jsonb
        ) AS effective_column_privileges,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'schema', privileges.schema_name,
                'sequence', privileges.sequence_name,
                'privilege', privileges.privilege_type,
                'grantable', privileges.is_grantable
              )
              ORDER BY
                privileges.schema_name,
                privileges.sequence_name,
                privileges.privilege_type
            )
            FROM effective_sequence_privileges AS privileges
          ),
          '[]'::jsonb
        ) AS effective_sequence_privileges,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'schema', routines.schema_name,
                'routine', routines.routine_name,
                'arguments', routines.arguments,
                'grantable', routines.is_grantable
              )
              ORDER BY routines.schema_name, routines.routine_name, routines.arguments
            )
            FROM effective_security_definer_routines AS routines
          ),
          '[]'::jsonb
        ) AS effective_security_definer_routines,
        (
          SELECT count(*)
          FROM accessible_base_relations AS privileges
          WHERE privileges.relrowsecurity IS NOT TRUE
        ) AS accessible_table_rls_disabled_count,
        (
          SELECT count(*)
          FROM accessible_base_relations AS privileges
          WHERE privileges.relforcerowsecurity IS NOT TRUE
        ) AS accessible_table_rls_not_forced_count,
        (
          SELECT count(*)
          FROM pg_namespace AS owned_schemas
          WHERE owned_schemas.nspname <> 'information_schema'
            AND owned_schemas.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
            AND owned_schemas.nspowner IN (
              SELECT oid FROM effective_role_oids
            )
        ) AS owned_application_schema_count,
        (
          SELECT count(*)
          FROM pg_class AS owned_tables
          INNER JOIN pg_namespace AS owned_table_schemas
            ON owned_table_schemas.oid = owned_tables.relnamespace
          WHERE owned_table_schemas.nspname <> 'information_schema'
            AND owned_table_schemas.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
            AND owned_tables.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND owned_tables.relowner IN (
              SELECT oid FROM effective_role_oids
            )
        ) AS owned_application_table_count,
        (
          SELECT count(*)
          FROM application_sequences AS owned_sequences
          WHERE owned_sequences.relowner IN (
              SELECT oid FROM effective_role_oids
            )
        ) AS owned_application_sequence_count,
        (
          SELECT count(*)
          FROM pg_proc AS owned_routines
          INNER JOIN pg_namespace AS owned_routine_schemas
            ON owned_routine_schemas.oid = owned_routines.pronamespace
          WHERE owned_routine_schemas.nspname <> 'information_schema'
            AND owned_routine_schemas.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
            AND owned_routines.proowner IN (
              SELECT oid FROM effective_role_oids
            )
        ) AS owned_application_routine_count,
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
                  AND application_schemas.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
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
            AND application_schemas.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
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
            AND grants.table_schema NOT LIKE 'pg\\_%' ESCAPE '\\'
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
        ) AS executable_application_routine_count,
        (
          SELECT count(*)
          FROM pg_proc AS routines
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = routines.pronamespace
          WHERE schemas.nspname NOT IN ('pg_catalog', 'information_schema')
            AND routines.prosecdef IS TRUE
            AND EXISTS (
              SELECT 1
              FROM effective_roles AS inherited
              WHERE has_function_privilege(
                inherited.rolname,
                routines.oid,
                'EXECUTE'
              )
            )
        ) AS executable_security_definer_routine_count,
        (
          SELECT count(*)
          FROM pg_proc AS routines
          INNER JOIN pg_namespace AS schemas
            ON schemas.oid = routines.pronamespace
          WHERE schemas.nspname NOT IN ('pg_catalog', 'information_schema')
            AND routines.prokind = 'p'
            AND EXISTS (
              SELECT 1
              FROM effective_roles AS inherited
              WHERE has_function_privilege(
                inherited.rolname,
                routines.oid,
                'EXECUTE'
              )
            )
        ) AS executable_procedure_count
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
    return assertDmlOnlyRoleRow(result.rows[0], expectedUser, serviceOwner, {
      financialResolver,
    });
  } catch (error) {
    destroy = true;
    throw error;
  } finally {
    client.release(
      destroy ? new Error("Discard unsafe database client.") : undefined,
    );
  }
}

async function readFirebaseContext(client) {
  const result = await client.query(
    `SELECT
      current_setting('app.firebase_uid', true) AS firebase_uid,
      current_setting('app.firebase_fund_admin', true) AS firebase_fund_admin,
      current_setting('app.firebase_project', true) AS firebase_project`,
  );
  return Object.freeze({
    firebaseUid: result.rows[0]?.firebase_uid ?? null,
    firebaseFundAdmin: result.rows[0]?.firebase_fund_admin ?? null,
    firebaseProject: result.rows[0]?.firebase_project ?? null,
  });
}

export async function withFirebaseTransaction(
  pool,
  firebaseUid,
  work,
  {
    statementTimeoutMs = 15_000,
    signal,
    fundAdmin = false,
    firebaseProject = null,
    isolationLevel = "read committed",
  } = {},
) {
  if (
    !validFirebaseUid(firebaseUid) ||
    typeof work !== "function" ||
    typeof fundAdmin !== "boolean" ||
    !validFirebaseProject(firebaseProject) ||
    !TRANSACTION_ISOLATION_LEVELS.has(isolationLevel) ||
    !Number.isSafeInteger(statementTimeoutMs) ||
    statementTimeoutMs < 1
  ) {
    throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
  }

  throwIfAborted(signal);
  const client = await pool.connect();
  let transactionOpen = false;
  let result;
  let failure = null;
  let destroy = false;

  try {
    throwIfAborted(signal);
    await client.query("RESET app.firebase_uid");
    await client.query("RESET app.firebase_fund_admin");
    await client.query("RESET app.firebase_project");
    await client.query(
      isolationLevel === "serializable"
        ? "BEGIN ISOLATION LEVEL SERIALIZABLE"
        : "BEGIN",
    );
    transactionOpen = true;
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${statementTimeoutMs}ms`,
    ]);
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
    const adminContext = await client.query(
      "SELECT set_config('app.firebase_fund_admin', $1, true) AS firebase_fund_admin",
      [fundAdmin ? "true" : "false"],
    );
    if (
      adminContext.rows[0]?.firebase_fund_admin !==
      (fundAdmin ? "true" : "false")
    ) {
      throw new RuntimeError(
        "DATABASE_CONTEXT_REJECTED",
        "Database unavailable.",
        503,
      );
    }
    if (firebaseProject !== null) {
      const projectContext = await client.query(
        "SELECT set_config('app.firebase_project', $1, true) AS firebase_project",
        [firebaseProject],
      );
      if (projectContext.rows[0]?.firebase_project !== firebaseProject) {
        throw new RuntimeError(
          "DATABASE_CONTEXT_REJECTED",
          "Database unavailable.",
          503,
        );
      }
    }

    result = await work(client, signal);
    throwIfAborted(signal);
    await client.query("COMMIT");
    transactionOpen = false;
    const leaked = await readFirebaseContext(client);
    if (
      (leaked.firebaseUid !== null && leaked.firebaseUid !== "") ||
      (leaked.firebaseFundAdmin !== null &&
        leaked.firebaseFundAdmin !== "") ||
      (leaked.firebaseProject !== null && leaked.firebaseProject !== "")
    ) {
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
    await client.query("RESET app.firebase_fund_admin");
    await client.query("RESET app.firebase_project");
    const leaked = await readFirebaseContext(client);
    if (
      (leaked.firebaseUid !== null && leaked.firebaseUid !== "") ||
      (leaked.firebaseFundAdmin !== null &&
        leaked.firebaseFundAdmin !== "") ||
      (leaked.firebaseProject !== null && leaked.firebaseProject !== "")
    ) {
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
    client.release(
      destroy ? new Error("Discard contaminated database client.") : undefined,
    );
  }

  if (failure) throw failure;
  return result;
}

// The historical Plaid diagnostics endpoint was deliberately lossy and
// anonymous when no valid bearer was available. This is the only database
// transaction that may omit a Firebase UID: it binds the reviewed UAT project
// context, installs neither a user nor an admin flag, and is exposed by the
// request facade only to the exact diagnostics slug.
export async function withAnonymousPlaidDiagnosticsTransaction(
  pool,
  work,
  { statementTimeoutMs = 15_000, signal, firebaseProject = null } = {},
) {
  if (
    typeof work !== "function" ||
    firebaseProject !== "hushh-tech-uat" ||
    !Number.isSafeInteger(statementTimeoutMs) ||
    statementTimeoutMs < 1
  ) {
    throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
  }

  throwIfAborted(signal);
  const client = await pool.connect();
  let transactionOpen = false;
  let result;
  let failure = null;
  let destroy = false;

  try {
    throwIfAborted(signal);
    await client.query("RESET app.firebase_uid");
    await client.query("RESET app.firebase_fund_admin");
    await client.query("RESET app.firebase_project");
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${statementTimeoutMs}ms`,
    ]);
    const projectContext = await client.query(
      "SELECT set_config('app.firebase_project', $1, true) AS firebase_project",
      [firebaseProject],
    );
    if (projectContext.rows[0]?.firebase_project !== firebaseProject) {
      throw new RuntimeError(
        "DATABASE_CONTEXT_REJECTED",
        "Database unavailable.",
        503,
      );
    }

    result = await work(client, signal);
    throwIfAborted(signal);
    await client.query("COMMIT");
    transactionOpen = false;
    const leaked = await readFirebaseContext(client);
    if (
      (leaked.firebaseUid !== null && leaked.firebaseUid !== "") ||
      (leaked.firebaseFundAdmin !== null &&
        leaked.firebaseFundAdmin !== "") ||
      (leaked.firebaseProject !== null && leaked.firebaseProject !== "")
    ) {
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
    await client.query("RESET app.firebase_fund_admin");
    await client.query("RESET app.firebase_project");
    const leaked = await readFirebaseContext(client);
    if (
      (leaked.firebaseUid !== null && leaked.firebaseUid !== "") ||
      (leaked.firebaseFundAdmin !== null &&
        leaked.firebaseFundAdmin !== "") ||
      (leaked.firebaseProject !== null && leaked.firebaseProject !== "")
    ) {
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
    client.release(
      destroy ? new Error("Discard contaminated database client.") : undefined,
    );
  }

  if (failure) throw failure;
  return result;
}
