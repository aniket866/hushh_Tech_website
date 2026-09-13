-- UAT-only least-privilege Cloud SQL boundary for the existing financial-link
-- migration.  This is intentionally limited to Plaid Link/token exchange,
-- product sync, asset-report polling, and lossy diagnostics.  It does not
-- create or grant any transfer/payment relation.
--
-- The application adapter must use SERIALIZABLE transactions for sync-job
-- enqueue/lease transitions and must set both app.firebase_uid and
-- app.firebase_project='hushh-tech-uat' transaction-locally before any DML.
-- KMS envelope serialization and Cloud Tasks publication are runtime
-- responsibilities; this boundary persists only job/outbox metadata and
-- identifiers, never raw request payloads or Plaid access tokens.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
DECLARE
  financial_role CONSTANT name := 'hushh-tech-financial-api-uat@hushh-tech-uat.iam';
  worker_role CONSTANT name := 'hushh-tech-worker-uat@hushh-tech-uat.iam';
  schema_owner CONSTANT name := 'hushh_tech_schema_owner';
  identity_provisioner CONSTANT name := 'hushh_tech_identity_provisioner';
  resolver CONSTANT regprocedure := 'hushh_identity.current_legacy_user_uuid()'::regprocedure;
BEGIN
  IF current_database() <> 'hushh_tech_app'
     OR current_user <> 'postgres'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pgcrypto')
  THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_TARGET_INVALID';
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
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_SCHEMA_OWNER_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = identity_provisioner
      AND rolcanlogin IS FALSE
      AND rolinherit IS FALSE
      AND rolsuper IS FALSE
      AND rolcreaterole IS FALSE
      AND rolcreatedb IS FALSE
      AND rolreplication IS FALSE
      AND rolbypassrls IS FALSE
  ) THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_IDENTITY_PROVISIONER_INVALID';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_catalog.pg_roles
    WHERE rolname IN (financial_role, worker_role)
      AND rolcanlogin IS TRUE
      AND rolsuper IS FALSE
      AND rolcreaterole IS FALSE
      AND rolcreatedb IS FALSE
      AND rolreplication IS FALSE
      AND rolbypassrls IS FALSE
  ) <> 2 THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_RUNTIME_ROLE_INVALID';
  END IF;

  -- Cloud SQL creates each IAM database user as a member of its managed
  -- `cloudsqliamserviceaccount` role.  Permit precisely that platform
  -- membership while refusing every other inherited authority: the direct
  -- grants below remain the only application authority this migration adds.
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_auth_members AS membership
    INNER JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    INNER JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname IN (financial_role, worker_role)
      AND granted_role.rolname = 'cloudsqliamserviceaccount'
  ) <> 2 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    INNER JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    INNER JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname IN (financial_role, worker_role)
      AND granted_role.rolname <> 'cloudsqliamserviceaccount'
  ) THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_RUNTIME_ROLE_MEMBERSHIP';
  END IF;

  IF pg_catalog.to_regnamespace('hushh_financial') IS NOT NULL
     OR pg_catalog.to_regclass('hushh_financial.sync_jobs') IS NOT NULL
     OR pg_catalog.to_regclass('hushh_financial.sync_outbox') IS NOT NULL
  THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_ALREADY_PRESENT';
  END IF;

  -- The imported UAT relations must still be the source-compatible shapes
  -- used by the preserved Supabase implementation.  This deliberately
  -- refuses a target catalog that merely has same-named tables.
  IF (
    SELECT count(*)
    FROM pg_catalog.pg_class AS relation
    INNER JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    INNER JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = relation.relowner
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'onboarding_data',
        'plaid_accounts',
        'plaid_items',
        'plaid_link_diagnostics',
        'plaid_product_sync_statuses',
        'plaid_statement_metadata',
        'plaid_sync_cursors',
        'plaid_transactions',
        'user_financial_data'
      )
      AND relation.relkind IN ('r', 'p')
      AND relation.relrowsecurity IS TRUE
      AND relation.relforcerowsecurity IS TRUE
      AND owner_role.rolname = schema_owner
  ) <> 9 THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_PUBLIC_RELATION_INVALID';
  END IF;

  -- An existing policy addressed to either runtime role (or PUBLIC) would be
  -- ORed with the owner policy below.  Refuse that catalog rather than
  -- layering a narrower-looking policy over a broad legacy one.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (
      'public.onboarding_data'::regclass,
      'public.plaid_accounts'::regclass,
      'public.plaid_items'::regclass,
      'public.plaid_link_diagnostics'::regclass,
      'public.plaid_product_sync_statuses'::regclass,
      'public.plaid_statement_metadata'::regclass,
      'public.plaid_sync_cursors'::regclass,
      'public.plaid_transactions'::regclass,
      'public.user_financial_data'::regclass
    )
      AND (
        0::oid = ANY (policy.polroles)
        OR (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = financial_role) = ANY (policy.polroles)
        OR (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = worker_role) = ANY (policy.polroles)
      )
  ) THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_SOURCE_POLICY_CONFLICT';
  END IF;

  IF EXISTS (
    WITH expected(schema_name, table_name, column_name, type_name, required_not_null) AS (
      VALUES
        ('public', 'onboarding_data', 'id', 'uuid', true),
        ('public', 'onboarding_data', 'user_id', 'uuid', true),
        ('public', 'onboarding_data', 'financial_link_status', 'text', true),
        ('public', 'onboarding_data', 'updated_at', 'timestamp with time zone', false),
        -- The preserved identity-match request projects only these existing
        -- onboarding fields; they remain nullable user profile facts.
        ('public', 'onboarding_data', 'legal_first_name', 'text', false),
        ('public', 'onboarding_data', 'legal_last_name', 'text', false),
        ('public', 'onboarding_data', 'phone_country_code', 'text', false),
        ('public', 'onboarding_data', 'phone_number', 'text', false),
        ('public', 'onboarding_data', 'address_line_1', 'text', false),
        ('public', 'onboarding_data', 'address_line_2', 'text', false),
        ('public', 'onboarding_data', 'city', 'text', false),
        ('public', 'onboarding_data', 'state', 'text', false),
        ('public', 'onboarding_data', 'zip_code', 'text', false),
        ('public', 'onboarding_data', 'address_country', 'text', false),

        ('public', 'plaid_items', 'id', 'uuid', true),
        ('public', 'plaid_items', 'user_id', 'text', true),
        ('public', 'plaid_items', 'plaid_item_id', 'text', true),
        ('public', 'plaid_items', 'plaid_access_token_encrypted', 'text', true),
        ('public', 'plaid_items', 'institution_id', 'text', false),
        ('public', 'plaid_items', 'institution_name', 'text', false),
        ('public', 'plaid_items', 'status', 'text', false),
        ('public', 'plaid_items', 'consent_expiration', 'timestamp with time zone', false),
        ('public', 'plaid_items', 'error_code', 'text', false),
        ('public', 'plaid_items', 'error_message', 'text', false),
        ('public', 'plaid_items', 'created_at', 'timestamp with time zone', false),
        ('public', 'plaid_items', 'updated_at', 'timestamp with time zone', false),
        ('public', 'plaid_items', 'products_requested', 'jsonb', false),
        ('public', 'plaid_items', 'webhook_url', 'text', false),
        ('public', 'plaid_items', 'last_data_sync_at', 'timestamp with time zone', false),
        ('public', 'plaid_items', 'last_sync_started_at', 'timestamp with time zone', false),

        ('public', 'plaid_accounts', 'id', 'uuid', true),
        ('public', 'plaid_accounts', 'plaid_item_id', 'text', true),
        ('public', 'plaid_accounts', 'plaid_account_id', 'text', true),
        ('public', 'plaid_accounts', 'name', 'text', false),
        ('public', 'plaid_accounts', 'official_name', 'text', false),
        ('public', 'plaid_accounts', 'type', 'text', false),
        ('public', 'plaid_accounts', 'subtype', 'text', false),
        ('public', 'plaid_accounts', 'current_balance', 'numeric', false),
        ('public', 'plaid_accounts', 'available_balance', 'numeric', false),
        ('public', 'plaid_accounts', 'iso_currency_code', 'text', false),
        ('public', 'plaid_accounts', 'mask', 'text', false),
        ('public', 'plaid_accounts', 'last_synced_at', 'timestamp with time zone', false),
        ('public', 'plaid_accounts', 'created_at', 'timestamp with time zone', false),
        ('public', 'plaid_accounts', 'updated_at', 'timestamp with time zone', false),

        ('public', 'plaid_product_sync_statuses', 'id', 'uuid', true),
        ('public', 'plaid_product_sync_statuses', 'user_id', 'uuid', true),
        ('public', 'plaid_product_sync_statuses', 'plaid_item_id', 'text', true),
        ('public', 'plaid_product_sync_statuses', 'product', 'text', true),
        ('public', 'plaid_product_sync_statuses', 'status', 'text', true),
        ('public', 'plaid_product_sync_statuses', 'available', 'boolean', true),
        ('public', 'plaid_product_sync_statuses', 'records_count', 'integer', false),
        ('public', 'plaid_product_sync_statuses', 'error_code', 'text', false),
        ('public', 'plaid_product_sync_statuses', 'error_message', 'text', false),
        ('public', 'plaid_product_sync_statuses', 'request_id', 'text', false),
        ('public', 'plaid_product_sync_statuses', 'attempts', 'integer', true),
        ('public', 'plaid_product_sync_statuses', 'started_at', 'timestamp with time zone', false),
        ('public', 'plaid_product_sync_statuses', 'completed_at', 'timestamp with time zone', false),
        ('public', 'plaid_product_sync_statuses', 'next_retry_at', 'timestamp with time zone', false),
        ('public', 'plaid_product_sync_statuses', 'raw_metadata', 'jsonb', false),
        ('public', 'plaid_product_sync_statuses', 'created_at', 'timestamp with time zone', false),
        ('public', 'plaid_product_sync_statuses', 'updated_at', 'timestamp with time zone', false),

        ('public', 'plaid_sync_cursors', 'id', 'uuid', true),
        ('public', 'plaid_sync_cursors', 'plaid_item_id', 'text', true),
        ('public', 'plaid_sync_cursors', 'cursor', 'text', true),
        ('public', 'plaid_sync_cursors', 'last_synced_at', 'timestamp with time zone', false),
        ('public', 'plaid_sync_cursors', 'product', 'text', true),
        ('public', 'plaid_sync_cursors', 'updated_at', 'timestamp with time zone', false),

        ('public', 'plaid_transactions', 'id', 'uuid', true),
        ('public', 'plaid_transactions', 'plaid_account_id', 'text', true),
        ('public', 'plaid_transactions', 'plaid_transaction_id', 'text', true),
        ('public', 'plaid_transactions', 'amount', 'numeric', true),
        ('public', 'plaid_transactions', 'iso_currency_code', 'text', false),
        ('public', 'plaid_transactions', 'date', 'date', true),
        ('public', 'plaid_transactions', 'name', 'text', false),
        ('public', 'plaid_transactions', 'merchant_name', 'text', false),
        ('public', 'plaid_transactions', 'category', 'text[]', false),
        ('public', 'plaid_transactions', 'pending', 'boolean', false),
        ('public', 'plaid_transactions', 'payment_channel', 'text', false),
        ('public', 'plaid_transactions', 'transaction_type', 'text', false),
        ('public', 'plaid_transactions', 'location', 'jsonb', false),
        ('public', 'plaid_transactions', 'created_at', 'timestamp with time zone', false),

        ('public', 'plaid_statement_metadata', 'id', 'uuid', true),
        ('public', 'plaid_statement_metadata', 'user_id', 'uuid', true),
        ('public', 'plaid_statement_metadata', 'plaid_item_id', 'text', true),
        ('public', 'plaid_statement_metadata', 'plaid_account_id', 'text', false),
        ('public', 'plaid_statement_metadata', 'statement_id', 'text', true),
        ('public', 'plaid_statement_metadata', 'statement_date', 'date', false),
        ('public', 'plaid_statement_metadata', 'period_start', 'date', false),
        ('public', 'plaid_statement_metadata', 'period_end', 'date', false),
        ('public', 'plaid_statement_metadata', 'status', 'text', true),
        ('public', 'plaid_statement_metadata', 'metadata', 'jsonb', false),
        ('public', 'plaid_statement_metadata', 'created_at', 'timestamp with time zone', false),
        ('public', 'plaid_statement_metadata', 'updated_at', 'timestamp with time zone', false),

        ('public', 'plaid_link_diagnostics', 'id', 'uuid', true),
        ('public', 'plaid_link_diagnostics', 'user_id', 'uuid', false),
        ('public', 'plaid_link_diagnostics', 'session_id', 'uuid', false),
        ('public', 'plaid_link_diagnostics', 'event_type', 'text', true),
        ('public', 'plaid_link_diagnostics', 'plaid_step', 'text', false),
        ('public', 'plaid_link_diagnostics', 'page_state', 'jsonb', true),
        ('public', 'plaid_link_diagnostics', 'plaid_metadata', 'jsonb', true),
        ('public', 'plaid_link_diagnostics', 'error_details', 'jsonb', true),
        ('public', 'plaid_link_diagnostics', 'browser_context', 'jsonb', true),
        ('public', 'plaid_link_diagnostics', 'created_at', 'timestamp with time zone', true),

        ('public', 'user_financial_data', 'id', 'uuid', true),
        ('public', 'user_financial_data', 'user_id', 'uuid', true),
        ('public', 'user_financial_data', 'plaid_item_id', 'text', false),
        ('public', 'user_financial_data', 'plaid_access_token', 'text', false),
        ('public', 'user_financial_data', 'institution_name', 'text', false),
        ('public', 'user_financial_data', 'institution_id', 'text', false),
        ('public', 'user_financial_data', 'balances', 'jsonb', false),
        ('public', 'user_financial_data', 'asset_report', 'jsonb', false),
        ('public', 'user_financial_data', 'asset_report_token', 'text', false),
        ('public', 'user_financial_data', 'investments', 'jsonb', false),
        ('public', 'user_financial_data', 'available_products', 'jsonb', false),
        ('public', 'user_financial_data', 'status', 'text', false),
        ('public', 'user_financial_data', 'fetch_errors', 'jsonb', false),
        ('public', 'user_financial_data', 'created_at', 'timestamp with time zone', false),
        ('public', 'user_financial_data', 'updated_at', 'timestamp with time zone', false),
        ('public', 'user_financial_data', 'identity_data', 'jsonb', false),
        ('public', 'user_financial_data', 'identity_match_scores', 'jsonb', false),
        ('public', 'user_financial_data', 'signal_prepared', 'boolean', false),
        ('public', 'user_financial_data', 'auth_numbers', 'jsonb', false),
        ('public', 'user_financial_data', 'identity_match', 'jsonb', false),
        ('public', 'user_financial_data', 'asset_report_status', 'text', false),
        ('public', 'user_financial_data', 'asset_report_created_at', 'timestamp with time zone', false),
        ('public', 'user_financial_data', 'income_data', 'jsonb', false),
        ('public', 'user_financial_data', 'investment_transactions', 'jsonb', false),
        ('public', 'user_financial_data', 'liabilities_data', 'jsonb', false),
        ('public', 'user_financial_data', 'transactions_data', 'jsonb', false),
        ('public', 'user_financial_data', 'statements_data', 'jsonb', false),
        ('public', 'user_financial_data', 'plaid_sync_status', 'text', false),
        ('public', 'user_financial_data', 'plaid_sync_completed_at', 'timestamp with time zone', false),
        ('public', 'user_financial_data', 'data_sync_summary', 'jsonb', false)
    )
    SELECT 1
    FROM expected
    LEFT JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.nspname = expected.schema_name
    LEFT JOIN pg_catalog.pg_class AS relation
      ON relation.relnamespace = namespace.oid
      AND relation.relname = expected.table_name
      AND relation.relkind IN ('r', 'p')
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
      AND attribute.attname = expected.column_name
      AND attribute.attnum > 0
      AND attribute.attisdropped IS FALSE
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> expected.type_name::regtype
       OR (expected.required_not_null AND attribute.attnotnull IS FALSE)
  ) THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_PUBLIC_COLUMN_DRIFT';
  END IF;

  -- Every preserved fixed INSERT omits the source UUID primary key.  A UUID
  -- type alone is insufficient: without the pgcrypto default the request
  -- would fail after this boundary had granted it access.  Keep the source
  -- default exact rather than substituting a new identifier mechanism.
  IF EXISTS (
    WITH expected(schema_name, table_name, column_name, default_expression) AS (
      VALUES
        ('public', 'onboarding_data', 'id', 'gen_random_uuid()'),
        ('public', 'plaid_accounts', 'id', 'gen_random_uuid()'),
        ('public', 'plaid_items', 'id', 'gen_random_uuid()'),
        ('public', 'plaid_link_diagnostics', 'id', 'gen_random_uuid()'),
        ('public', 'plaid_product_sync_statuses', 'id', 'gen_random_uuid()'),
        ('public', 'plaid_statement_metadata', 'id', 'gen_random_uuid()'),
        ('public', 'plaid_sync_cursors', 'id', 'gen_random_uuid()'),
        ('public', 'plaid_transactions', 'id', 'gen_random_uuid()'),
        ('public', 'user_financial_data', 'id', 'gen_random_uuid()')
    )
    SELECT 1
    FROM expected
    INNER JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.nspname = expected.schema_name
    INNER JOIN pg_catalog.pg_class AS relation
      ON relation.relnamespace = namespace.oid
      AND relation.relname = expected.table_name
      AND relation.relkind IN ('r', 'p')
    INNER JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
      AND attribute.attname = expected.column_name
      AND attribute.attnum > 0
      AND attribute.attisdropped IS FALSE
    LEFT JOIN pg_catalog.pg_attrdef AS default_definition
      ON default_definition.adrelid = relation.oid
      AND default_definition.adnum = attribute.attnum
    WHERE default_definition.oid IS NULL
       OR pg_catalog.pg_get_expr(
            default_definition.adbin,
            default_definition.adrelid
          ) IS DISTINCT FROM expected.default_expression
  ) THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_PUBLIC_ID_DEFAULT_DRIFT';
  END IF;

  -- Each upsert/lookup key is part of the preserved source contract.  A
  -- matching table without its unique lookup key is not an acceptable target.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS index_definition
    WHERE index_definition.indrelid = 'public.onboarding_data'::regclass
      AND index_definition.indisunique
      AND index_definition.indpred IS NULL
      AND array_to_string(index_definition.indkey::smallint[], ',') = array_to_string(ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = 'public.onboarding_data'::regclass AND attname = 'user_id')
      ]::smallint[], ',')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS index_definition
    WHERE index_definition.indrelid = 'public.plaid_items'::regclass
      AND index_definition.indisunique
      AND index_definition.indpred IS NULL
      AND array_to_string(index_definition.indkey::smallint[], ',') = array_to_string(ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = 'public.plaid_items'::regclass AND attname = 'plaid_item_id')
      ]::smallint[], ',')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS index_definition
    WHERE index_definition.indrelid = 'public.plaid_accounts'::regclass
      AND index_definition.indisunique
      AND index_definition.indpred IS NULL
      AND array_to_string(index_definition.indkey::smallint[], ',') = array_to_string(ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = 'public.plaid_accounts'::regclass AND attname = 'plaid_account_id')
      ]::smallint[], ',')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS index_definition
    WHERE index_definition.indrelid = 'public.plaid_product_sync_statuses'::regclass
      AND index_definition.indisunique
      AND index_definition.indpred IS NULL
      AND array_to_string(index_definition.indkey::smallint[], ',') = array_to_string(ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = 'public.plaid_product_sync_statuses'::regclass AND attname = 'user_id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = 'public.plaid_product_sync_statuses'::regclass AND attname = 'plaid_item_id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = 'public.plaid_product_sync_statuses'::regclass AND attname = 'product')
      ]::smallint[], ',')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS index_definition
    WHERE index_definition.indrelid = 'public.plaid_sync_cursors'::regclass
      AND index_definition.indisunique
      AND index_definition.indpred IS NULL
      AND array_to_string(index_definition.indkey::smallint[], ',') = array_to_string(ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = 'public.plaid_sync_cursors'::regclass AND attname = 'plaid_item_id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = 'public.plaid_sync_cursors'::regclass AND attname = 'product')
      ]::smallint[], ',')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS index_definition
    WHERE index_definition.indrelid = 'public.plaid_transactions'::regclass
      AND index_definition.indisunique
      AND index_definition.indpred IS NULL
      AND array_to_string(index_definition.indkey::smallint[], ',') = array_to_string(ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = 'public.plaid_transactions'::regclass AND attname = 'plaid_transaction_id')
      ]::smallint[], ',')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS index_definition
    WHERE index_definition.indrelid = 'public.plaid_statement_metadata'::regclass
      AND index_definition.indisunique
      AND index_definition.indpred IS NULL
      AND array_to_string(index_definition.indkey::smallint[], ',') = array_to_string(ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = 'public.plaid_statement_metadata'::regclass AND attname = 'user_id'),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = 'public.plaid_statement_metadata'::regclass AND attname = 'statement_id')
      ]::smallint[], ',')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS index_definition
    WHERE index_definition.indrelid = 'public.user_financial_data'::regclass
      AND index_definition.indisunique
      AND index_definition.indpred IS NULL
      AND array_to_string(index_definition.indkey::smallint[], ',') = array_to_string(ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = 'public.user_financial_data'::regclass AND attname = 'user_id')
      ]::smallint[], ',')
  ) THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_PUBLIC_UNIQUE_KEY_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    INNER JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    INNER JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = routine.proowner
    WHERE routine.oid = resolver
      AND namespace.nspname = 'hushh_identity'
      AND owner_role.rolname = schema_owner
      AND routine.prosecdef IS TRUE
      AND routine.provolatile = 's'
      AND routine.prorettype = 'uuid'::regtype
      AND routine.pronargs = 0
  ) THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_PRINCIPAL_RESOLVER_INVALID';
  END IF;

  -- 004 seals this resolver to its owner and the identity provisioner.  The
  -- migration must not add financial access on top of a broad/PUBLIC routine
  -- grant, even when the effective privilege happens to look correct.
  IF (
    SELECT array_agg(
      format(
        '%s:%s',
        CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
        acl.privilege_type
      )
      ORDER BY
        CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
        acl.privilege_type
    )
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(routine.proacl, pg_catalog.acldefault('f'::"char", routine.proowner))
    ) AS acl
    WHERE routine.oid = resolver
  ) IS DISTINCT FROM ARRAY[
    'hushh_tech_identity_provisioner:EXECUTE',
    'hushh_tech_schema_owner:EXECUTE'
  ]::text[] THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_PRINCIPAL_RESOLVER_ACL_INVALID';
  END IF;

  -- The readiness verifier is intentionally allowlist-based.  This migration
  -- refuses to layer financial grants on top of any pre-existing DML, sequence
  -- or security-definer authority for either runtime IAM database user.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    INNER JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        has_table_privilege(financial_role, relation.oid, 'SELECT')
        OR has_table_privilege(financial_role, relation.oid, 'INSERT')
        OR has_table_privilege(financial_role, relation.oid, 'UPDATE')
        OR has_table_privilege(financial_role, relation.oid, 'DELETE')
        OR has_table_privilege(worker_role, relation.oid, 'SELECT')
        OR has_table_privilege(worker_role, relation.oid, 'INSERT')
        OR has_table_privilege(worker_role, relation.oid, 'UPDATE')
        OR has_table_privilege(worker_role, relation.oid, 'DELETE')
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    INNER JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    INNER JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
      AND attribute.attnum > 0
      AND attribute.attisdropped IS FALSE
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        has_column_privilege(financial_role, relation.oid, attribute.attnum, 'SELECT')
        OR has_column_privilege(financial_role, relation.oid, attribute.attnum, 'INSERT')
        OR has_column_privilege(financial_role, relation.oid, attribute.attnum, 'UPDATE')
        OR has_column_privilege(worker_role, relation.oid, attribute.attnum, 'SELECT')
        OR has_column_privilege(worker_role, relation.oid, attribute.attnum, 'INSERT')
        OR has_column_privilege(worker_role, relation.oid, attribute.attnum, 'UPDATE')
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS sequence_relation
    INNER JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = sequence_relation.relnamespace
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
      AND sequence_relation.relkind = 'S'
      AND (
        has_sequence_privilege(financial_role, sequence_relation.oid, 'SELECT')
        OR has_sequence_privilege(financial_role, sequence_relation.oid, 'UPDATE')
        OR has_sequence_privilege(financial_role, sequence_relation.oid, 'USAGE')
        OR has_sequence_privilege(worker_role, sequence_relation.oid, 'SELECT')
        OR has_sequence_privilege(worker_role, sequence_relation.oid, 'UPDATE')
        OR has_sequence_privilege(worker_role, sequence_relation.oid, 'USAGE')
      )
  ) OR has_function_privilege(financial_role, resolver, 'EXECUTE')
     OR has_function_privilege(worker_role, resolver, 'EXECUTE') THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_PREEXISTING_RUNTIME_AUTHORITY';
  END IF;
END
$preflight$;

-- PostgreSQL requires the governed executor to be able to SET ROLE to an
-- AUTHORIZATION target. Grant that temporary membership before creating the
-- sealed schema, then create its relations only while acting as the NOLOGIN
-- schema owner and revoke the membership before commit.
GRANT hushh_tech_schema_owner TO postgres;
CREATE SCHEMA hushh_financial AUTHORIZATION hushh_tech_schema_owner;
SET LOCAL ROLE hushh_tech_schema_owner;

REVOKE ALL ON SCHEMA hushh_financial FROM PUBLIC;

CREATE TABLE hushh_financial.sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  firebase_uid text NOT NULL CHECK (length(firebase_uid) BETWEEN 1 AND 128),
  plaid_item_id text NOT NULL CHECK (length(plaid_item_id) BETWEEN 1 AND 256),
  product text NOT NULL CHECK (product IN (
    'accounts', 'balance', 'auth', 'identity', 'investments', 'liabilities',
    'signal', 'identity_match', 'transactions', 'assets',
    'investment_transactions', 'statements', 'income'
  )),
  -- The two source whole-flow aliases fan out background work. Explicit
  -- plaid-data-sync-product remains synchronous, as it was in Supabase, and
  -- therefore never creates a durable job.
  source text NOT NULL CHECK (source IN (
    'plaid-data-sync-start', 'plaid-data-sync'
  )),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'LEASED', 'COMPLETED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (state = 'LEASED' AND lease_expires_at IS NOT NULL)
    OR (state IN ('PENDING', 'COMPLETED') AND lease_expires_at IS NULL)
  )
);

-- Only one unfinished job for a user/item/product/source may exist.  A later
-- explicit sync after a completed job is intentionally allowed.
CREATE UNIQUE INDEX sync_jobs_active_dedupe_uidx
  ON hushh_financial.sync_jobs (user_id, plaid_item_id, product, source)
  WHERE state IN ('PENDING', 'LEASED');

CREATE INDEX sync_jobs_user_state_lease_idx
  ON hushh_financial.sync_jobs (user_id, state, lease_expires_at, updated_at);

CREATE TABLE hushh_financial.sync_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES hushh_financial.sync_jobs(id) ON DELETE RESTRICT,
  task_name text NOT NULL UNIQUE CHECK (length(task_name) BETWEEN 1 AND 1024),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'PUBLISHED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (state = 'PENDING' AND published_at IS NULL)
    OR (state = 'PUBLISHED' AND published_at IS NOT NULL)
  )
);

CREATE INDEX sync_outbox_state_updated_idx
  ON hushh_financial.sync_outbox (state, updated_at);

ALTER TABLE hushh_financial.sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hushh_financial.sync_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE hushh_financial.sync_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE hushh_financial.sync_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY sync_jobs_schema_owner
  ON hushh_financial.sync_jobs
  FOR ALL TO hushh_tech_schema_owner
  USING (true) WITH CHECK (true);

CREATE POLICY sync_outbox_schema_owner
  ON hushh_financial.sync_outbox
  FOR ALL TO hushh_tech_schema_owner
  USING (true) WITH CHECK (true);

CREATE POLICY sync_jobs_financial_owner
  ON hushh_financial.sync_jobs
  FOR ALL TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam"
  USING (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()
    AND firebase_uid = NULLIF(current_setting('app.firebase_uid', true), '')
  )
  WITH CHECK (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()
    AND firebase_uid = NULLIF(current_setting('app.firebase_uid', true), '')
  );

CREATE POLICY sync_jobs_worker_owner
  ON hushh_financial.sync_jobs
  -- PostgreSQL policies take one command (or ALL), not a command list.  The
  -- table grants below are still exactly SELECT, UPDATE for this role, so ALL
  -- cannot authorize INSERT or DELETE.
  FOR ALL TO "hushh-tech-worker-uat@hushh-tech-uat.iam"
  USING (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()
    AND firebase_uid = NULLIF(current_setting('app.firebase_uid', true), '')
  )
  WITH CHECK (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()
    AND firebase_uid = NULLIF(current_setting('app.firebase_uid', true), '')
  );

CREATE POLICY sync_outbox_financial_owner
  ON hushh_financial.sync_outbox
  FOR ALL TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam"
  USING (
    EXISTS (
      SELECT 1
      FROM hushh_financial.sync_jobs AS job
      WHERE job.id = sync_outbox.job_id
        AND current_setting('app.firebase_project', true) = 'hushh-tech-uat'
        AND job.user_id = hushh_identity.current_legacy_user_uuid()
        AND job.firebase_uid = NULLIF(current_setting('app.firebase_uid', true), '')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM hushh_financial.sync_jobs AS job
      WHERE job.id = sync_outbox.job_id
        AND current_setting('app.firebase_project', true) = 'hushh-tech-uat'
        AND job.user_id = hushh_identity.current_legacy_user_uuid()
        AND job.firebase_uid = NULLIF(current_setting('app.firebase_uid', true), '')
    )
  );

-- New GCP policies for only the preserved source data path.  They deliberately
-- do not touch any transfer/payment table or legacy service-role policy.
CREATE POLICY financial_plaid_items_owner
  ON public.plaid_items
  FOR ALL TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam"
  USING (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()::text
  )
  WITH CHECK (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()::text
  );

CREATE POLICY financial_onboarding_data_owner
  ON public.onboarding_data
  FOR ALL TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam"
  USING (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()
  )
  WITH CHECK (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()
  );

-- Identity Match reads the preserved onboarding identity projection.  The
-- worker receives no onboarding INSERT/UPDATE permission or policy.
CREATE POLICY worker_onboarding_data_identity_match_owner
  ON public.onboarding_data
  FOR SELECT TO "hushh-tech-worker-uat@hushh-tech-uat.iam"
  USING (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()
  );

CREATE POLICY financial_plaid_accounts_owner
  ON public.plaid_accounts
  FOR ALL TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam"
  USING (
    EXISTS (
      SELECT 1
      FROM public.plaid_items AS item
      WHERE item.plaid_item_id = plaid_accounts.plaid_item_id
        AND current_setting('app.firebase_project', true) = 'hushh-tech-uat'
        AND item.user_id = hushh_identity.current_legacy_user_uuid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.plaid_items AS item
      WHERE item.plaid_item_id = plaid_accounts.plaid_item_id
        AND current_setting('app.firebase_project', true) = 'hushh-tech-uat'
        AND item.user_id = hushh_identity.current_legacy_user_uuid()::text
    )
  );

CREATE POLICY financial_plaid_product_sync_statuses_owner
  ON public.plaid_product_sync_statuses
  FOR ALL TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam"
  USING (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()
    AND EXISTS (
      SELECT 1
      FROM public.plaid_items AS item
      WHERE item.plaid_item_id = plaid_product_sync_statuses.plaid_item_id
        AND item.user_id = hushh_identity.current_legacy_user_uuid()::text
    )
  )
  WITH CHECK (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()
    AND EXISTS (
      SELECT 1
      FROM public.plaid_items AS item
      WHERE item.plaid_item_id = plaid_product_sync_statuses.plaid_item_id
        AND item.user_id = hushh_identity.current_legacy_user_uuid()::text
    )
  );

CREATE POLICY financial_plaid_sync_cursors_owner
  ON public.plaid_sync_cursors
  FOR ALL TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam"
  USING (
    EXISTS (
      SELECT 1
      FROM public.plaid_items AS item
      WHERE item.plaid_item_id = plaid_sync_cursors.plaid_item_id
        AND current_setting('app.firebase_project', true) = 'hushh-tech-uat'
        AND item.user_id = hushh_identity.current_legacy_user_uuid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.plaid_items AS item
      WHERE item.plaid_item_id = plaid_sync_cursors.plaid_item_id
        AND current_setting('app.firebase_project', true) = 'hushh-tech-uat'
        AND item.user_id = hushh_identity.current_legacy_user_uuid()::text
    )
  );

CREATE POLICY financial_plaid_transactions_owner
  ON public.plaid_transactions
  FOR ALL TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam"
  USING (
    EXISTS (
      SELECT 1
      FROM public.plaid_accounts AS account
      INNER JOIN public.plaid_items AS item
        ON item.plaid_item_id = account.plaid_item_id
      WHERE account.plaid_account_id = plaid_transactions.plaid_account_id
        AND current_setting('app.firebase_project', true) = 'hushh-tech-uat'
        AND item.user_id = hushh_identity.current_legacy_user_uuid()::text
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.plaid_accounts AS account
      INNER JOIN public.plaid_items AS item
        ON item.plaid_item_id = account.plaid_item_id
      WHERE account.plaid_account_id = plaid_transactions.plaid_account_id
        AND current_setting('app.firebase_project', true) = 'hushh-tech-uat'
        AND item.user_id = hushh_identity.current_legacy_user_uuid()::text
    )
  );

CREATE POLICY financial_plaid_statement_metadata_owner
  ON public.plaid_statement_metadata
  FOR ALL TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam"
  USING (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()
    AND EXISTS (
      SELECT 1
      FROM public.plaid_items AS item
      WHERE item.plaid_item_id = plaid_statement_metadata.plaid_item_id
        AND item.user_id = hushh_identity.current_legacy_user_uuid()::text
    )
  )
  WITH CHECK (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()
    AND EXISTS (
      SELECT 1
      FROM public.plaid_items AS item
      WHERE item.plaid_item_id = plaid_statement_metadata.plaid_item_id
        AND item.user_id = hushh_identity.current_legacy_user_uuid()::text
    )
  );

CREATE POLICY financial_user_financial_data_owner
  ON public.user_financial_data
  FOR ALL TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam"
  USING (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()
  )
  WITH CHECK (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND user_id = hushh_identity.current_legacy_user_uuid()
  );

-- The historical diagnostics endpoint intentionally supports anonymous,
-- lossy logging.  The null-user branch is permitted only with no Firebase UID
-- in the transaction; an authenticated event must resolve to its owner.
CREATE POLICY financial_plaid_link_diagnostics_insert
  ON public.plaid_link_diagnostics
  FOR INSERT TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam"
  WITH CHECK (
    current_setting('app.firebase_project', true) = 'hushh-tech-uat'
    AND (
      (user_id IS NULL AND NULLIF(current_setting('app.firebase_uid', true), '') IS NULL)
      OR user_id = hushh_identity.current_legacy_user_uuid()
    )
  );

-- No broad schema/table/function grants are retained.  Public financial data
-- uses column grants so the deprecated plaintext plaid_access_token column is
-- never readable or writable by either GCP runtime role. Keep this block
-- under the sealed table owner rather than depending on `postgres` inheriting
-- that role's privileges in a managed Cloud SQL configuration.
REVOKE ALL ON SCHEMA public, hushh_identity, hushh_financial
  FROM "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam";
GRANT USAGE ON SCHEMA public, hushh_identity, hushh_financial
  TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam";

REVOKE ALL ON FUNCTION hushh_identity.current_legacy_user_uuid()
  FROM "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam";
GRANT EXECUTE ON FUNCTION hushh_identity.current_legacy_user_uuid()
  TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam";

REVOKE ALL PRIVILEGES ON TABLE
  public.onboarding_data,
  public.plaid_accounts,
  public.plaid_items,
  public.plaid_link_diagnostics,
  public.plaid_product_sync_statuses,
  public.plaid_statement_metadata,
  public.plaid_sync_cursors,
  public.plaid_transactions,
  public.user_financial_data,
  hushh_financial.sync_jobs,
  hushh_financial.sync_outbox
  FROM "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam";

-- The new financial tables deliberately use column grants too. A runtime
-- can advance a job lease/fence but cannot retarget job routing or an outbox
-- task identity after insert.
GRANT SELECT (
        id, user_id, firebase_uid, plaid_item_id, product, source, state,
        attempts, fencing_token, lease_expires_at, updated_at
      ),
      INSERT (
        user_id, firebase_uid, plaid_item_id, product, source, state,
        updated_at
      ),
      UPDATE (
        state, attempts, fencing_token, lease_expires_at, last_error_code,
        updated_at
      )
  ON hushh_financial.sync_jobs
  TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam";

GRANT SELECT (
        id, user_id, firebase_uid, plaid_item_id, product, source, state,
        attempts, fencing_token, lease_expires_at
      ),
      UPDATE (
        state, attempts, fencing_token, lease_expires_at, last_error_code,
        updated_at
      )
  ON hushh_financial.sync_jobs
  TO "hushh-tech-worker-uat@hushh-tech-uat.iam";

GRANT SELECT (job_id, task_name, state, attempts),
      INSERT (job_id, task_name, state, updated_at),
      UPDATE (state, attempts, last_error_code, published_at, updated_at)
  ON hushh_financial.sync_outbox
  TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam";

GRANT SELECT (
        user_id, financial_link_status, updated_at,
        legal_first_name, legal_last_name, phone_country_code, phone_number,
        address_line_1, address_line_2, city, state, zip_code, address_country
      ),
      INSERT (user_id, financial_link_status, updated_at),
      UPDATE (financial_link_status, updated_at)
  ON public.onboarding_data
  TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam";

GRANT SELECT (
        user_id, legal_first_name, legal_last_name, phone_country_code,
        phone_number, address_line_1, address_line_2, city, state, zip_code,
        address_country
      )
  ON public.onboarding_data
  TO "hushh-tech-worker-uat@hushh-tech-uat.iam";

GRANT SELECT (
        user_id, plaid_item_id, plaid_access_token_encrypted,
        institution_id, institution_name, products_requested, webhook_url,
        status, error_code, error_message, updated_at,
        last_sync_started_at
      ),
      INSERT (
        user_id, plaid_item_id, plaid_access_token_encrypted,
        institution_id, institution_name, products_requested, webhook_url,
        status, error_code, error_message, updated_at
      ),
      UPDATE (
        plaid_access_token_encrypted, institution_id, institution_name,
        products_requested, webhook_url, status, error_code, error_message,
        updated_at, last_data_sync_at, last_sync_started_at
      )
  ON public.plaid_items
  TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam";

GRANT SELECT (
        plaid_item_id, plaid_account_id, name, official_name, type, subtype,
        current_balance, available_balance, iso_currency_code, mask,
        last_synced_at, updated_at
      ),
      INSERT (
        plaid_item_id, plaid_account_id, name, official_name, type, subtype,
        current_balance, available_balance, iso_currency_code, mask,
        last_synced_at, updated_at
      ),
      UPDATE (
        name, official_name, type, subtype, current_balance, available_balance,
        iso_currency_code, mask, last_synced_at, updated_at
      )
  ON public.plaid_accounts
  TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam";

GRANT SELECT (
        user_id, plaid_item_id, product, status, available, records_count,
        error_code, error_message, request_id, attempts, started_at,
        completed_at, raw_metadata, created_at, updated_at
      ),
      INSERT (
        user_id, plaid_item_id, product, status, available, records_count,
        error_code, error_message, request_id, attempts, started_at,
        completed_at, raw_metadata, updated_at
      ),
      UPDATE (
        status, available, records_count, error_code, error_message, request_id,
        attempts, started_at, completed_at, raw_metadata, updated_at
      )
  ON public.plaid_product_sync_statuses
  TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam";

GRANT SELECT (plaid_item_id, cursor, last_synced_at, product, updated_at),
      INSERT (plaid_item_id, cursor, last_synced_at, product, updated_at),
      UPDATE (cursor, last_synced_at, updated_at)
  ON public.plaid_sync_cursors
  TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam";

GRANT SELECT (
        plaid_account_id, plaid_transaction_id, amount, iso_currency_code,
        date, name, merchant_name, category, pending, payment_channel,
        transaction_type, location
      ),
      INSERT (
        plaid_account_id, plaid_transaction_id, amount, iso_currency_code, date,
        name, merchant_name, category, pending, payment_channel,
        transaction_type, location
      ),
      UPDATE (
        plaid_account_id, amount, iso_currency_code, date, name, merchant_name,
        category, pending, payment_channel, transaction_type, location
      ),
      DELETE
  ON public.plaid_transactions
  TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam";

GRANT SELECT (
        user_id, plaid_item_id, plaid_account_id, statement_id,
        statement_date, period_start, period_end, status, metadata, updated_at
      ),
      INSERT (
        user_id, plaid_item_id, plaid_account_id, statement_id, statement_date,
        period_start, period_end, status, metadata, updated_at
      ),
      UPDATE (
        plaid_item_id, plaid_account_id, statement_date, period_start,
        period_end, status, metadata, updated_at
      )
  ON public.plaid_statement_metadata
  TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam";

GRANT SELECT (
        user_id, plaid_item_id, institution_name, institution_id, balances,
        asset_report, asset_report_token, investments, available_products,
        status, fetch_errors, updated_at, identity_data,
        identity_match_scores, signal_prepared, auth_numbers, identity_match,
        asset_report_status, asset_report_created_at, income_data,
        investment_transactions, liabilities_data, transactions_data,
        statements_data, plaid_sync_status, plaid_sync_completed_at,
        data_sync_summary
      ),
      INSERT (
        user_id, plaid_item_id, institution_name, institution_id, balances,
        asset_report, asset_report_token, investments, available_products,
        status, fetch_errors, updated_at, identity_data, identity_match_scores,
        signal_prepared, auth_numbers, identity_match, asset_report_status,
        asset_report_created_at, income_data, investment_transactions,
        liabilities_data, transactions_data, statements_data, plaid_sync_status,
        plaid_sync_completed_at, data_sync_summary
      ),
      UPDATE (
        plaid_item_id, institution_name, institution_id, balances, asset_report,
        asset_report_token, investments, available_products, status, fetch_errors,
        updated_at, identity_data, identity_match_scores, signal_prepared,
        auth_numbers, identity_match, asset_report_status,
        asset_report_created_at, income_data, investment_transactions,
        liabilities_data, transactions_data, statements_data, plaid_sync_status,
        plaid_sync_completed_at, data_sync_summary
      )
  ON public.user_financial_data
  TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam", "hushh-tech-worker-uat@hushh-tech-uat.iam";

GRANT INSERT (
        user_id, session_id, event_type, plaid_step, page_state, plaid_metadata,
        error_details, browser_context
      )
  ON public.plaid_link_diagnostics
  TO "hushh-tech-financial-api-uat@hushh-tech-uat.iam";

RESET ROLE;
REVOKE hushh_tech_schema_owner FROM postgres;

DO $verify$
DECLARE
  financial_role CONSTANT name := 'hushh-tech-financial-api-uat@hushh-tech-uat.iam';
  worker_role CONSTANT name := 'hushh-tech-worker-uat@hushh-tech-uat.iam';
  schema_owner CONSTANT name := 'hushh_tech_schema_owner';
  identity_provisioner CONSTANT name := 'hushh_tech_identity_provisioner';
  resolver CONSTANT regprocedure := 'hushh_identity.current_legacy_user_uuid()'::regprocedure;
  financial_tables text[];
  worker_tables text[];
  financial_sequences text[];
  worker_sequences text[];
  resolver_grants text[];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    INNER JOIN pg_catalog.pg_roles AS granted_role
      ON granted_role.oid = membership.roleid
    INNER JOIN pg_catalog.pg_roles AS member_role
      ON member_role.oid = membership.member
    WHERE member_role.rolname = 'postgres'
      AND granted_role.rolname = schema_owner
  ) THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_SCHEMA_OWNER_MEMBERSHIP_LEAK';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    INNER JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = namespace.nspowner
    WHERE namespace.nspname = 'hushh_financial'
      AND owner_role.rolname = schema_owner
  ) OR (
    SELECT count(*)
    FROM pg_catalog.pg_class AS relation
    INNER JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    INNER JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = relation.relowner
    WHERE namespace.nspname = 'hushh_financial'
      AND relation.relname IN ('sync_jobs', 'sync_outbox')
      AND relation.relkind = 'r'
      AND relation.relrowsecurity IS TRUE
      AND relation.relforcerowsecurity IS TRUE
      AND owner_role.rolname = schema_owner
  ) <> 2 THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_NEW_RELATION_INVALID';
  END IF;

  SELECT array_agg(
    format(
      '%s:%s',
      CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
      acl.privilege_type
    )
    ORDER BY
      CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
      acl.privilege_type
  )
  INTO resolver_grants
  FROM pg_catalog.pg_proc AS routine
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(routine.proacl, pg_catalog.acldefault('f'::"char", routine.proowner))
  ) AS acl
  WHERE routine.oid = resolver;

  IF resolver_grants IS DISTINCT FROM ARRAY[
       'hushh-tech-financial-api-uat@hushh-tech-uat.iam:EXECUTE',
       'hushh-tech-worker-uat@hushh-tech-uat.iam:EXECUTE',
       'hushh_tech_identity_provisioner:EXECUTE',
       'hushh_tech_schema_owner:EXECUTE'
     ]::text[]
     OR NOT has_function_privilege(financial_role, resolver, 'EXECUTE')
     OR NOT has_function_privilege(worker_role, resolver, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS routine
       INNER JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = routine.pronamespace
       WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
         AND routine.prosecdef IS TRUE
         AND routine.oid <> resolver
         AND (
           has_function_privilege(financial_role, routine.oid, 'EXECUTE')
           OR has_function_privilege(worker_role, routine.oid, 'EXECUTE')
         )
     ) THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_ROUTINE_GRANT_DRIFT';
  END IF;

  -- The financial runtime needs no PostgreSQL sequence: every new identifier
  -- is UUID/clock based, and fencing is an explicit guarded bigint update.
  SELECT array_agg(
    format('%I.%I:%s', namespace.nspname, relation.relname, privilege.privilege_type)
    ORDER BY namespace.nspname, relation.relname, privilege.privilege_type
  )
  INTO financial_sequences
  FROM pg_catalog.pg_class AS relation
  INNER JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  CROSS JOIN (VALUES ('SELECT'), ('UPDATE'), ('USAGE')) AS privilege(privilege_type)
  WHERE relation.relkind = 'S'
    AND namespace.nspname <> 'information_schema'
    AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    AND has_sequence_privilege(financial_role, relation.oid, privilege.privilege_type);

  SELECT array_agg(
    format('%I.%I:%s', namespace.nspname, relation.relname, privilege.privilege_type)
    ORDER BY namespace.nspname, relation.relname, privilege.privilege_type
  )
  INTO worker_sequences
  FROM pg_catalog.pg_class AS relation
  INNER JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  CROSS JOIN (VALUES ('SELECT'), ('UPDATE'), ('USAGE')) AS privilege(privilege_type)
  WHERE relation.relkind = 'S'
    AND namespace.nspname <> 'information_schema'
    AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    AND has_sequence_privilege(worker_role, relation.oid, privilege.privilege_type);

  IF financial_sequences IS NOT NULL OR worker_sequences IS NOT NULL THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_SEQUENCE_PRIVILEGE_DRIFT';
  END IF;

  SELECT array_agg(
    format('%I.%I:%s', namespace.nspname, relation.relname, privilege.privilege_type)
    ORDER BY namespace.nspname, relation.relname, privilege.privilege_type
  )
  INTO financial_tables
  FROM pg_catalog.pg_class AS relation
  INNER JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS privilege(privilege_type)
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND namespace.nspname <> 'information_schema'
    AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    AND has_table_privilege(financial_role, relation.oid, privilege.privilege_type);

  SELECT array_agg(
    format('%I.%I:%s', namespace.nspname, relation.relname, privilege.privilege_type)
    ORDER BY namespace.nspname, relation.relname, privilege.privilege_type
  )
  INTO worker_tables
  FROM pg_catalog.pg_class AS relation
  INNER JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS privilege(privilege_type)
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND namespace.nspname <> 'information_schema'
    AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    AND has_table_privilege(worker_role, relation.oid, privilege.privilege_type);

  -- All SELECT/INSERT/UPDATE grants are column-level.  The only retained
  -- table-wide DML grant is DELETE, which PostgreSQL cannot express per
  -- column and the fixed transaction-sync statement requires.
  IF financial_tables IS DISTINCT FROM ARRAY[
    'public.plaid_transactions:DELETE'
  ]::text[] OR worker_tables IS DISTINCT FROM ARRAY[
    'public.plaid_transactions:DELETE'
  ]::text[] THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_TABLE_PRIVILEGE_DRIFT';
  END IF;

  -- The newly introduced operational relations are not a generic database
  -- surface. Their direct ACL must remain the fixed-query minimum: no service
  -- can alter ownership, job routing, or outbox task identity after insert.
  -- Compare raw column ACL rows (rather than
  -- has_column_privilege) so a future table-wide grant cannot masquerade as
  -- an expected column permission.
  IF EXISTS (
    WITH expected(role_name, table_name, column_name, privilege_type) AS (
      SELECT financial_role::text, 'sync_jobs', column_name, 'SELECT'
      FROM unnest(ARRAY[
        'id', 'user_id', 'firebase_uid', 'plaid_item_id', 'product', 'source',
        'state', 'attempts', 'fencing_token', 'lease_expires_at', 'updated_at'
      ]::text[]) AS column_name
      UNION ALL
      SELECT financial_role::text, 'sync_jobs', column_name, 'INSERT'
      FROM unnest(ARRAY[
        'user_id', 'firebase_uid', 'plaid_item_id', 'product', 'source',
        'state', 'updated_at'
      ]::text[]) AS column_name
      UNION ALL
      SELECT financial_role::text, 'sync_jobs', column_name, 'UPDATE'
      FROM unnest(ARRAY[
        'state', 'attempts', 'fencing_token', 'lease_expires_at',
        'last_error_code', 'updated_at'
      ]::text[]) AS column_name

      UNION ALL
      SELECT worker_role::text, 'sync_jobs', column_name, 'SELECT'
      FROM unnest(ARRAY[
        'id', 'user_id', 'firebase_uid', 'plaid_item_id', 'product', 'source',
        'state', 'attempts', 'fencing_token', 'lease_expires_at'
      ]::text[]) AS column_name
      UNION ALL
      SELECT worker_role::text, 'sync_jobs', column_name, 'UPDATE'
      FROM unnest(ARRAY[
        'state', 'attempts', 'fencing_token', 'lease_expires_at',
        'last_error_code', 'updated_at'
      ]::text[]) AS column_name

      UNION ALL
      SELECT financial_role::text, 'sync_outbox', column_name, 'SELECT'
      FROM unnest(ARRAY['job_id', 'task_name', 'state', 'attempts']::text[]) AS column_name
      UNION ALL
      SELECT financial_role::text, 'sync_outbox', column_name, 'INSERT'
      FROM unnest(ARRAY['job_id', 'task_name', 'state', 'updated_at']::text[]) AS column_name
      UNION ALL
      SELECT financial_role::text, 'sync_outbox', column_name, 'UPDATE'
      FROM unnest(ARRAY[
        'state', 'attempts', 'last_error_code', 'published_at', 'updated_at'
      ]::text[]) AS column_name
    ),
    actual(role_name, table_name, column_name, privilege_type) AS (
      SELECT
        granted_role.rolname::text,
        relation.relname::text,
        attribute.attname::text,
        acl.privilege_type::text
      FROM pg_catalog.pg_class AS relation
      INNER JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      INNER JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
        AND attribute.attnum > 0
        AND attribute.attisdropped IS FALSE
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl
      INNER JOIN pg_catalog.pg_roles AS granted_role
        ON granted_role.oid = acl.grantee
      WHERE namespace.nspname = 'hushh_financial'
        AND relation.relkind = 'r'
        AND granted_role.rolname IN (financial_role, worker_role)
    )
    SELECT 1
    FROM (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    ) AS drift
  ) THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_OPERATIONAL_COLUMN_PRIVILEGE_DRIFT';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    INNER JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    INNER JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
      AND attribute.attnum > 0
      AND attribute.attisdropped IS FALSE
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'user_financial_data'
      AND attribute.attname = 'plaid_access_token'
      AND (
        has_column_privilege(financial_role, relation.oid, attribute.attnum, 'SELECT')
        OR has_column_privilege(financial_role, relation.oid, attribute.attnum, 'INSERT')
        OR has_column_privilege(financial_role, relation.oid, attribute.attnum, 'UPDATE')
        OR has_column_privilege(worker_role, relation.oid, attribute.attnum, 'SELECT')
        OR has_column_privilege(worker_role, relation.oid, attribute.attnum, 'INSERT')
        OR has_column_privilege(worker_role, relation.oid, attribute.attnum, 'UPDATE')
      )
  ) THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_PLAINTEXT_TOKEN_PRIVILEGE';
  END IF;

  -- Identity Match must retain its legacy, read-only onboarding projection for
  -- both the synchronous API and the product worker.  A worker write here
  -- would cross the financial boundary into onboarding ownership.
  IF EXISTS (
    WITH identity_match_column(column_name) AS (
      VALUES
        ('legal_first_name'),
        ('legal_last_name'),
        ('phone_country_code'),
        ('phone_number'),
        ('address_line_1'),
        ('address_line_2'),
        ('city'),
        ('state'),
        ('zip_code'),
        ('address_country')
    )
    SELECT 1
    FROM identity_match_column
    WHERE NOT has_column_privilege(
      financial_role,
      'public.onboarding_data'::regclass,
      identity_match_column.column_name,
      'SELECT'
    )
      OR NOT has_column_privilege(
        worker_role,
        'public.onboarding_data'::regclass,
        identity_match_column.column_name,
        'SELECT'
      )
      OR has_column_privilege(
        worker_role,
        'public.onboarding_data'::regclass,
        identity_match_column.column_name,
        'INSERT'
      )
      OR has_column_privilege(
        worker_role,
        'public.onboarding_data'::regclass,
        identity_match_column.column_name,
        'UPDATE'
      )
  ) OR NOT has_column_privilege(
    worker_role,
    'public.onboarding_data'::regclass,
    'user_id',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_IDENTITY_MATCH_ONBOARDING_PRIVILEGE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    INNER JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND relation.relkind IN ('r', 'p')
      AND (
        (
          has_table_privilege(financial_role, relation.oid, 'SELECT')
          OR has_table_privilege(financial_role, relation.oid, 'INSERT')
          OR has_table_privilege(financial_role, relation.oid, 'UPDATE')
          OR has_table_privilege(financial_role, relation.oid, 'DELETE')
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = relation.oid
            AND attribute.attnum > 0
            AND attribute.attisdropped IS FALSE
            AND (
              has_column_privilege(financial_role, relation.oid, attribute.attnum, 'SELECT')
              OR has_column_privilege(financial_role, relation.oid, attribute.attnum, 'INSERT')
              OR has_column_privilege(financial_role, relation.oid, attribute.attnum, 'UPDATE')
            )
        )
        OR has_table_privilege(worker_role, relation.oid, 'SELECT')
        OR has_table_privilege(worker_role, relation.oid, 'INSERT')
        OR has_table_privilege(worker_role, relation.oid, 'UPDATE')
        OR has_table_privilege(worker_role, relation.oid, 'DELETE')
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = relation.oid
            AND attribute.attnum > 0
            AND attribute.attisdropped IS FALSE
            AND (
              has_column_privilege(worker_role, relation.oid, attribute.attnum, 'SELECT')
              OR has_column_privilege(worker_role, relation.oid, attribute.attnum, 'INSERT')
              OR has_column_privilege(worker_role, relation.oid, attribute.attnum, 'UPDATE')
            )
        )
      )
      AND (
        relation.relrowsecurity IS NOT TRUE
        OR relation.relforcerowsecurity IS NOT TRUE
      )
  ) THEN
    RAISE EXCEPTION 'FINANCIAL_LINK_BOUNDARY_RLS_DRIFT';
  END IF;
END
$verify$;

COMMIT;
