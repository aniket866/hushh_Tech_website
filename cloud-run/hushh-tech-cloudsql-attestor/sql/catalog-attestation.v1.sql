WITH
database_identity_rows AS (
  SELECT
    current_database() AS database_name,
    pg_get_userbyid(database.datdba) AS database_owner,
    current_setting('server_version_num')::integer AS server_version_num,
    current_setting('transaction_read_only') AS transaction_read_only,
    current_user AS current_role,
    CASE
      WHEN has_function_privilege(current_user, 'pg_catalog.pg_control_system()', 'EXECUTE')
        THEN (SELECT system_identifier::text FROM pg_catalog.pg_control_system())
      ELSE NULL
    END AS system_identifier,
    database.datallowconn AS allow_connections,
    database.datconnlimit AS connection_limit,
    database.datistemplate AS is_template
  FROM pg_catalog.pg_database AS database
  WHERE database.datname = current_database()
),
schema_rows AS (
  SELECT
    namespace.nspname AS schema_name,
    pg_get_userbyid(namespace.nspowner) AS owner,
    namespace.nspacl::text AS acl
  FROM pg_catalog.pg_namespace AS namespace
  WHERE namespace.nspname !~ '^pg_(temp|toast_temp)_'
),
relation_rows AS (
  SELECT
    namespace.nspname AS schema_name,
    relation.relname AS relation_name,
    relation.relkind::text AS relation_kind,
    relation.relpersistence::text AS persistence,
    pg_get_userbyid(relation.relowner) AS owner,
    relation.relrowsecurity AS row_security,
    relation.relforcerowsecurity AS force_row_security,
    relation.relacl::text AS acl,
    pg_catalog.obj_description(relation.oid, 'pg_class') AS comment
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'
),
sequence_rows AS (
  SELECT
    namespace.nspname AS schema_name,
    relation.relname AS sequence_name,
    pg_get_userbyid(relation.relowner) AS owner,
    format_type(sequence.seqtypid, NULL) AS data_type,
    sequence.seqstart AS start_value,
    sequence.seqincrement AS increment_by,
    sequence.seqmin AS minimum_value,
    sequence.seqmax AS maximum_value,
    sequence.seqcache AS cache_size,
    sequence.seqcycle AS cycle,
    relation.relacl::text AS acl
  FROM pg_catalog.pg_sequence AS sequence
  JOIN pg_catalog.pg_class AS relation ON relation.oid = sequence.seqrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'
),
function_rows AS (
  SELECT
    namespace.nspname AS schema_name,
    procedure.proname AS function_name,
    CASE WHEN procedure.prokind IN ('f', 'p')
      THEN pg_get_function_identity_arguments(procedure.oid)
      ELSE NULL
    END AS identity_arguments,
    CASE WHEN procedure.prokind IN ('f', 'p')
      THEN pg_get_function_result(procedure.oid)
      ELSE NULL
    END AS result_type,
    procedure.prokind::text AS function_kind,
    language.lanname AS language,
    pg_get_userbyid(procedure.proowner) AS owner,
    procedure.prosecdef AS security_definer,
    procedure.proleakproof AS leakproof,
    procedure.provolatile::text AS volatility,
    procedure.proparallel::text AS parallel_safety,
    procedure.proconfig AS configuration,
    procedure.proacl::text AS acl,
    CASE WHEN procedure.prokind IN ('f', 'p')
      THEN pg_get_functiondef(procedure.oid)
      ELSE NULL
    END AS definition
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_catalog.pg_language AS language ON language.oid = procedure.prolang
  WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'
    AND procedure.prokind IN ('f', 'p')
),
trigger_rows AS (
  SELECT
    namespace.nspname AS schema_name,
    relation.relname AS relation_name,
    trigger.tgname AS trigger_name,
    trigger.tgenabled::text AS enabled,
    pg_get_triggerdef(trigger.oid, true) AS definition
  FROM pg_catalog.pg_trigger AS trigger
  JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE NOT trigger.tgisinternal
    AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'
),
extension_rows AS (
  SELECT
    extension.extname AS extension_name,
    extension.extversion AS extension_version,
    namespace.nspname AS schema_name,
    pg_get_userbyid(extension.extowner) AS owner,
    extension.extrelocatable AS relocatable
  FROM pg_catalog.pg_extension AS extension
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
),
role_rows AS (
  SELECT
    role.rolname AS role_name,
    role.rolsuper AS superuser,
    role.rolinherit AS inherit,
    role.rolcreaterole AS create_role,
    role.rolcreatedb AS create_database,
    role.rolcanlogin AS login,
    role.rolreplication AS replication,
    role.rolbypassrls AS bypass_rls,
    role.rolconnlimit AS connection_limit,
    role.rolvaliduntil AS valid_until,
    role.rolconfig AS configuration,
    has_database_privilege(role.oid, current_database(), 'CONNECT') AS database_connect,
    has_database_privilege(role.oid, current_database(), 'CREATE') AS database_create,
    has_database_privilege(role.oid, current_database(), 'TEMPORARY') AS database_temporary
  FROM pg_catalog.pg_roles AS role
),
role_membership_rows AS (
  SELECT
    granted_role.rolname AS role_name,
    member_role.rolname AS member_name,
    grantor_role.rolname AS grantor_name,
    membership.admin_option,
    membership.inherit_option,
    membership.set_option
  FROM pg_catalog.pg_auth_members AS membership
  JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
  JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
  JOIN pg_catalog.pg_roles AS grantor_role ON grantor_role.oid = membership.grantor
),
object_ownership_rows AS (
  SELECT
    CASE relation.relkind
      WHEN 'S' THEN 'sequence'
      WHEN 'v' THEN 'view'
      WHEN 'm' THEN 'materialized_view'
      WHEN 'f' THEN 'foreign_table'
      WHEN 'p' THEN 'partitioned_table'
      ELSE 'table'
    END AS object_type,
    namespace.nspname AS schema_name,
    relation.relname AS object_name,
    pg_get_userbyid(relation.relowner) AS owner
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'

  UNION ALL

  SELECT
    'function' AS object_type,
    namespace.nspname AS schema_name,
    procedure.proname || '('
      || CASE WHEN procedure.prokind IN ('f', 'p')
        THEN pg_get_function_identity_arguments(procedure.oid)
        ELSE ''
      END
      || ')' AS object_name,
    pg_get_userbyid(procedure.proowner) AS owner
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'
    AND procedure.prokind IN ('f', 'p')

  UNION ALL

  SELECT
    'schema' AS object_type,
    '' AS schema_name,
    namespace.nspname AS object_name,
    pg_get_userbyid(namespace.nspowner) AS owner
  FROM pg_catalog.pg_namespace AS namespace
  WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'
),
object_acl_rows AS (
  SELECT
    CASE relation.relkind WHEN 'S' THEN 'sequence' ELSE 'relation' END AS object_type,
    namespace.nspname AS schema_name,
    relation.relname AS object_name,
    relation.relacl::text AS acl
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'

  UNION ALL

  SELECT
    'function' AS object_type,
    namespace.nspname AS schema_name,
    procedure.proname || '('
      || CASE WHEN procedure.prokind IN ('f', 'p')
        THEN pg_get_function_identity_arguments(procedure.oid)
        ELSE ''
      END
      || ')' AS object_name,
    procedure.proacl::text AS acl
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'
    AND procedure.prokind IN ('f', 'p')

  UNION ALL

  SELECT
    'schema' AS object_type,
    '' AS schema_name,
    namespace.nspname AS object_name,
    namespace.nspacl::text AS acl
  FROM pg_catalog.pg_namespace AS namespace
  WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'

  UNION ALL

  SELECT
    'database' AS object_type,
    '' AS schema_name,
    database.datname AS object_name,
    database.datacl::text AS acl
  FROM pg_catalog.pg_database AS database
  WHERE database.datname = current_database()
),
default_acl_rows AS (
  SELECT
    pg_get_userbyid(default_acl.defaclrole) AS owner,
    COALESCE(namespace.nspname, '') AS schema_name,
    default_acl.defaclobjtype::text AS object_type,
    default_acl.defaclacl::text AS acl
  FROM pg_catalog.pg_default_acl AS default_acl
  LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
),
target_role_effective_function_default_acls AS (
  SELECT
    role.oid AS owner_oid,
    COALESCE(
      global_default_acl.defaclacl,
      pg_catalog.acldefault('f', role.oid)
    ) AS acl
  FROM pg_catalog.pg_roles AS role
  LEFT JOIN pg_catalog.pg_default_acl AS global_default_acl
    ON global_default_acl.defaclrole = role.oid
    AND global_default_acl.defaclobjtype = 'f'
    AND global_default_acl.defaclnamespace = 0
  WHERE role.rolname IN (
    'hushh_tech_schema_owner',
    'hushh_tech_migration'
  )
),
baseline_observed AS (
  SELECT jsonb_build_object(
    'publicTables', (
      SELECT count(*)::integer
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
    ),
    'publicSequences', (
      SELECT count(*)::integer
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relkind = 'S'
    ),
    'publicTriggers', (
      SELECT count(*)::integer
      FROM pg_catalog.pg_trigger AS trigger
      JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND NOT trigger.tgisinternal
    ),
    'explicitIndexes', (
      SELECT count(*)::integer
      FROM pg_catalog.pg_index AS idx
      JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid = idx.indrelid
      JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = idx.indexrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_constraint AS con
          WHERE con.conindid = index_relation.oid
        )
    ),
    'forcedRlsTables', (
      SELECT count(*)::integer
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity
    ),
    'publicPolicies', (
      SELECT count(*)::integer
      FROM pg_catalog.pg_policies AS policy
      WHERE policy.schemaname = 'public'
        AND NOT (
          policy.tablename = 'nda_signatures'
          AND policy.policyname = 'nda_signatures_engagement_api_select'
        )
    ),
    'operationalPolicies', (
      SELECT count(*)::integer
      FROM pg_catalog.pg_policies AS policy
      WHERE policy.schemaname IN ('hushh_identity', 'hushh_migration')
    ),
    'executorPolicies', (
      SELECT count(*)::integer
      FROM pg_catalog.pg_policies AS policy
      WHERE policy.policyname LIKE '%executor_owner_all'
    ),
    'reviewedExtensions', (
      SELECT count(*)::integer
      FROM pg_catalog.pg_extension AS extension
      WHERE extension.extname IN ('pgcrypto', 'uuid-ossp', 'vector')
    ),
    'identityFunctions', (
      SELECT count(*)::integer
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'hushh_identity'
        AND procedure.proname IN ('current_firebase_uid', 'current_legacy_user_uuid')
    ),
    'migrationFunctions', (
      SELECT count(*)::integer
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'hushh_migration'
        AND procedure.proname = 'reject_audit_mutation'
    ),
    'triggerFunctions', (
      SELECT count(*)::integer
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname = ANY (ARRAY[
          'generate_investor_slug',
          'handle_new_user',
          'hushh_agents_set_updated_at',
          'hushh_agents_sync_conversation_preview',
          'hushh_agents_sync_match_from_swipe',
          'set_current_timestamp_updated_at',
          'update_onboarding_data_timestamp',
          'wa_set_updated_at'
        ])
    )
  ) AS observed
),
baseline_expected AS (
  SELECT jsonb_build_object(
    'publicTables', 70,
    'publicSequences', 0,
    'publicTriggers', 24,
    'explicitIndexes', 121,
    'forcedRlsTables', 70,
    'publicPolicies', 280,
    'operationalPolicies', 19,
    'executorPolicies', 0,
    'reviewedExtensions', 3,
    'identityFunctions', 2,
    'migrationFunctions', 1,
    'triggerFunctions', 8
  ) AS expected
),
baseline_comparison AS (
  SELECT jsonb_build_object(
    'status', CASE WHEN baseline_observed.observed = baseline_expected.expected THEN 'ATTESTED' ELSE 'BLOCKED' END,
    'sourceArtifact', 'migration/cloud-run/hushh-tech-schema-data-verifier-uat/expected-manifest.v1.json',
    'sourceExpectedSha256', 'a924487ab2660d2f7aa9226111a53de6539c590b52db4b2f2971bebc1ef774618',
    'expected', baseline_expected.expected,
    'observed', baseline_observed.observed,
    'matched', COALESCE((
      SELECT jsonb_agg(entry.key ORDER BY entry.key)
      FROM jsonb_each(baseline_expected.expected) AS entry
      WHERE baseline_observed.observed -> entry.key = entry.value
    ), '[]'::jsonb),
    'missing', '[]'::jsonb,
    'drifted', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'key', entry.key,
          'expected', entry.value,
          'observed', baseline_observed.observed -> entry.key
        ) ORDER BY entry.key
      )
      FROM jsonb_each(baseline_expected.expected) AS entry
      WHERE baseline_observed.observed -> entry.key IS DISTINCT FROM entry.value
    ), '[]'::jsonb),
    'unexpected', '[]'::jsonb
  ) AS comparison
  FROM baseline_observed, baseline_expected
),
safe_checks AS (
  SELECT jsonb_build_object(
    'databaseMatches', current_database() = 'hushh_tech_app',
    'auditRoleMatches', current_user = 'hushh-tech-audit-uat@hushh-tech-uat.iam',
    'postgres17', current_setting('server_version_num')::integer >= 170000
      AND current_setting('server_version_num')::integer < 180000,
    'transactionReadOnly', current_setting('transaction_read_only') = 'on',
    'applicationRelationsEmpty', (baseline_comparison.comparison ->> 'status') = 'ATTESTED'
      AND (baseline_comparison.comparison -> 'observed' ->> 'publicTables')::integer = 70,
    'applicationSequencesEmpty', (baseline_comparison.comparison ->> 'status') = 'ATTESTED'
      AND (baseline_comparison.comparison -> 'observed' ->> 'publicSequences')::integer = 0,
    'applicationFunctionsEmpty', (baseline_comparison.comparison ->> 'status') = 'ATTESTED'
      AND (baseline_comparison.comparison -> 'observed' ->> 'triggerFunctions')::integer = 8,
    'applicationTriggersEmpty', (baseline_comparison.comparison ->> 'status') = 'ATTESTED'
      AND (baseline_comparison.comparison -> 'observed' ->> 'publicTriggers')::integer = 24,
    'expectedRoleSetPresent', (
      SELECT count(*) = 5
      FROM pg_catalog.pg_roles
      WHERE rolname IN (
        'hushh_tech_schema_owner',
        'hushh_tech_migration',
        'hushh_tech_runtime',
        'hushh_tech_audit',
        'hushh_tech_rollback'
      )
    ),
    'roleFlagsSafe', NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles
      WHERE rolname IN (
        'hushh_tech_schema_owner',
        'hushh_tech_migration',
        'hushh_tech_runtime',
        'hushh_tech_audit',
        'hushh_tech_rollback',
        'hushh-tech-audit-uat@hushh-tech-uat.iam'
      )
        AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
    ),
    'auditTemporaryPrivilegeDenied', NOT has_database_privilege(
      'hushh-tech-audit-uat@hushh-tech-uat.iam',
      current_database(),
      'TEMPORARY'
    ),
    'auditDatabaseCreateDenied', NOT has_database_privilege(
      'hushh-tech-audit-uat@hushh-tech-uat.iam',
      current_database(),
      'CREATE'
    ),
    'auditPublicSchemaCreateDenied', NOT has_schema_privilege(
      'hushh-tech-audit-uat@hushh-tech-uat.iam',
      'public',
      'CREATE'
    ),
    'auditAllSchemaCreateDenied', NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_namespace AS candidate
      WHERE candidate.nspname NOT IN ('pg_catalog', 'information_schema')
        AND candidate.nspname !~ '^pg_(toast|temp|toast_temp)'
        AND has_schema_privilege(
          'hushh-tech-audit-uat@hushh-tech-uat.iam',
          candidate.oid,
          'CREATE'
        )
    ),
    'auditWritableMembershipDenied', NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS candidate
      WHERE candidate.rolname <> 'hushh-tech-audit-uat@hushh-tech-uat.iam'
        AND pg_has_role(
          'hushh-tech-audit-uat@hushh-tech-uat.iam',
          candidate.oid,
          'MEMBER'
        )
        AND (
          candidate.rolname NOT IN (
            'hushh_tech_audit',
            'pg_read_all_data',
            'cloudsqliamserviceaccount'
          )
          OR candidate.rolsuper
          OR candidate.rolcreaterole
          OR candidate.rolcreatedb
          OR candidate.rolreplication
          OR candidate.rolbypassrls
          OR has_database_privilege(candidate.oid, current_database(), 'CREATE,TEMPORARY')
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_namespace AS candidate_schema
            WHERE candidate_schema.nspname NOT IN ('pg_catalog', 'information_schema')
              AND candidate_schema.nspname !~ '^pg_(toast|temp|toast_temp)'
              AND has_schema_privilege(candidate.oid, candidate_schema.oid, 'CREATE')
          )
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class AS candidate_object
            JOIN pg_catalog.pg_namespace AS candidate_namespace
              ON candidate_namespace.oid = candidate_object.relnamespace
            WHERE candidate_object.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
              AND candidate_namespace.nspname NOT IN ('pg_catalog', 'information_schema')
              AND candidate_namespace.nspname !~ '^pg_(toast|temp|toast_temp)'
              AND (
                (
                  CASE WHEN candidate_object.relkind <> 'S'
                    THEN has_table_privilege(
                      candidate.oid,
                      candidate_object.oid,
                      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                    )
                    ELSE false
                  END
                )
                OR (
                  CASE WHEN candidate_object.relkind = 'S'
                    THEN has_sequence_privilege(
                      candidate.oid,
                      candidate_object.oid,
                      'USAGE,UPDATE'
                    )
                    ELSE false
                  END
                )
              )
          )
        )
    ),
    'auditWritableObjectPrivilegesDenied', NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS candidate
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = candidate.relnamespace
      WHERE candidate.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'
        AND (
          (
            CASE WHEN candidate.relkind <> 'S'
              THEN has_table_privilege(
                'hushh-tech-audit-uat@hushh-tech-uat.iam',
                candidate.oid,
                'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
              )
              ELSE false
            END
          )
          OR (
            CASE WHEN candidate.relkind = 'S'
              THEN has_sequence_privilege(
                'hushh-tech-audit-uat@hushh-tech-uat.iam',
                candidate.oid,
                'USAGE,UPDATE'
              )
              ELSE false
            END
          )
        )
    ),
    'auditWritableDefaultPrivilegesDenied', NOT EXISTS (
      SELECT 1 FROM (
        SELECT
          privilege.grantee,
          privilege.privilege_type
        FROM pg_catalog.pg_default_acl AS default_acl
        CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
        WHERE (
          (
            default_acl.defaclobjtype = 'r'
            AND privilege.privilege_type IN (
              'INSERT',
              'UPDATE',
              'DELETE',
              'TRUNCATE',
              'REFERENCES',
              'TRIGGER',
              'MAINTAIN'
            )
          )
          OR (
            default_acl.defaclobjtype = 'S'
            AND privilege.privilege_type IN ('USAGE', 'UPDATE')
          )
          OR (
            default_acl.defaclobjtype = 'f'
            AND privilege.privilege_type = 'EXECUTE'
          )
          OR (
            default_acl.defaclobjtype = 'n'
            AND privilege.privilege_type = 'CREATE'
          )
        )

        UNION ALL

        SELECT
          privilege.grantee,
          privilege.privilege_type
        FROM target_role_effective_function_default_acls AS effective_default
        CROSS JOIN LATERAL pg_catalog.aclexplode(effective_default.acl) AS privilege
        WHERE privilege.privilege_type = 'EXECUTE'
      ) AS writable_default
      WHERE writable_default.grantee = 0
        OR writable_default.grantee = (
          SELECT role.oid
          FROM pg_catalog.pg_roles AS role
          WHERE role.rolname = 'hushh-tech-audit-uat@hushh-tech-uat.iam'
        )
        OR pg_has_role(
          'hushh-tech-audit-uat@hushh-tech-uat.iam',
          writable_default.grantee,
          'MEMBER'
        )
    ),
    'catalogBoundsSatisfied', (baseline_comparison.comparison ->> 'status') = 'ATTESTED'
  ) AS checks,
    (SELECT comparison FROM baseline_comparison) AS baseline
  FROM baseline_comparison
),
collection_rows AS (
  SELECT
    1 AS ordinal,
    'database_identity'::text AS collection,
    count(*)::bigint AS row_count,
    encode(sha256(convert_to(COALESCE(jsonb_agg(encode(sha256(convert_to(to_jsonb(entry)::text, 'UTF8')), 'hex') ORDER BY entry.database_name), '[]'::jsonb)::text, 'UTF8')), 'hex') AS canonical_sha256
  FROM database_identity_rows AS entry

  UNION ALL

  SELECT
    2,
    'schemas',
    count(*)::bigint,
    encode(sha256(convert_to(COALESCE(jsonb_agg(encode(sha256(convert_to(to_jsonb(entry)::text, 'UTF8')), 'hex') ORDER BY entry.schema_name), '[]'::jsonb)::text, 'UTF8')), 'hex')
  FROM schema_rows AS entry

  UNION ALL

  SELECT
    3,
    'relations',
    count(*)::bigint,
    encode(sha256(convert_to(COALESCE(jsonb_agg(encode(sha256(convert_to(to_jsonb(entry)::text, 'UTF8')), 'hex') ORDER BY entry.schema_name, entry.relation_name), '[]'::jsonb)::text, 'UTF8')), 'hex')
  FROM relation_rows AS entry

  UNION ALL

  SELECT
    4,
    'sequences',
    count(*)::bigint,
    encode(sha256(convert_to(COALESCE(jsonb_agg(encode(sha256(convert_to(to_jsonb(entry)::text, 'UTF8')), 'hex') ORDER BY entry.schema_name, entry.sequence_name), '[]'::jsonb)::text, 'UTF8')), 'hex')
  FROM sequence_rows AS entry

  UNION ALL

  SELECT
    5,
    'functions',
    count(*)::bigint,
    encode(sha256(convert_to(COALESCE(jsonb_agg(encode(sha256(convert_to(to_jsonb(entry)::text, 'UTF8')), 'hex') ORDER BY entry.schema_name, entry.function_name, entry.identity_arguments), '[]'::jsonb)::text, 'UTF8')), 'hex')
  FROM function_rows AS entry

  UNION ALL

  SELECT
    6,
    'triggers',
    count(*)::bigint,
    encode(sha256(convert_to(COALESCE(jsonb_agg(encode(sha256(convert_to(to_jsonb(entry)::text, 'UTF8')), 'hex') ORDER BY entry.schema_name, entry.relation_name, entry.trigger_name), '[]'::jsonb)::text, 'UTF8')), 'hex')
  FROM trigger_rows AS entry

  UNION ALL

  SELECT
    7,
    'extensions',
    count(*)::bigint,
    encode(sha256(convert_to(COALESCE(jsonb_agg(encode(sha256(convert_to(to_jsonb(entry)::text, 'UTF8')), 'hex') ORDER BY entry.extension_name), '[]'::jsonb)::text, 'UTF8')), 'hex')
  FROM extension_rows AS entry

  UNION ALL

  SELECT
    8,
    'roles',
    count(*)::bigint,
    encode(sha256(convert_to(COALESCE(jsonb_agg(encode(sha256(convert_to(to_jsonb(entry)::text, 'UTF8')), 'hex') ORDER BY entry.role_name), '[]'::jsonb)::text, 'UTF8')), 'hex')
  FROM role_rows AS entry

  UNION ALL

  SELECT
    9,
    'role_memberships',
    count(*)::bigint,
    encode(sha256(convert_to(COALESCE(jsonb_agg(encode(sha256(convert_to(to_jsonb(entry)::text, 'UTF8')), 'hex') ORDER BY entry.role_name, entry.member_name, entry.grantor_name), '[]'::jsonb)::text, 'UTF8')), 'hex')
  FROM role_membership_rows AS entry

  UNION ALL

  SELECT
    10,
    'object_ownership',
    count(*)::bigint,
    encode(sha256(convert_to(COALESCE(jsonb_agg(encode(sha256(convert_to(to_jsonb(entry)::text, 'UTF8')), 'hex') ORDER BY entry.object_type, entry.schema_name, entry.object_name), '[]'::jsonb)::text, 'UTF8')), 'hex')
  FROM object_ownership_rows AS entry

  UNION ALL

  SELECT
    11,
    'object_acls',
    count(*)::bigint,
    encode(sha256(convert_to(COALESCE(jsonb_agg(encode(sha256(convert_to(to_jsonb(entry)::text, 'UTF8')), 'hex') ORDER BY entry.object_type, entry.schema_name, entry.object_name), '[]'::jsonb)::text, 'UTF8')), 'hex')
  FROM object_acl_rows AS entry

  UNION ALL

  SELECT
    12,
    'default_acls',
    count(*)::bigint,
    encode(sha256(convert_to(COALESCE(jsonb_agg(encode(sha256(convert_to(to_jsonb(entry)::text, 'UTF8')), 'hex') ORDER BY entry.owner, entry.schema_name, entry.object_type), '[]'::jsonb)::text, 'UTF8')), 'hex')
  FROM default_acl_rows AS entry
)
SELECT
  collection,
  row_count::text AS row_count,
  canonical_sha256,
  CASE WHEN ordinal = 1 THEN (SELECT checks FROM safe_checks) ELSE NULL END AS checks,
  CASE WHEN ordinal = 1 THEN (SELECT baseline FROM safe_checks) ELSE NULL END AS baseline
FROM collection_rows
ORDER BY ordinal;
