BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';
SELECT
  'tables'::text AS inventory_section,
  n.nspname AS schema_name,
  c.relname AS table_name,
  ((xpath('/table/row/row_count/text()', query_to_xml(
    format('SELECT count(*)::bigint AS row_count FROM %I.%I', n.nspname, c.relname),
    false, false, ''
  )))[1]::text)::bigint AS row_count,
  array_agg(a.attname ORDER BY key_column.ordinal_position) AS primary_key
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_index AS i ON i.indrelid = c.oid AND i.indisprimary
JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, ordinal_position) ON true
JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum = key_column.attnum
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  AND c.relname IN ('agent_profiles', 'agent_reviews', 'analytics_events', 'app_config', 'blocked_agents', 'blog_drafts', 'ceo_meeting_payments', 'community_registrations', 'consents', 'consumer_profiles', 'content_items', 'content_versions', 'conversations', 'delete_requests', 'deleted_account_payment_audits', 'devices', 'fund_admin_access_log', 'fund_investment_plans', 'fund_investor_notes', 'fund_investor_tags', 'fund_payment_notifications', 'fund_payment_reviews', 'fund_recurring_transfers', 'fund_stripe_events', 'fund_stripe_payment_requests', 'fund_stripe_payments', 'fund_stripe_subscriptions', 'fund_transfers', 'identity_verifications', 'investor_profiles', 'kirkland_agents', 'kyc_profiles', 'lead_events', 'lead_requests', 'messages', 'nda_signatures', 'notifications', 'onboarding_data', 'onboarding_invites', 'onboarding_parties', 'otp_codes', 'plaid_accounts', 'plaid_data_events', 'plaid_items', 'plaid_link_diagnostics', 'plaid_product_sync_statuses', 'plaid_statement_metadata', 'plaid_sync_cursors', 'plaid_transactions', 'plaid_transfer_accounts', 'plaid_transfer_events', 'site_analytics_events', 'site_analytics_sessions', 'swipe_actions', 'transfer_email_notifications', 'user_agent_selections', 'user_enriched_profiles', 'user_financial_data', 'user_product_usage', 'users', 'wa_classifications', 'wa_extractions', 'wa_groups', 'wa_jobs', 'wa_links', 'wa_media', 'wa_messages', 'wa_review_actions', 'wa_sender_identities', 'wa_senders')
GROUP BY n.nspname, c.relname
ORDER BY c.relname;
SELECT
  'columns'::text AS inventory_section,
  table_schema AS schema_name, table_name, column_name, ordinal_position,
  data_type, udt_schema, udt_name, is_nullable = 'YES' AS nullable,
  column_default IS NOT NULL AS has_default,
  CASE WHEN column_default IS NULL THEN NULL ELSE encode(extensions.digest(convert_to(
    btrim(replace(replace(column_default, chr(13) || chr(10), chr(10)), chr(13), chr(10))), 'UTF8'
  ), 'sha256'), 'hex') END AS default_expression_hash,
  is_identity = 'YES' AS identity,
  is_generated <> 'NEVER' AS generated
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('agent_profiles', 'agent_reviews', 'analytics_events', 'app_config', 'blocked_agents', 'blog_drafts', 'ceo_meeting_payments', 'community_registrations', 'consents', 'consumer_profiles', 'content_items', 'content_versions', 'conversations', 'delete_requests', 'deleted_account_payment_audits', 'devices', 'fund_admin_access_log', 'fund_investment_plans', 'fund_investor_notes', 'fund_investor_tags', 'fund_payment_notifications', 'fund_payment_reviews', 'fund_recurring_transfers', 'fund_stripe_events', 'fund_stripe_payment_requests', 'fund_stripe_payments', 'fund_stripe_subscriptions', 'fund_transfers', 'identity_verifications', 'investor_profiles', 'kirkland_agents', 'kyc_profiles', 'lead_events', 'lead_requests', 'messages', 'nda_signatures', 'notifications', 'onboarding_data', 'onboarding_invites', 'onboarding_parties', 'otp_codes', 'plaid_accounts', 'plaid_data_events', 'plaid_items', 'plaid_link_diagnostics', 'plaid_product_sync_statuses', 'plaid_statement_metadata', 'plaid_sync_cursors', 'plaid_transactions', 'plaid_transfer_accounts', 'plaid_transfer_events', 'site_analytics_events', 'site_analytics_sessions', 'swipe_actions', 'transfer_email_notifications', 'user_agent_selections', 'user_enriched_profiles', 'user_financial_data', 'user_product_usage', 'users', 'wa_classifications', 'wa_extractions', 'wa_groups', 'wa_jobs', 'wa_links', 'wa_media', 'wa_messages', 'wa_review_actions', 'wa_sender_identities', 'wa_senders')
ORDER BY table_name, ordinal_position;
SELECT
  'foreign_keys'::text AS inventory_section,
  n.nspname AS schema_name, c.relname AS table_name, con.conname AS name,
  pg_catalog.pg_get_constraintdef(con.oid, false) AS definition
FROM pg_catalog.pg_constraint AS con
JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND con.contype = 'f'
  AND c.relname IN ('agent_profiles', 'agent_reviews', 'analytics_events', 'app_config', 'blocked_agents', 'blog_drafts', 'ceo_meeting_payments', 'community_registrations', 'consents', 'consumer_profiles', 'content_items', 'content_versions', 'conversations', 'delete_requests', 'deleted_account_payment_audits', 'devices', 'fund_admin_access_log', 'fund_investment_plans', 'fund_investor_notes', 'fund_investor_tags', 'fund_payment_notifications', 'fund_payment_reviews', 'fund_recurring_transfers', 'fund_stripe_events', 'fund_stripe_payment_requests', 'fund_stripe_payments', 'fund_stripe_subscriptions', 'fund_transfers', 'identity_verifications', 'investor_profiles', 'kirkland_agents', 'kyc_profiles', 'lead_events', 'lead_requests', 'messages', 'nda_signatures', 'notifications', 'onboarding_data', 'onboarding_invites', 'onboarding_parties', 'otp_codes', 'plaid_accounts', 'plaid_data_events', 'plaid_items', 'plaid_link_diagnostics', 'plaid_product_sync_statuses', 'plaid_statement_metadata', 'plaid_sync_cursors', 'plaid_transactions', 'plaid_transfer_accounts', 'plaid_transfer_events', 'site_analytics_events', 'site_analytics_sessions', 'swipe_actions', 'transfer_email_notifications', 'user_agent_selections', 'user_enriched_profiles', 'user_financial_data', 'user_product_usage', 'users', 'wa_classifications', 'wa_extractions', 'wa_groups', 'wa_jobs', 'wa_links', 'wa_media', 'wa_messages', 'wa_review_actions', 'wa_sender_identities', 'wa_senders')
ORDER BY c.relname, con.conname;
SELECT
  'check_constraints'::text AS inventory_section,
  n.nspname AS schema_name, c.relname AS table_name, con.conname AS name,
  pg_catalog.pg_get_constraintdef(con.oid, false) AS definition
FROM pg_catalog.pg_constraint AS con
JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND con.contype = 'c'
  AND c.relname IN ('agent_profiles', 'agent_reviews', 'analytics_events', 'app_config', 'blocked_agents', 'blog_drafts', 'ceo_meeting_payments', 'community_registrations', 'consents', 'consumer_profiles', 'content_items', 'content_versions', 'conversations', 'delete_requests', 'deleted_account_payment_audits', 'devices', 'fund_admin_access_log', 'fund_investment_plans', 'fund_investor_notes', 'fund_investor_tags', 'fund_payment_notifications', 'fund_payment_reviews', 'fund_recurring_transfers', 'fund_stripe_events', 'fund_stripe_payment_requests', 'fund_stripe_payments', 'fund_stripe_subscriptions', 'fund_transfers', 'identity_verifications', 'investor_profiles', 'kirkland_agents', 'kyc_profiles', 'lead_events', 'lead_requests', 'messages', 'nda_signatures', 'notifications', 'onboarding_data', 'onboarding_invites', 'onboarding_parties', 'otp_codes', 'plaid_accounts', 'plaid_data_events', 'plaid_items', 'plaid_link_diagnostics', 'plaid_product_sync_statuses', 'plaid_statement_metadata', 'plaid_sync_cursors', 'plaid_transactions', 'plaid_transfer_accounts', 'plaid_transfer_events', 'site_analytics_events', 'site_analytics_sessions', 'swipe_actions', 'transfer_email_notifications', 'user_agent_selections', 'user_enriched_profiles', 'user_financial_data', 'user_product_usage', 'users', 'wa_classifications', 'wa_extractions', 'wa_groups', 'wa_jobs', 'wa_links', 'wa_media', 'wa_messages', 'wa_review_actions', 'wa_sender_identities', 'wa_senders')
ORDER BY c.relname, con.conname;
SELECT
  'indexes'::text AS inventory_section,
  schemaname AS schema_name, tablename AS table_name, indexname AS name,
  indexdef AS definition
FROM pg_catalog.pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('agent_profiles', 'agent_reviews', 'analytics_events', 'app_config', 'blocked_agents', 'blog_drafts', 'ceo_meeting_payments', 'community_registrations', 'consents', 'consumer_profiles', 'content_items', 'content_versions', 'conversations', 'delete_requests', 'deleted_account_payment_audits', 'devices', 'fund_admin_access_log', 'fund_investment_plans', 'fund_investor_notes', 'fund_investor_tags', 'fund_payment_notifications', 'fund_payment_reviews', 'fund_recurring_transfers', 'fund_stripe_events', 'fund_stripe_payment_requests', 'fund_stripe_payments', 'fund_stripe_subscriptions', 'fund_transfers', 'identity_verifications', 'investor_profiles', 'kirkland_agents', 'kyc_profiles', 'lead_events', 'lead_requests', 'messages', 'nda_signatures', 'notifications', 'onboarding_data', 'onboarding_invites', 'onboarding_parties', 'otp_codes', 'plaid_accounts', 'plaid_data_events', 'plaid_items', 'plaid_link_diagnostics', 'plaid_product_sync_statuses', 'plaid_statement_metadata', 'plaid_sync_cursors', 'plaid_transactions', 'plaid_transfer_accounts', 'plaid_transfer_events', 'site_analytics_events', 'site_analytics_sessions', 'swipe_actions', 'transfer_email_notifications', 'user_agent_selections', 'user_enriched_profiles', 'user_financial_data', 'user_product_usage', 'users', 'wa_classifications', 'wa_extractions', 'wa_groups', 'wa_jobs', 'wa_links', 'wa_media', 'wa_messages', 'wa_review_actions', 'wa_sender_identities', 'wa_senders')
ORDER BY tablename, indexname;
SELECT
  'sequences'::text AS inventory_section,
  schemaname AS schema_name, sequencename AS name, data_type::text AS data_type,
  start_value::text, min_value::text, max_value::text, increment_by::text,
  cycle, cache_size::text,
  CASE WHEN dep_table.oid IS NULL THEN NULL ELSE
    quote_ident(dep_table_ns.nspname) || '.' || quote_ident(dep_table.relname) || '.' || quote_ident(dep_column.attname)
  END AS owned_by
FROM pg_catalog.pg_sequences AS seq
LEFT JOIN pg_catalog.pg_namespace AS sequence_namespace
  ON sequence_namespace.nspname = seq.schemaname
LEFT JOIN pg_catalog.pg_class AS sequence_class
  ON sequence_class.relnamespace = sequence_namespace.oid
  AND sequence_class.relname = seq.sequencename AND sequence_class.relkind = 'S'
LEFT JOIN pg_catalog.pg_depend AS dep
  ON dep.objid = sequence_class.oid AND dep.deptype IN ('a', 'i')
LEFT JOIN pg_catalog.pg_class AS dep_table ON dep_table.oid = dep.refobjid
LEFT JOIN pg_catalog.pg_namespace AS dep_table_ns ON dep_table_ns.oid = dep_table.relnamespace
LEFT JOIN pg_catalog.pg_attribute AS dep_column
  ON dep_column.attrelid = dep.refobjid AND dep_column.attnum = dep.refobjsubid
WHERE seq.schemaname = 'public'
ORDER BY seq.sequencename;
SELECT
  'triggers'::text AS inventory_section,
  table_ns.nspname AS schema_name, table_class.relname AS table_name,
  trigger.tgname AS name, function_ns.nspname AS function_schema,
  function_proc.proname AS function_name,
  pg_catalog.pg_get_triggerdef(trigger.oid, false) AS definition
FROM pg_catalog.pg_trigger AS trigger
JOIN pg_catalog.pg_class AS table_class ON table_class.oid = trigger.tgrelid
JOIN pg_catalog.pg_namespace AS table_ns ON table_ns.oid = table_class.relnamespace
JOIN pg_catalog.pg_proc AS function_proc ON function_proc.oid = trigger.tgfoid
JOIN pg_catalog.pg_namespace AS function_ns ON function_ns.oid = function_proc.pronamespace
WHERE table_ns.nspname = 'public' AND NOT trigger.tgisinternal
  AND table_class.relname IN ('agent_profiles', 'agent_reviews', 'analytics_events', 'app_config', 'blocked_agents', 'blog_drafts', 'ceo_meeting_payments', 'community_registrations', 'consents', 'consumer_profiles', 'content_items', 'content_versions', 'conversations', 'delete_requests', 'deleted_account_payment_audits', 'devices', 'fund_admin_access_log', 'fund_investment_plans', 'fund_investor_notes', 'fund_investor_tags', 'fund_payment_notifications', 'fund_payment_reviews', 'fund_recurring_transfers', 'fund_stripe_events', 'fund_stripe_payment_requests', 'fund_stripe_payments', 'fund_stripe_subscriptions', 'fund_transfers', 'identity_verifications', 'investor_profiles', 'kirkland_agents', 'kyc_profiles', 'lead_events', 'lead_requests', 'messages', 'nda_signatures', 'notifications', 'onboarding_data', 'onboarding_invites', 'onboarding_parties', 'otp_codes', 'plaid_accounts', 'plaid_data_events', 'plaid_items', 'plaid_link_diagnostics', 'plaid_product_sync_statuses', 'plaid_statement_metadata', 'plaid_sync_cursors', 'plaid_transactions', 'plaid_transfer_accounts', 'plaid_transfer_events', 'site_analytics_events', 'site_analytics_sessions', 'swipe_actions', 'transfer_email_notifications', 'user_agent_selections', 'user_enriched_profiles', 'user_financial_data', 'user_product_usage', 'users', 'wa_classifications', 'wa_extractions', 'wa_groups', 'wa_jobs', 'wa_links', 'wa_media', 'wa_messages', 'wa_review_actions', 'wa_sender_identities', 'wa_senders')
ORDER BY table_class.relname, trigger.tgname;
SELECT
  'functions'::text AS inventory_section,
  n.nspname AS schema_name, p.proname AS name,
  pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  pg_catalog.pg_get_function_result(p.oid) AS result_type,
  language.lanname AS language,
  CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END AS kind,
  CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END AS volatility,
  p.prosecdef AS security_definer,
  EXISTS (SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_proc'::regclass
      AND extension_dependency.objid = p.oid
      AND extension_dependency.deptype = 'e') AS extension_owned,
  CASE WHEN p.prokind IN ('f', 'p') AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
    WHERE extension_dependency.classid = 'pg_proc'::regclass
      AND extension_dependency.objid = p.oid
      AND extension_dependency.deptype = 'e'
  ) THEN encode(extensions.digest(convert_to(
    btrim(replace(replace(pg_catalog.pg_get_functiondef(p.oid), chr(13) || chr(10), chr(10)), chr(13), chr(10))), 'UTF8'
  ), 'sha256'), 'hex') ELSE NULL END AS definition_hash
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
JOIN pg_catalog.pg_language AS language ON language.oid = p.prolang
WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p', 'a')
ORDER BY p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid);
SELECT
  'public_policies'::text AS inventory_section,
  schemaname AS schema_name, tablename AS table_name, policyname AS name,
  cmd AS command, permissive, roles, qual AS using_expression,
  with_check AS check_expression
FROM pg_catalog.pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
SELECT
  'storage_policies'::text AS inventory_section,
  schemaname AS schema_name, tablename AS table_name, policyname AS name,
  cmd AS command, permissive, roles, qual AS using_expression,
  with_check AS check_expression
FROM pg_catalog.pg_policies
WHERE schemaname = 'storage'
ORDER BY tablename, policyname;
SELECT
  'extensions'::text AS inventory_section,
  extension.extname AS name, namespace.nspname AS schema_name,
  extension.extversion AS version
FROM pg_catalog.pg_extension AS extension
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
ORDER BY extension.extname;
SELECT
  'grants'::text AS inventory_section,
  CASE object.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS object_type,
  namespace.nspname AS object_schema, object.relname AS object_name,
  CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS grantee,
  acl.privilege_type AS privilege, acl.is_grantable
FROM pg_catalog.pg_class AS object
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = object.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(
  coalesce(object.relacl, pg_catalog.acldefault(
    CASE object.relkind WHEN 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
    object.relowner
  ))
) AS acl
WHERE namespace.nspname = 'public'
  AND ((object.relkind IN ('r', 'p') AND object.relname IN ('agent_profiles', 'agent_reviews', 'analytics_events', 'app_config', 'blocked_agents', 'blog_drafts', 'ceo_meeting_payments', 'community_registrations', 'consents', 'consumer_profiles', 'content_items', 'content_versions', 'conversations', 'delete_requests', 'deleted_account_payment_audits', 'devices', 'fund_admin_access_log', 'fund_investment_plans', 'fund_investor_notes', 'fund_investor_tags', 'fund_payment_notifications', 'fund_payment_reviews', 'fund_recurring_transfers', 'fund_stripe_events', 'fund_stripe_payment_requests', 'fund_stripe_payments', 'fund_stripe_subscriptions', 'fund_transfers', 'identity_verifications', 'investor_profiles', 'kirkland_agents', 'kyc_profiles', 'lead_events', 'lead_requests', 'messages', 'nda_signatures', 'notifications', 'onboarding_data', 'onboarding_invites', 'onboarding_parties', 'otp_codes', 'plaid_accounts', 'plaid_data_events', 'plaid_items', 'plaid_link_diagnostics', 'plaid_product_sync_statuses', 'plaid_statement_metadata', 'plaid_sync_cursors', 'plaid_transactions', 'plaid_transfer_accounts', 'plaid_transfer_events', 'site_analytics_events', 'site_analytics_sessions', 'swipe_actions', 'transfer_email_notifications', 'user_agent_selections', 'user_enriched_profiles', 'user_financial_data', 'user_product_usage', 'users', 'wa_classifications', 'wa_extractions', 'wa_groups', 'wa_jobs', 'wa_links', 'wa_media', 'wa_messages', 'wa_review_actions', 'wa_sender_identities', 'wa_senders')) OR object.relkind = 'S')
UNION ALL
SELECT
  'grants'::text, 'ROUTINE'::text, namespace.nspname,
  routine.proname || '(' || pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')',
  CASE acl.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee) END,
  acl.privilege_type, acl.is_grantable
FROM pg_catalog.pg_proc AS routine
JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(
  coalesce(routine.proacl, pg_catalog.acldefault('f'::"char", routine.proowner))
) AS acl
WHERE namespace.nspname = 'public' AND routine.prokind IN ('f', 'p', 'a')
ORDER BY object_type, object_name, grantee, privilege;
SELECT
  'catalog_counts'::text AS inventory_section,
  (SELECT count(*)::bigint FROM pg_catalog.pg_class AS counted_class
    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_class.relnamespace
    WHERE counted_ns.nspname = 'public' AND counted_class.relkind IN ('r', 'p')) AS public_tables,
  (SELECT count(*)::bigint FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('agent_profiles', 'agent_reviews', 'analytics_events', 'app_config', 'blocked_agents', 'blog_drafts', 'ceo_meeting_payments', 'community_registrations', 'consents', 'consumer_profiles', 'content_items', 'content_versions', 'conversations', 'delete_requests', 'deleted_account_payment_audits', 'devices', 'fund_admin_access_log', 'fund_investment_plans', 'fund_investor_notes', 'fund_investor_tags', 'fund_payment_notifications', 'fund_payment_reviews', 'fund_recurring_transfers', 'fund_stripe_events', 'fund_stripe_payment_requests', 'fund_stripe_payments', 'fund_stripe_subscriptions', 'fund_transfers', 'identity_verifications', 'investor_profiles', 'kirkland_agents', 'kyc_profiles', 'lead_events', 'lead_requests', 'messages', 'nda_signatures', 'notifications', 'onboarding_data', 'onboarding_invites', 'onboarding_parties', 'otp_codes', 'plaid_accounts', 'plaid_data_events', 'plaid_items', 'plaid_link_diagnostics', 'plaid_product_sync_statuses', 'plaid_statement_metadata', 'plaid_sync_cursors', 'plaid_transactions', 'plaid_transfer_accounts', 'plaid_transfer_events', 'site_analytics_events', 'site_analytics_sessions', 'swipe_actions', 'transfer_email_notifications', 'user_agent_selections', 'user_enriched_profiles', 'user_financial_data', 'user_product_usage', 'users', 'wa_classifications', 'wa_extractions', 'wa_groups', 'wa_jobs', 'wa_links', 'wa_media', 'wa_messages', 'wa_review_actions', 'wa_sender_identities', 'wa_senders')) AS columns,
  (SELECT count(*)::bigint FROM pg_catalog.pg_constraint AS counted_constraint
    JOIN pg_catalog.pg_class AS counted_class ON counted_class.oid = counted_constraint.conrelid
    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_class.relnamespace
    WHERE counted_ns.nspname = 'public' AND counted_constraint.contype = 'f'
      AND counted_class.relname IN ('agent_profiles', 'agent_reviews', 'analytics_events', 'app_config', 'blocked_agents', 'blog_drafts', 'ceo_meeting_payments', 'community_registrations', 'consents', 'consumer_profiles', 'content_items', 'content_versions', 'conversations', 'delete_requests', 'deleted_account_payment_audits', 'devices', 'fund_admin_access_log', 'fund_investment_plans', 'fund_investor_notes', 'fund_investor_tags', 'fund_payment_notifications', 'fund_payment_reviews', 'fund_recurring_transfers', 'fund_stripe_events', 'fund_stripe_payment_requests', 'fund_stripe_payments', 'fund_stripe_subscriptions', 'fund_transfers', 'identity_verifications', 'investor_profiles', 'kirkland_agents', 'kyc_profiles', 'lead_events', 'lead_requests', 'messages', 'nda_signatures', 'notifications', 'onboarding_data', 'onboarding_invites', 'onboarding_parties', 'otp_codes', 'plaid_accounts', 'plaid_data_events', 'plaid_items', 'plaid_link_diagnostics', 'plaid_product_sync_statuses', 'plaid_statement_metadata', 'plaid_sync_cursors', 'plaid_transactions', 'plaid_transfer_accounts', 'plaid_transfer_events', 'site_analytics_events', 'site_analytics_sessions', 'swipe_actions', 'transfer_email_notifications', 'user_agent_selections', 'user_enriched_profiles', 'user_financial_data', 'user_product_usage', 'users', 'wa_classifications', 'wa_extractions', 'wa_groups', 'wa_jobs', 'wa_links', 'wa_media', 'wa_messages', 'wa_review_actions', 'wa_sender_identities', 'wa_senders')) AS foreign_keys,
  (SELECT count(*)::bigint FROM pg_catalog.pg_constraint AS counted_constraint
    JOIN pg_catalog.pg_class AS counted_class ON counted_class.oid = counted_constraint.conrelid
    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_class.relnamespace
    WHERE counted_ns.nspname = 'public' AND counted_constraint.contype = 'c'
      AND counted_class.relname IN ('agent_profiles', 'agent_reviews', 'analytics_events', 'app_config', 'blocked_agents', 'blog_drafts', 'ceo_meeting_payments', 'community_registrations', 'consents', 'consumer_profiles', 'content_items', 'content_versions', 'conversations', 'delete_requests', 'deleted_account_payment_audits', 'devices', 'fund_admin_access_log', 'fund_investment_plans', 'fund_investor_notes', 'fund_investor_tags', 'fund_payment_notifications', 'fund_payment_reviews', 'fund_recurring_transfers', 'fund_stripe_events', 'fund_stripe_payment_requests', 'fund_stripe_payments', 'fund_stripe_subscriptions', 'fund_transfers', 'identity_verifications', 'investor_profiles', 'kirkland_agents', 'kyc_profiles', 'lead_events', 'lead_requests', 'messages', 'nda_signatures', 'notifications', 'onboarding_data', 'onboarding_invites', 'onboarding_parties', 'otp_codes', 'plaid_accounts', 'plaid_data_events', 'plaid_items', 'plaid_link_diagnostics', 'plaid_product_sync_statuses', 'plaid_statement_metadata', 'plaid_sync_cursors', 'plaid_transactions', 'plaid_transfer_accounts', 'plaid_transfer_events', 'site_analytics_events', 'site_analytics_sessions', 'swipe_actions', 'transfer_email_notifications', 'user_agent_selections', 'user_enriched_profiles', 'user_financial_data', 'user_product_usage', 'users', 'wa_classifications', 'wa_extractions', 'wa_groups', 'wa_jobs', 'wa_links', 'wa_media', 'wa_messages', 'wa_review_actions', 'wa_sender_identities', 'wa_senders')) AS check_constraints,
  (SELECT count(*)::bigint FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('agent_profiles', 'agent_reviews', 'analytics_events', 'app_config', 'blocked_agents', 'blog_drafts', 'ceo_meeting_payments', 'community_registrations', 'consents', 'consumer_profiles', 'content_items', 'content_versions', 'conversations', 'delete_requests', 'deleted_account_payment_audits', 'devices', 'fund_admin_access_log', 'fund_investment_plans', 'fund_investor_notes', 'fund_investor_tags', 'fund_payment_notifications', 'fund_payment_reviews', 'fund_recurring_transfers', 'fund_stripe_events', 'fund_stripe_payment_requests', 'fund_stripe_payments', 'fund_stripe_subscriptions', 'fund_transfers', 'identity_verifications', 'investor_profiles', 'kirkland_agents', 'kyc_profiles', 'lead_events', 'lead_requests', 'messages', 'nda_signatures', 'notifications', 'onboarding_data', 'onboarding_invites', 'onboarding_parties', 'otp_codes', 'plaid_accounts', 'plaid_data_events', 'plaid_items', 'plaid_link_diagnostics', 'plaid_product_sync_statuses', 'plaid_statement_metadata', 'plaid_sync_cursors', 'plaid_transactions', 'plaid_transfer_accounts', 'plaid_transfer_events', 'site_analytics_events', 'site_analytics_sessions', 'swipe_actions', 'transfer_email_notifications', 'user_agent_selections', 'user_enriched_profiles', 'user_financial_data', 'user_product_usage', 'users', 'wa_classifications', 'wa_extractions', 'wa_groups', 'wa_jobs', 'wa_links', 'wa_media', 'wa_messages', 'wa_review_actions', 'wa_sender_identities', 'wa_senders')) AS indexes,
  (SELECT count(*)::bigint FROM pg_catalog.pg_sequences
    WHERE schemaname = 'public') AS sequences,
  (SELECT count(*)::bigint FROM pg_catalog.pg_trigger AS counted_trigger
    JOIN pg_catalog.pg_class AS counted_class ON counted_class.oid = counted_trigger.tgrelid
    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_class.relnamespace
    WHERE counted_ns.nspname = 'public' AND NOT counted_trigger.tgisinternal
      AND counted_class.relname IN ('agent_profiles', 'agent_reviews', 'analytics_events', 'app_config', 'blocked_agents', 'blog_drafts', 'ceo_meeting_payments', 'community_registrations', 'consents', 'consumer_profiles', 'content_items', 'content_versions', 'conversations', 'delete_requests', 'deleted_account_payment_audits', 'devices', 'fund_admin_access_log', 'fund_investment_plans', 'fund_investor_notes', 'fund_investor_tags', 'fund_payment_notifications', 'fund_payment_reviews', 'fund_recurring_transfers', 'fund_stripe_events', 'fund_stripe_payment_requests', 'fund_stripe_payments', 'fund_stripe_subscriptions', 'fund_transfers', 'identity_verifications', 'investor_profiles', 'kirkland_agents', 'kyc_profiles', 'lead_events', 'lead_requests', 'messages', 'nda_signatures', 'notifications', 'onboarding_data', 'onboarding_invites', 'onboarding_parties', 'otp_codes', 'plaid_accounts', 'plaid_data_events', 'plaid_items', 'plaid_link_diagnostics', 'plaid_product_sync_statuses', 'plaid_statement_metadata', 'plaid_sync_cursors', 'plaid_transactions', 'plaid_transfer_accounts', 'plaid_transfer_events', 'site_analytics_events', 'site_analytics_sessions', 'swipe_actions', 'transfer_email_notifications', 'user_agent_selections', 'user_enriched_profiles', 'user_financial_data', 'user_product_usage', 'users', 'wa_classifications', 'wa_extractions', 'wa_groups', 'wa_jobs', 'wa_links', 'wa_media', 'wa_messages', 'wa_review_actions', 'wa_sender_identities', 'wa_senders')) AS triggers,
  (SELECT count(*)::bigint FROM pg_catalog.pg_proc AS counted_proc
    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_proc.pronamespace
    WHERE counted_ns.nspname = 'public' AND counted_proc.prokind IN ('f', 'p', 'a')) AS public_function_signatures,
  (SELECT count(*)::bigint FROM pg_catalog.pg_proc AS counted_proc
    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_proc.pronamespace
    WHERE counted_ns.nspname = 'public' AND counted_proc.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
        WHERE extension_dependency.classid = 'pg_proc'::regclass
          AND extension_dependency.objid = counted_proc.oid
          AND extension_dependency.deptype = 'e')) AS custom_public_functions,
  (SELECT count(*)::bigint FROM pg_catalog.pg_proc AS counted_proc
    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_proc.pronamespace
    WHERE counted_ns.nspname = 'public' AND counted_proc.prokind IN ('f', 'p')
      AND pg_catalog.pg_get_function_result(counted_proc.oid) <> 'trigger'
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
        WHERE extension_dependency.classid = 'pg_proc'::regclass
          AND extension_dependency.objid = counted_proc.oid
          AND extension_dependency.deptype = 'e')) AS application_rpcs,
  (SELECT count(*)::bigint FROM pg_catalog.pg_proc AS counted_proc
    JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_proc.pronamespace
    WHERE counted_ns.nspname = 'public' AND counted_proc.prokind = 'f'
      AND pg_catalog.pg_get_function_result(counted_proc.oid) = 'trigger'
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend AS extension_dependency
        WHERE extension_dependency.classid = 'pg_proc'::regclass
          AND extension_dependency.objid = counted_proc.oid
          AND extension_dependency.deptype = 'e')) AS custom_trigger_functions,
  (SELECT count(*)::bigint FROM pg_catalog.pg_policies
    WHERE schemaname = 'public') AS public_policies,
  (SELECT count(*)::bigint FROM pg_catalog.pg_policies
    WHERE schemaname = 'storage') AS storage_policies,
  (SELECT count(*)::bigint FROM pg_catalog.pg_extension) AS extensions,
  ((SELECT count(*)::bigint FROM pg_catalog.pg_class AS counted_object
      JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_object.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(counted_object.relacl, pg_catalog.acldefault(
          CASE counted_object.relkind WHEN 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
          counted_object.relowner
        ))
      ) AS counted_acl
      WHERE counted_ns.nspname = 'public'
        AND ((counted_object.relkind IN ('r', 'p') AND counted_object.relname IN ('agent_profiles', 'agent_reviews', 'analytics_events', 'app_config', 'blocked_agents', 'blog_drafts', 'ceo_meeting_payments', 'community_registrations', 'consents', 'consumer_profiles', 'content_items', 'content_versions', 'conversations', 'delete_requests', 'deleted_account_payment_audits', 'devices', 'fund_admin_access_log', 'fund_investment_plans', 'fund_investor_notes', 'fund_investor_tags', 'fund_payment_notifications', 'fund_payment_reviews', 'fund_recurring_transfers', 'fund_stripe_events', 'fund_stripe_payment_requests', 'fund_stripe_payments', 'fund_stripe_subscriptions', 'fund_transfers', 'identity_verifications', 'investor_profiles', 'kirkland_agents', 'kyc_profiles', 'lead_events', 'lead_requests', 'messages', 'nda_signatures', 'notifications', 'onboarding_data', 'onboarding_invites', 'onboarding_parties', 'otp_codes', 'plaid_accounts', 'plaid_data_events', 'plaid_items', 'plaid_link_diagnostics', 'plaid_product_sync_statuses', 'plaid_statement_metadata', 'plaid_sync_cursors', 'plaid_transactions', 'plaid_transfer_accounts', 'plaid_transfer_events', 'site_analytics_events', 'site_analytics_sessions', 'swipe_actions', 'transfer_email_notifications', 'user_agent_selections', 'user_enriched_profiles', 'user_financial_data', 'user_product_usage', 'users', 'wa_classifications', 'wa_extractions', 'wa_groups', 'wa_jobs', 'wa_links', 'wa_media', 'wa_messages', 'wa_review_actions', 'wa_sender_identities', 'wa_senders')) OR counted_object.relkind = 'S')) +
   (SELECT count(*)::bigint FROM pg_catalog.pg_proc AS counted_routine
      JOIN pg_catalog.pg_namespace AS counted_ns ON counted_ns.oid = counted_routine.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(counted_routine.proacl, pg_catalog.acldefault('f'::"char", counted_routine.proowner))
      ) AS counted_acl
      WHERE counted_ns.nspname = 'public' AND counted_routine.prokind IN ('f', 'p', 'a'))) AS grants,
  (SELECT count(*)::bigint FROM auth.users) AS auth_users;
ROLLBACK;
