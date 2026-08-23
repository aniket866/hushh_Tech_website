\set ON_ERROR_STOP on

-- UAT-only least-privilege boundary for the GCP nda-admin-fetch port.
-- This file is intentionally fail-closed and contains no source data.

BEGIN;

DO $preflight$
DECLARE
  target_role CONSTANT text := 'hushh-tech-engagement-api-uat@hushh-tech-uat.iam';
  schema_owner CONSTANT text := 'hushh_tech_schema_owner';
  target_table regclass;
  existing_policy_count integer;
  existing_policy_exact boolean;
BEGIN
  IF current_database() <> 'hushh_tech_app' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'NDA_BOUNDARY_TARGET_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = schema_owner
      AND rolcanlogin IS FALSE
      AND rolinherit IS FALSE
      AND rolsuper IS FALSE
      AND rolcreaterole IS FALSE
      AND rolcreatedb IS FALSE
      AND rolreplication IS FALSE
      AND rolbypassrls IS FALSE
  ) THEN
    RAISE EXCEPTION 'NDA_BOUNDARY_SCHEMA_OWNER_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = target_role
      AND rolcanlogin IS TRUE
      AND rolsuper IS FALSE
      AND rolcreaterole IS FALSE
      AND rolcreatedb IS FALSE
      AND rolreplication IS FALSE
      AND rolbypassrls IS FALSE
  ) THEN
    RAISE EXCEPTION 'NDA_BOUNDARY_TARGET_ROLE_INVALID';
  END IF;

  SELECT relation.oid
  INTO target_table
  FROM pg_catalog.pg_class AS relation
  INNER JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  INNER JOIN pg_catalog.pg_roles AS owner_role
    ON owner_role.oid = relation.relowner
  WHERE namespace.nspname = 'public'
    AND relation.relname = 'nda_signatures'
    AND relation.relkind IN ('r', 'p')
    AND relation.relrowsecurity IS TRUE
    AND relation.relforcerowsecurity IS TRUE
    AND owner_role.rolname = schema_owner;

  IF target_table IS NULL THEN
    RAISE EXCEPTION 'NDA_BOUNDARY_TABLE_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    INNER JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = namespace.nspowner
    WHERE namespace.nspname = 'public'
      AND owner_role.rolname = schema_owner
  ) THEN
    RAISE EXCEPTION 'NDA_BOUNDARY_SCHEMA_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    INNER JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    INNER JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname IN ('postgres', target_role)
      AND granted_role.rolname IN (
        schema_owner,
        'hushh_tech_migration',
        'hushh_tech_runtime',
        'hushh_tech_audit',
        'hushh_tech_rollback'
      )
  ) THEN
    RAISE EXCEPTION 'NDA_BOUNDARY_PREEXISTING_MEMBERSHIP';
  END IF;

  SELECT count(*)::integer
  INTO existing_policy_count
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polrelid = target_table
    AND policy.polname = 'nda_signatures_engagement_api_select';

  IF existing_policy_count > 1 THEN
    RAISE EXCEPTION 'NDA_BOUNDARY_POLICY_DUPLICATED';
  END IF;

  IF existing_policy_count = 1 THEN
    SELECT
      policy.polcmd = 'r'
      AND policy.polpermissive IS TRUE
      AND policy.polwithcheck IS NULL
      AND policy.polroles = ARRAY[target.oid]::oid[]
      AND trim(
        BOTH '()' FROM regexp_replace(
          regexp_replace(
            pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
            '::text',
            '',
            'g'
          ),
          '[[:space:]]+',
          '',
          'g'
        )
      ) = 'current_setting(''app.firebase_fund_admin'',true)=''true'''
    INTO existing_policy_exact
    FROM pg_catalog.pg_policy AS policy
    INNER JOIN pg_catalog.pg_roles AS target
      ON target.rolname = target_role
    WHERE policy.polrelid = target_table
      AND policy.polname = 'nda_signatures_engagement_api_select';

    IF existing_policy_exact IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'NDA_BOUNDARY_POLICY_DRIFT';
    END IF;
  END IF;
END
$preflight$;

GRANT hushh_tech_schema_owner TO postgres;
SET LOCAL ROLE hushh_tech_schema_owner;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM "hushh-tech-engagement-api-uat@hushh-tech-uat.iam";
REVOKE CREATE ON SCHEMA public
  FROM "hushh-tech-engagement-api-uat@hushh-tech-uat.iam";
GRANT USAGE ON SCHEMA public
  TO "hushh-tech-engagement-api-uat@hushh-tech-uat.iam";
GRANT SELECT (id, user_id, signed_at, nda_version, pdf_url)
  ON public.nda_signatures
  TO "hushh-tech-engagement-api-uat@hushh-tech-uat.iam";

DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.nda_signatures'::regclass
      AND polname = 'nda_signatures_engagement_api_select'
  ) THEN
    CREATE POLICY nda_signatures_engagement_api_select
      ON public.nda_signatures
      AS PERMISSIVE
      FOR SELECT
      TO "hushh-tech-engagement-api-uat@hushh-tech-uat.iam"
      USING (current_setting('app.firebase_fund_admin', true) = 'true');
  END IF;
END
$policy$;

RESET ROLE;
REVOKE hushh_tech_schema_owner FROM postgres;

DO $verify$
DECLARE
  target_role CONSTANT text := 'hushh-tech-engagement-api-uat@hushh-tech-uat.iam';
  select_columns text[];
  policy_exact boolean;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    INNER JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    INNER JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname IN ('postgres', target_role)
      AND granted_role.rolname IN (
        'hushh_tech_schema_owner',
        'hushh_tech_migration',
        'hushh_tech_runtime',
        'hushh_tech_audit',
        'hushh_tech_rollback'
      )
  ) THEN
    RAISE EXCEPTION 'NDA_BOUNDARY_RESIDUAL_MEMBERSHIP';
  END IF;

  SELECT array_agg(
    format('%I.%I.%I', namespace.nspname, relation.relname, attribute.attname)
    ORDER BY namespace.nspname, relation.relname, attribute.attname
  )
  INTO select_columns
  FROM pg_catalog.pg_attribute AS attribute
  INNER JOIN pg_catalog.pg_class AS relation
    ON relation.oid = attribute.attrelid
  INNER JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p')
    AND attribute.attnum > 0
    AND attribute.attisdropped IS FALSE
    AND has_column_privilege(
      target_role,
      relation.oid,
      attribute.attnum,
      'SELECT'
    );

  IF select_columns IS DISTINCT FROM ARRAY[
    'public.nda_signatures.id',
    'public.nda_signatures.nda_version',
    'public.nda_signatures.pdf_url',
    'public.nda_signatures.signed_at',
    'public.nda_signatures.user_id'
  ]::text[] THEN
    RAISE EXCEPTION 'NDA_BOUNDARY_COLUMN_SELECT_DRIFT';
  END IF;

  IF has_table_privilege(target_role, 'public.nda_signatures', 'SELECT')
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND (
          has_table_privilege(target_role, relation.oid, 'INSERT')
          OR has_table_privilege(target_role, relation.oid, 'UPDATE')
          OR has_table_privilege(target_role, relation.oid, 'DELETE')
          OR has_table_privilege(target_role, relation.oid, 'TRUNCATE')
          OR has_table_privilege(target_role, relation.oid, 'REFERENCES')
          OR has_table_privilege(target_role, relation.oid, 'TRIGGER')
        )
    )
    OR has_database_privilege(target_role, current_database(), 'CREATE')
    OR has_database_privilege(target_role, current_database(), 'TEMPORARY')
    OR has_schema_privilege(target_role, 'public', 'CREATE')
    OR NOT has_schema_privilege(target_role, 'public', 'USAGE') THEN
    RAISE EXCEPTION 'NDA_BOUNDARY_PRIVILEGE_DRIFT';
  END IF;

  SELECT
    policy.polcmd = 'r'
    AND policy.polpermissive IS TRUE
    AND policy.polwithcheck IS NULL
    AND policy.polroles = ARRAY[target.oid]::oid[]
    AND trim(
      BOTH '()' FROM regexp_replace(
        regexp_replace(
          pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
          '::text',
          '',
          'g'
        ),
        '[[:space:]]+',
        '',
        'g'
      )
    ) = 'current_setting(''app.firebase_fund_admin'',true)=''true'''
  INTO policy_exact
  FROM pg_catalog.pg_policy AS policy
  INNER JOIN pg_catalog.pg_roles AS target
    ON target.rolname = target_role
  WHERE policy.polrelid = 'public.nda_signatures'::regclass
    AND policy.polname = 'nda_signatures_engagement_api_select';

  IF policy_exact IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'NDA_BOUNDARY_POLICY_INVALID';
  END IF;
END
$verify$;

COMMIT;

SELECT json_build_object(
  'kind', 'HUSHH_TECH_UAT_NDA_BOUNDARY_APPLY',
  'status', 'APPLIED',
  'target', current_database(),
  'residualSchemaOwnerMemberships', (
    SELECT count(*)
    FROM pg_catalog.pg_auth_members AS membership
    INNER JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    INNER JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'postgres'
      AND granted_role.rolname = 'hushh_tech_schema_owner'
  )
);
