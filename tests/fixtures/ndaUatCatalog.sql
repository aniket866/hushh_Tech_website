-- Synthetic, catalog-shaped fixture only. Never run against a deployed DB.
-- The canonical 001 foundation is loaded first in a disposable local cluster.
CREATE ROLE hushh_tech_schema_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hushh_tech_runtime NOLOGIN;
CREATE ROLE "hushh-tech-web-uat@hushh-tech-uat.iam" LOGIN;
GRANT hushh_tech_runtime TO "hushh-tech-web-uat@hushh-tech-uat.iam";
ALTER SCHEMA public OWNER TO hushh_tech_schema_owner;
ALTER SCHEMA hushh_identity OWNER TO hushh_tech_schema_owner;
ALTER SCHEMA hushh_migration OWNER TO hushh_tech_schema_owner;
ALTER TYPE hushh_identity.identity_mapping_basis OWNER TO hushh_tech_schema_owner;
ALTER TABLE hushh_identity.identity_links OWNER TO hushh_tech_schema_owner;
ALTER TABLE hushh_migration.identity_migration_dispositions OWNER TO hushh_tech_schema_owner;
CREATE FUNCTION hushh_identity.current_firebase_uid() RETURNS text LANGUAGE sql STABLE
  SET search_path=pg_catalog AS $$ SELECT NULLIF(current_setting('app.firebase_uid',true),'') $$;
CREATE FUNCTION hushh_identity.current_legacy_user_uuid() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path=pg_catalog,public,hushh_identity,pg_temp AS $$
  SELECT legacy_user_uuid FROM hushh_identity.identity_links
  WHERE firebase_uid=hushh_identity.current_firebase_uid() AND status='ACTIVE' AND legacy_project='ibsisfnjxeowvdtvgzff' LIMIT 1 $$;
ALTER FUNCTION hushh_identity.current_firebase_uid() OWNER TO hushh_tech_schema_owner;
ALTER FUNCTION hushh_identity.current_legacy_user_uuid() OWNER TO hushh_tech_schema_owner;
REVOKE ALL ON FUNCTION hushh_identity.current_firebase_uid(),hushh_identity.current_legacy_user_uuid() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hushh_identity.current_firebase_uid(),hushh_identity.current_legacy_user_uuid() TO hushh_tech_runtime;
CREATE POLICY identity_links_owner_active_lookup ON hushh_identity.identity_links FOR SELECT TO hushh_tech_schema_owner
  USING (status='ACTIVE' AND legacy_project='ibsisfnjxeowvdtvgzff' AND firebase_uid=hushh_identity.current_firebase_uid());
CREATE TABLE public.users (
  id uuid PRIMARY KEY REFERENCES hushh_identity.identity_links(legacy_user_uuid) ON DELETE CASCADE,
  email text,phone text,full_name text,avatar_url text,zip_code text,onboarding_step text DEFAULT 'landing',
  house_rules_accepted_at timestamptz,metadata jsonb DEFAULT '{}',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.nda_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL UNIQUE,signer_name text NOT NULL,signer_email text,
  signer_ip text DEFAULT 'unknown',nda_version text DEFAULT 'v1.0',pdf_url text,signed_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),documents_acknowledged jsonb NOT NULL DEFAULT '[]',
  consent_version text,signer_user_agent text,signature_id text
);
ALTER TABLE public.users OWNER TO hushh_tech_schema_owner;
ALTER TABLE public.nda_signatures OWNER TO hushh_tech_schema_owner;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
ALTER TABLE public.nda_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nda_signatures FORCE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public,hushh_identity TO hushh_tech_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.users,public.nda_signatures TO hushh_tech_runtime;
CREATE POLICY users_runtime_select ON public.users FOR SELECT TO hushh_tech_runtime USING (id=hushh_identity.current_legacy_user_uuid());
CREATE POLICY users_runtime_insert ON public.users FOR INSERT TO hushh_tech_runtime WITH CHECK (id=hushh_identity.current_legacy_user_uuid());
CREATE POLICY users_runtime_update ON public.users FOR UPDATE TO hushh_tech_runtime USING (id=hushh_identity.current_legacy_user_uuid()) WITH CHECK(id=hushh_identity.current_legacy_user_uuid());
CREATE POLICY nda_signatures_runtime_select ON public.nda_signatures FOR SELECT TO hushh_tech_runtime USING (user_id=hushh_identity.current_legacy_user_uuid());
CREATE POLICY nda_signatures_runtime_insert ON public.nda_signatures FOR INSERT TO hushh_tech_runtime WITH CHECK (user_id=hushh_identity.current_legacy_user_uuid());
CREATE POLICY nda_signatures_runtime_update ON public.nda_signatures FOR UPDATE TO hushh_tech_runtime USING (user_id=hushh_identity.current_legacy_user_uuid()) WITH CHECK(user_id=hushh_identity.current_legacy_user_uuid());
