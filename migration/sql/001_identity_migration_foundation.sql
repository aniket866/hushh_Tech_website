BEGIN;

DO $migration_boundary$
BEGIN
  IF current_database() <> 'hushh_tech_app' THEN
    RAISE EXCEPTION 'refusing identity migration on unexpected database';
  END IF;
  IF current_setting('server_version_num')::integer < 170000
     OR current_setting('server_version_num')::integer >= 180000 THEN
    RAISE EXCEPTION 'identity migration requires PostgreSQL 17';
  END IF;
END
$migration_boundary$;

-- A governed executor must own this extension step. The sealed schema owner is
-- NOLOGIN, and the runtime role is
-- DML-only. No operational role may retain extension-management rights.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $pgcrypto_precondition$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pgcrypto'
  ) THEN
    RAISE EXCEPTION 'identity migration requires the governed pgcrypto extension';
  END IF;
END
$pgcrypto_precondition$;

CREATE SCHEMA IF NOT EXISTS hushh_identity;
CREATE SCHEMA IF NOT EXISTS hushh_migration;

DO $identity_link_status$
BEGIN
  CREATE TYPE hushh_identity.identity_link_status AS ENUM (
    'ACTIVE',
    'REVOKED',
    'UNCLAIMED_LEGACY_PRINCIPAL'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$identity_link_status$;

DO $identity_mapping_basis$
BEGIN
  CREATE TYPE hushh_identity.identity_mapping_basis AS ENUM (
    'PROVIDER_SUBJECT',
    'LEGACY_UUID',
    'UNCLAIMED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$identity_mapping_basis$;

DO $identity_terminal_disposition$
BEGIN
  CREATE TYPE hushh_migration.identity_terminal_disposition AS ENUM (
    'LINKED_EXISTING_FIREBASE',
    'IMPORTED_FIREBASE',
    'MANUAL_RECOVERY',
    'LEGALLY_RETAINED_NO_LOGIN',
    'INTENTIONALLY_DELETED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$identity_terminal_disposition$;

CREATE TABLE IF NOT EXISTS hushh_identity.identity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_project text NOT NULL,
  legacy_user_uuid uuid NOT NULL,
  firebase_uid text,
  provider_id text,
  provider_subject_hash bytea,
  mapping_basis hushh_identity.identity_mapping_basis NOT NULL,
  status hushh_identity.identity_link_status NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (legacy_project = 'ibsisfnjxeowvdtvgzff'),
  CHECK (firebase_uid IS NULL OR length(firebase_uid) BETWEEN 1 AND 128),
  CHECK (provider_subject_hash IS NULL OR octet_length(provider_subject_hash) = 32),
  CHECK ((provider_id IS NULL) = (provider_subject_hash IS NULL)),
  CHECK (provider_id IS NULL OR provider_id = lower(provider_id)),
  CHECK (provider_id IS NULL OR lower(provider_id) NOT IN ('email', 'password', 'email_link')),
  CHECK (
    (mapping_basis = 'PROVIDER_SUBJECT' AND provider_id IS NOT NULL)
    OR (mapping_basis = 'LEGACY_UUID' AND provider_id IS NULL)
    OR (mapping_basis = 'UNCLAIMED' AND provider_id IS NULL)
  ),
  CHECK (
    (status = 'UNCLAIMED_LEGACY_PRINCIPAL' AND firebase_uid IS NULL AND mapping_basis = 'UNCLAIMED')
    OR (status <> 'UNCLAIMED_LEGACY_PRINCIPAL' AND firebase_uid IS NOT NULL AND mapping_basis <> 'UNCLAIMED')
  ),
  CHECK (
    (status = 'REVOKED' AND revoked_at IS NOT NULL)
    OR (status <> 'REVOKED' AND revoked_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS identity_links_active_legacy_uidx
  ON hushh_identity.identity_links (legacy_project, legacy_user_uuid)
  WHERE status = 'ACTIVE';

-- Hushh Tech has one locked legacy source project. This global key is the
-- target home for every former source-identity foreign key, including the 65
-- principals that remain unclaimed and denied.
CREATE UNIQUE INDEX IF NOT EXISTS identity_links_legacy_principal_uidx
  ON hushh_identity.identity_links (legacy_user_uuid);

CREATE UNIQUE INDEX IF NOT EXISTS identity_links_active_firebase_uidx
  ON hushh_identity.identity_links (legacy_project, firebase_uid)
  WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS identity_links_active_provider_uidx
  ON hushh_identity.identity_links (legacy_project, provider_id, provider_subject_hash)
  WHERE status = 'ACTIVE' AND provider_subject_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS identity_links_unclaimed_legacy_uidx
  ON hushh_identity.identity_links (legacy_project, legacy_user_uuid)
  WHERE status = 'UNCLAIMED_LEGACY_PRINCIPAL';

ALTER TABLE hushh_identity.identity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE hushh_identity.identity_links FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS hushh_migration.migration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  replay_key bytea NOT NULL UNIQUE CHECK (octet_length(replay_key) = 32),
  source_inventory_hash bytea NOT NULL CHECK (octet_length(source_inventory_hash) = 32),
  mapping_input_hash bytea NOT NULL CHECK (octet_length(mapping_input_hash) = 32),
  source_project_ref text NOT NULL CHECK (source_project_ref = 'ibsisfnjxeowvdtvgzff'),
  source_database text NOT NULL CHECK (source_database = 'postgres'),
  target_environment text NOT NULL CHECK (target_environment IN ('uat', 'production')),
  target_project text NOT NULL,
  target_region text NOT NULL CHECK (target_region = 'us-central1'),
  target_instance text NOT NULL,
  target_database text NOT NULL CHECK (target_database = 'hushh_tech_app'),
  mode text NOT NULL DEFAULT 'DRY_RUN' CHECK (mode IN ('DRY_RUN', 'APPLY')),
  status text NOT NULL DEFAULT 'PLANNED' CHECK (
    status IN ('PLANNED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ABORTED')
  ),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (target_environment = 'uat'
      AND target_project = 'hushh-tech-uat'
      AND target_instance = 'hushh-tech-app-pg-uat')
    OR
    (target_environment = 'production'
      AND target_project = 'hushh-tech-prod'
      AND target_instance = 'hushh-tech-app-pg-prod')
  )
);

CREATE TABLE IF NOT EXISTS hushh_migration.identity_migration_dispositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_run_id uuid NOT NULL REFERENCES hushh_migration.migration_runs(id),
  legacy_project text NOT NULL CHECK (legacy_project = 'ibsisfnjxeowvdtvgzff'),
  legacy_user_uuid uuid NOT NULL,
  firebase_uid text,
  terminal_disposition hushh_migration.identity_terminal_disposition NOT NULL,
  mapping_basis text NOT NULL CHECK (
    mapping_basis IN ('PROVIDER_SUBJECT', 'LEGACY_UUID', 'PROVIDER_SUBJECT_CONFLICT')
  ),
  provider_evidence_count integer NOT NULL DEFAULT 0 CHECK (provider_evidence_count >= 0),
  email_was_used boolean NOT NULL DEFAULT false CHECK (email_was_used = false),
  access_allowed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (migration_run_id, legacy_project, legacy_user_uuid),
  CHECK (
    (
      terminal_disposition IN ('LINKED_EXISTING_FIREBASE', 'IMPORTED_FIREBASE')
      AND firebase_uid IS NOT NULL
      AND access_allowed = true
    )
    OR
    (
      terminal_disposition IN (
        'MANUAL_RECOVERY',
        'LEGALLY_RETAINED_NO_LOGIN',
        'INTENTIONALLY_DELETED'
      )
      AND firebase_uid IS NULL
      AND access_allowed = false
    )
  ),
  CHECK (
    terminal_disposition <> 'LINKED_EXISTING_FIREBASE'
    OR (mapping_basis = 'PROVIDER_SUBJECT' AND provider_evidence_count > 0)
  )
);

CREATE TABLE IF NOT EXISTS hushh_migration.migration_checkpoints (
  migration_run_id uuid NOT NULL REFERENCES hushh_migration.migration_runs(id),
  stream text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  cursor jsonb NOT NULL,
  row_count bigint NOT NULL CHECK (row_count >= 0),
  batch_hash bytea NOT NULL CHECK (octet_length(batch_hash) = 32),
  previous_checkpoint_hash bytea CHECK (
    previous_checkpoint_hash IS NULL OR octet_length(previous_checkpoint_hash) = 32
  ),
  checkpoint_hash bytea NOT NULL CHECK (octet_length(checkpoint_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (migration_run_id, stream, sequence),
  UNIQUE (checkpoint_hash)
);

CREATE TABLE IF NOT EXISTS hushh_migration.migration_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  migration_run_id uuid REFERENCES hushh_migration.migration_runs(id),
  event_type text NOT NULL,
  actor text NOT NULL,
  event_hash bytea NOT NULL CHECK (octet_length(event_hash) = 32),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hushh_migration.migration_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_run_id uuid NOT NULL REFERENCES hushh_migration.migration_runs(id),
  provider_event_id text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  UNIQUE (provider_event_id)
);

CREATE OR REPLACE FUNCTION hushh_migration.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $reject_audit_mutation$
BEGIN
  RAISE EXCEPTION 'migration audit events are append-only';
END
$reject_audit_mutation$;

DROP TRIGGER IF EXISTS migration_audit_events_append_only
  ON hushh_migration.migration_audit_events;
CREATE TRIGGER migration_audit_events_append_only
  BEFORE UPDATE OR DELETE ON hushh_migration.migration_audit_events
  FOR EACH ROW EXECUTE FUNCTION hushh_migration.reject_audit_mutation();

ALTER TABLE hushh_migration.migration_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hushh_migration.migration_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE hushh_migration.identity_migration_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hushh_migration.identity_migration_dispositions FORCE ROW LEVEL SECURITY;
ALTER TABLE hushh_migration.migration_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE hushh_migration.migration_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE hushh_migration.migration_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hushh_migration.migration_audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE hushh_migration.migration_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE hushh_migration.migration_outbox FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE hushh_identity.identity_links IS
  'Canonical Firebase UID ownership with legacy Supabase UUID provenance; email is never a key.';
COMMENT ON COLUMN hushh_identity.identity_links.provider_subject_hash IS
  'Keyed HMAC-SHA-256 of provider ID and immutable subject; key material stays in Secret Manager.';
COMMENT ON TABLE hushh_migration.migration_audit_events IS
  'Append-only migration evidence. UPDATE and DELETE are rejected by trigger.';
COMMENT ON TABLE hushh_migration.identity_migration_dispositions IS
  'Terminal 369-user Firebase migration outcomes; email-only mapping is structurally denied.';
COMMENT ON TABLE hushh_migration.migration_outbox IS
  'Idempotent side effects and reversible cutover deltas keyed by provider event ID.';

COMMIT;
