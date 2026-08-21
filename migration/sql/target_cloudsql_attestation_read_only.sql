\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\pset format unaligned

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '15s';
SET LOCAL search_path = pg_catalog;

SELECT jsonb_build_object(
  'collection', 'database_identity',
  'rows', jsonb_build_array(
    jsonb_build_object(
      'database_name', current_database(),
      'database_owner', pg_get_userbyid(database.datdba),
      'server_version_num', current_setting('server_version_num')::integer,
      'transaction_read_only', current_setting('transaction_read_only'),
      'current_role', current_user,
      'system_identifier', CASE
        WHEN has_function_privilege(current_user, 'pg_catalog.pg_control_system()', 'EXECUTE')
          THEN (SELECT system_identifier::text FROM pg_catalog.pg_control_system())
        ELSE NULL
      END,
      'allow_connections', database.datallowconn,
      'connection_limit', database.datconnlimit,
      'is_template', database.datistemplate
    )
  )
)
FROM pg_catalog.pg_database AS database
WHERE database.datname = current_database();

SELECT jsonb_build_object(
  'collection', 'schemas',
  'rows', COALESCE(jsonb_agg(to_jsonb(entry) ORDER BY entry.schema_name), '[]'::jsonb)
)
FROM (
  SELECT
    namespace.nspname AS schema_name,
    pg_get_userbyid(namespace.nspowner) AS owner,
    namespace.nspacl::text AS acl
  FROM pg_catalog.pg_namespace AS namespace
  WHERE namespace.nspname !~ '^pg_(temp|toast_temp)_'
) AS entry;

SELECT jsonb_build_object(
  'collection', 'relations',
  'rows', COALESCE(
    jsonb_agg(to_jsonb(entry) ORDER BY entry.schema_name, entry.relation_name),
    '[]'::jsonb
  )
)
FROM (
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
) AS entry;

SELECT jsonb_build_object(
  'collection', 'sequences',
  'rows', COALESCE(
    jsonb_agg(to_jsonb(entry) ORDER BY entry.schema_name, entry.sequence_name),
    '[]'::jsonb
  )
)
FROM (
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
) AS entry;

SELECT jsonb_build_object(
  'collection', 'functions',
  'rows', COALESCE(
    jsonb_agg(
      to_jsonb(entry)
      ORDER BY entry.schema_name, entry.function_name, entry.identity_arguments
    ),
    '[]'::jsonb
  )
)
FROM (
  SELECT
    namespace.nspname AS schema_name,
    procedure.proname AS function_name,
    pg_get_function_identity_arguments(procedure.oid) AS identity_arguments,
    pg_get_function_result(procedure.oid) AS result_type,
    procedure.prokind::text AS function_kind,
    language.lanname AS language,
    pg_get_userbyid(procedure.proowner) AS owner,
    procedure.prosecdef AS security_definer,
    procedure.proleakproof AS leakproof,
    procedure.provolatile::text AS volatility,
    procedure.proparallel::text AS parallel_safety,
    procedure.proconfig AS configuration,
    procedure.proacl::text AS acl,
    pg_get_functiondef(procedure.oid) AS definition
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_catalog.pg_language AS language ON language.oid = procedure.prolang
  WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'
) AS entry;

SELECT jsonb_build_object(
  'collection', 'triggers',
  'rows', COALESCE(
    jsonb_agg(
      to_jsonb(entry)
      ORDER BY entry.schema_name, entry.relation_name, entry.trigger_name
    ),
    '[]'::jsonb
  )
)
FROM (
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
) AS entry;

SELECT jsonb_build_object(
  'collection', 'extensions',
  'rows', COALESCE(jsonb_agg(to_jsonb(entry) ORDER BY entry.extension_name), '[]'::jsonb)
)
FROM (
  SELECT
    extension.extname AS extension_name,
    extension.extversion AS extension_version,
    namespace.nspname AS schema_name,
    pg_get_userbyid(extension.extowner) AS owner,
    extension.extrelocatable AS relocatable
  FROM pg_catalog.pg_extension AS extension
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
) AS entry;

SELECT jsonb_build_object(
  'collection', 'roles',
  'rows', COALESCE(jsonb_agg(to_jsonb(entry) ORDER BY entry.role_name), '[]'::jsonb)
)
FROM (
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
) AS entry;

SELECT jsonb_build_object(
  'collection', 'role_memberships',
  'rows', COALESCE(
    jsonb_agg(to_jsonb(entry) ORDER BY entry.role_name, entry.member_name, entry.grantor_name),
    '[]'::jsonb
  )
)
FROM (
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
) AS entry;

SELECT jsonb_build_object(
  'collection', 'object_ownership',
  'rows', COALESCE(
    jsonb_agg(
      to_jsonb(entry)
      ORDER BY entry.object_type, entry.schema_name, entry.object_name
    ),
    '[]'::jsonb
  )
)
FROM (
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
    procedure.proname || '(' || pg_get_function_identity_arguments(procedure.oid) || ')' AS object_name,
    pg_get_userbyid(procedure.proowner) AS owner
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'

  UNION ALL

  SELECT
    'schema' AS object_type,
    '' AS schema_name,
    namespace.nspname AS object_name,
    pg_get_userbyid(namespace.nspowner) AS owner
  FROM pg_catalog.pg_namespace AS namespace
  WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'
) AS entry;

SELECT jsonb_build_object(
  'collection', 'object_acls',
  'rows', COALESCE(
    jsonb_agg(
      to_jsonb(entry)
      ORDER BY entry.object_type, entry.schema_name, entry.object_name
    ),
    '[]'::jsonb
  )
)
FROM (
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
    procedure.proname || '(' || pg_get_function_identity_arguments(procedure.oid) || ')' AS object_name,
    procedure.proacl::text AS acl
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
    AND namespace.nspname !~ '^pg_(toast|temp|toast_temp)'

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
) AS entry;

SELECT jsonb_build_object(
  'collection', 'default_acls',
  'rows', COALESCE(
    jsonb_agg(
      to_jsonb(entry)
      ORDER BY entry.owner, entry.schema_name, entry.object_type
    ),
    '[]'::jsonb
  )
)
FROM (
  SELECT
    pg_get_userbyid(default_acl.defaclrole) AS owner,
    COALESCE(namespace.nspname, '') AS schema_name,
    default_acl.defaclobjtype::text AS object_type,
    default_acl.defaclacl::text AS acl
  FROM pg_catalog.pg_default_acl AS default_acl
  LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
) AS entry;

ROLLBACK;
