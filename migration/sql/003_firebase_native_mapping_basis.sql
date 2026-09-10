-- Prepare the enum in a separate committed migration before using its value.
-- UAT only. Apply through a reviewed database change, never from web runtime.
BEGIN;
DO $preflight$
BEGIN
  IF current_database() <> 'hushh_tech_app' OR current_user <> 'postgres'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hushh-tech-web-uat@hushh-tech-uat.iam')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='hushh_tech_schema_owner'))
  THEN RAISE EXCEPTION 'IDENTITY_MIGRATION_TARGET_INVALID'; END IF;
END
$preflight$;
GRANT hushh_tech_schema_owner TO postgres;
SET LOCAL ROLE hushh_tech_schema_owner;
ALTER TYPE hushh_identity.identity_mapping_basis ADD VALUE IF NOT EXISTS 'FIREBASE_NATIVE';
RESET ROLE;
REVOKE hushh_tech_schema_owner FROM postgres;
COMMIT;
