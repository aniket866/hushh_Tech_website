BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ;

SELECT jsonb_build_object(
  'schema_version', 1,
  'source_project_ref', 'ibsisfnjxeowvdtvgzff',
  'database_name', current_database(),
  'server_version_num', current_setting('server_version_num')::integer,
  'tables', (
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname,
      'name', c.relname,
      'kind', c.relkind,
      'row_security', c.relrowsecurity,
      'force_row_security', c.relforcerowsecurity,
      'partition_key', pg_get_partkeydef(c.oid),
      'partition_bound', pg_get_expr(c.relpartbound, c.oid, true),
      'reloptions', coalesce(to_jsonb(c.reloptions), '[]'::jsonb),
      'comment', obj_description(c.oid, 'pg_class')
    ) ORDER BY n.nspname, c.relname)
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  ),
  'columns', (
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname,
      'table', c.relname,
      'ordinal', a.attnum,
      'name', a.attname,
      'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
      'not_null', a.attnotnull,
      'identity', a.attidentity,
      'generated', a.attgenerated,
      'default', pg_get_expr(d.adbin, d.adrelid, true),
      'collation', CASE WHEN a.attcollation <> t.typcollation THEN coll.collname ELSE NULL END,
      'comment', col_description(c.oid, a.attnum)
    ) ORDER BY n.nspname, c.relname, a.attnum)
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN pg_catalog.pg_collation coll ON coll.oid = a.attcollation
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND a.attnum > 0
      AND NOT a.attisdropped
  ),
  'constraints', (
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname,
      'table', c.relname,
      'name', con.conname,
      'type', con.contype,
      'definition', pg_get_constraintdef(con.oid, true),
      'validated', con.convalidated,
      'deferrable', con.condeferrable,
      'initially_deferred', con.condeferred
    ) ORDER BY n.nspname, c.relname, con.conname)
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  ),
  'indexes', (
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname,
      'table', c.relname,
      'name', i.relname,
      'definition', pg_get_indexdef(i.oid),
      'unique', ix.indisunique,
      'primary', ix.indisprimary,
      'valid', ix.indisvalid,
      'ready', ix.indisready,
      'clustered', ix.indisclustered,
      'replica_identity', ix.indisreplident
    ) ORDER BY n.nspname, c.relname, i.relname)
    FROM pg_catalog.pg_index ix
    JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid
    JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  ),
  'triggers', (
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname,
      'table', c.relname,
      'name', t.tgname,
      'definition', pg_get_triggerdef(t.oid, true),
      'enabled', t.tgenabled
    ) ORDER BY n.nspname, c.relname, t.tgname)
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ),
  'policies', (
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname,
      'table', c.relname,
      'name', p.polname,
      'permissive', p.polpermissive,
      'command', p.polcmd,
      'roles', ARRAY(SELECT rolname FROM pg_catalog.pg_roles WHERE oid = ANY(p.polroles) ORDER BY rolname),
      'using', pg_get_expr(p.polqual, p.polrelid, true),
      'check', pg_get_expr(p.polwithcheck, p.polrelid, true)
    ) ORDER BY n.nspname, c.relname, p.polname)
    FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
  ),
  'custom_functions', (
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname,
      'name', p.proname,
      'identity_arguments', pg_get_function_identity_arguments(p.oid),
      'result', pg_get_function_result(p.oid),
      'kind', p.prokind,
      'security_definer', p.prosecdef,
      'volatility', p.provolatile,
      'parallel', p.proparallel,
      'definition', pg_get_functiondef(p.oid)
    ) ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_catalog.pg_depend dep
      ON dep.classid = 'pg_proc'::regclass
     AND dep.objid = p.oid
     AND dep.deptype = 'e'
    WHERE n.nspname = 'public' AND dep.objid IS NULL
  ),
  'sequences', (
    SELECT jsonb_agg(jsonb_build_object(
      'schema', schemaname,
      'name', sequencename,
      'owner', sequenceowner,
      'data_type', data_type,
      'start_value', start_value,
      'minimum_value', min_value,
      'maximum_value', max_value,
      'increment', increment_by,
      'cycle', cycle,
      'cache_size', cache_size
    ) ORDER BY schemaname, sequencename)
    FROM pg_catalog.pg_sequences
    WHERE schemaname = 'public'
  ),
  'enums', (
    SELECT jsonb_agg(jsonb_build_object(
      'schema', n.nspname,
      'name', t.typname,
      'label', e.enumlabel,
      'order', e.enumsortorder
    ) ORDER BY n.nspname, t.typname, e.enumsortorder)
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname = 'public'
  ),
  'extensions', (
    SELECT jsonb_agg(jsonb_build_object(
      'name', e.extname,
      'version', e.extversion,
      'schema', n.nspname
    ) ORDER BY e.extname)
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
  ),
  'table_grants', (
    SELECT jsonb_agg(jsonb_build_object(
      'schema', table_schema,
      'table', table_name,
      'grantee', grantee,
      'privilege', privilege_type,
      'grantable', is_grantable
    ) ORDER BY table_schema, table_name, grantee, privilege_type)
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
  ),
  'routine_grants', (
    SELECT jsonb_agg(jsonb_build_object(
      'schema', routine_schema,
      'routine', routine_name,
      'specific_name', specific_name,
      'grantee', grantee,
      'privilege', privilege_type,
      'grantable', is_grantable
    ) ORDER BY routine_schema, specific_name, grantee, privilege_type)
    FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public'
  ),
  'publication_tables', (
    SELECT jsonb_agg(jsonb_build_object(
      'publication', pubname,
      'schema', schemaname,
      'table', tablename
    ) ORDER BY pubname, schemaname, tablename)
    FROM pg_catalog.pg_publication_tables
    WHERE schemaname = 'public'
  )
) AS schema_capture;

ROLLBACK;
