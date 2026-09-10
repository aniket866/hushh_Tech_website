-- Verified UAT catalog: PostgreSQL 17; no historical migrations are replayed.
-- Creation is OFF until a governed complete provider/recovery snapshot is
-- verified. No user records, fabricated links, or live provider hashes here.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $preflight$
BEGIN
  IF current_database() <> 'hushh_tech_app' OR current_user <> 'postgres'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hushh-tech-web-uat@hushh-tech-uat.iam')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hushh_tech_identity_provisioner')
     OR pg_catalog.to_regclass('hushh_identity.runtime_admission') IS NOT NULL
  THEN RAISE EXCEPTION 'IDENTITY_MIGRATION_TARGET_OR_REPLAY_INVALID'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class
      WHERE oid IN ('hushh_identity.identity_links'::regclass,'public.users'::regclass,'public.nda_signatures'::regclass)
        AND relrowsecurity AND relforcerowsecurity
        AND relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='hushh_tech_schema_owner')) <> 3
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='hushh_tech_schema_owner'
                AND (rolcanlogin OR rolinherit OR rolsuper OR rolbypassrls OR rolcreaterole))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='hushh_tech_schema_owner'))
  THEN RAISE EXCEPTION 'IDENTITY_OWNERSHIP_BOUNDARY_INVALID'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_attribute
      WHERE attrelid='public.nda_signatures'::regclass AND NOT attisdropped AND
        ((attname='user_id' AND atttypid='uuid'::regtype AND attnotnull)
        OR (attname='documents_acknowledged' AND atttypid='jsonb'::regtype AND attnotnull)
        OR (attname IN ('signer_name','signer_email','signer_ip','nda_version','pdf_url','consent_version','signer_user_agent','signature_id') AND atttypid='text'::regtype)
        OR (attname IN ('signed_at','updated_at') AND atttypid='timestamptz'::regtype))) <> 12
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
        WHERE c.conrelid='public.nda_signatures'::regclass AND c.contype='u'
          AND c.conkey=ARRAY[(SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='user_id')]::smallint[])
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid='public.users'::regclass AND contype='f' AND confrelid='hushh_identity.identity_links'::regclass)
  THEN RAISE EXCEPTION 'NDA_CATALOG_DRIFT'; END IF;
END
$preflight$;

CREATE ROLE hushh_tech_identity_provisioner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT hushh_tech_schema_owner TO postgres;
SET LOCAL ROLE hushh_tech_schema_owner;

ALTER TABLE hushh_identity.identity_links ADD COLUMN firebase_project text;
ALTER TABLE hushh_identity.identity_links ALTER COLUMN legacy_project DROP NOT NULL;
ALTER TABLE hushh_identity.identity_links DROP CONSTRAINT identity_links_check1;
ALTER TABLE hushh_identity.identity_links ADD CONSTRAINT identity_links_mapping_origin_check CHECK (
  (mapping_basis = 'FIREBASE_NATIVE' AND legacy_project IS NULL AND firebase_project = 'hushh-tech-uat'
    AND provider_id IS NOT NULL AND status IN ('ACTIVE','REVOKED')
    AND firebase_project IS NOT NULL
    AND provenance->>'origin' IS NOT DISTINCT FROM 'FIREBASE_NATIVE'
    AND provenance->>'firebaseProject' IS NOT DISTINCT FROM 'hushh-tech-uat')
  OR
  (mapping_basis <> 'FIREBASE_NATIVE' AND legacy_project IS NOT NULL AND firebase_project IS NULL
    AND ((mapping_basis='PROVIDER_SUBJECT' AND provider_id IS NOT NULL)
      OR (mapping_basis IN ('LEGACY_UUID','UNCLAIMED') AND provider_id IS NULL)))
);
-- Keep identity_links_legacy_project_check: a non-null legacy project can
-- still only be the original source. Never relabel or backfill existing rows.
CREATE UNIQUE INDEX identity_links_active_uid_all_origins_uidx
  ON hushh_identity.identity_links(firebase_uid) WHERE status='ACTIVE';

CREATE TABLE hushh_identity.runtime_admission (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  firebase_project text NOT NULL CHECK (firebase_project='hushh-tech-uat'),
  creation_enabled boolean NOT NULL DEFAULT false,
  evidence_complete boolean NOT NULL DEFAULT false,
  new_accounts_after timestamptz,
  evidence_reference text,
  fingerprint_scheme text NOT NULL CHECK (fingerprint_scheme='sha256-provider-nul-subject-nfc-v1'),
  CHECK (NOT evidence_complete OR (new_accounts_after IS NOT NULL AND evidence_reference IS NOT NULL AND length(evidence_reference)>0))
);
INSERT INTO hushh_identity.runtime_admission(firebase_project,fingerprint_scheme)
  VALUES ('hushh-tech-uat','sha256-provider-nul-subject-nfc-v1');

-- One principal can own more than one provider. This closes the verified
-- secondary-provider gap without changing the canonical principal/FK table.
-- Retain denied ownership as tombstones. Never match or store email here.
CREATE TABLE hushh_identity.provider_ownership (
  provider_id text NOT NULL CHECK (provider_id IN ('google.com','apple.com')),
  subject_hash bytea NOT NULL CHECK (octet_length(subject_hash)=32),
  application_user_id uuid REFERENCES hushh_identity.identity_links(legacy_user_uuid),
  disposition text NOT NULL CHECK (disposition IN ('OWNED','DENIED','REVIEW_REQUIRED')),
  evidence_reference text NOT NULL CHECK (length(evidence_reference)>0),
  PRIMARY KEY(provider_id,subject_hash),
  CHECK (disposition <> 'OWNED' OR application_user_id IS NOT NULL)
);
ALTER TABLE hushh_identity.runtime_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE hushh_identity.runtime_admission FORCE ROW LEVEL SECURITY;
ALTER TABLE hushh_identity.provider_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE hushh_identity.provider_ownership FORCE ROW LEVEL SECURITY;

CREATE POLICY runtime_admission_owner ON hushh_identity.runtime_admission TO hushh_tech_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY runtime_admission_provisioner ON hushh_identity.runtime_admission FOR SELECT TO hushh_tech_identity_provisioner USING (true);
CREATE POLICY provider_ownership_owner ON hushh_identity.provider_ownership TO hushh_tech_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY provider_ownership_provisioner_read ON hushh_identity.provider_ownership FOR SELECT TO hushh_tech_identity_provisioner USING (true);
CREATE POLICY provider_ownership_provisioner_insert ON hushh_identity.provider_ownership FOR INSERT TO hushh_tech_identity_provisioner
  WITH CHECK (disposition='OWNED' AND application_user_id=hushh_identity.current_legacy_user_uuid());
CREATE POLICY identity_links_provisioner_read ON hushh_identity.identity_links FOR SELECT TO hushh_tech_identity_provisioner USING (true);
CREATE POLICY identity_links_provisioner_insert ON hushh_identity.identity_links FOR INSERT TO hushh_tech_identity_provisioner
  WITH CHECK (mapping_basis='FIREBASE_NATIVE' AND status='ACTIVE' AND legacy_project IS NULL
    AND firebase_project='hushh-tech-uat' AND firebase_uid=NULLIF(current_setting('app.firebase_uid',true),'')
    AND current_setting('app.firebase_project',true)='hushh-tech-uat');
CREATE POLICY users_provisioner_insert ON public.users FOR INSERT TO hushh_tech_identity_provisioner
  WITH CHECK (id=hushh_identity.current_legacy_user_uuid());

ALTER POLICY identity_links_owner_active_lookup ON hushh_identity.identity_links
  USING (status='ACTIVE' AND firebase_uid=NULLIF(current_setting('app.firebase_uid',true),'')
    AND (legacy_project='ibsisfnjxeowvdtvgzff' OR (mapping_basis='FIREBASE_NATIVE' AND firebase_project='hushh-tech-uat')));

CREATE OR REPLACE FUNCTION hushh_identity.current_legacy_user_uuid()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog, public, hushh_identity, pg_temp
AS $resolver$
  SELECT legacy_user_uuid FROM hushh_identity.identity_links
  WHERE firebase_uid=hushh_identity.current_firebase_uid() AND status='ACTIVE'
    AND (legacy_project='ibsisfnjxeowvdtvgzff' OR (mapping_basis='FIREBASE_NATIVE' AND firebase_project='hushh-tech-uat'))
$resolver$;
REVOKE ALL ON FUNCTION hushh_identity.current_legacy_user_uuid() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hushh_identity.current_legacy_user_uuid(), hushh_identity.current_firebase_uid() TO hushh_tech_identity_provisioner;
GRANT USAGE ON SCHEMA hushh_identity,hushh_migration,public TO hushh_tech_identity_provisioner;
GRANT SELECT,INSERT ON hushh_identity.identity_links TO hushh_tech_identity_provisioner;
GRANT SELECT ON hushh_identity.runtime_admission TO hushh_tech_identity_provisioner;
GRANT SELECT,INSERT ON hushh_identity.provider_ownership TO hushh_tech_identity_provisioner;
GRANT INSERT (id) ON public.users TO hushh_tech_identity_provisioner;
GRANT SELECT (legacy_user_uuid,provider_evidence_count) ON hushh_migration.identity_migration_dispositions TO hushh_tech_identity_provisioner;
CREATE POLICY identity_dispositions_provisioner_read ON hushh_migration.identity_migration_dispositions
  FOR SELECT TO hushh_tech_identity_provisioner USING (true);

-- Create under the restricted final owner; never rely on the administrator
-- inheriting the sealed schema owner's privileges (Cloud SQL is not superuser).
GRANT CREATE ON SCHEMA hushh_identity TO hushh_tech_identity_provisioner;
RESET ROLE;
GRANT hushh_tech_identity_provisioner TO postgres;
SET LOCAL ROLE hushh_tech_identity_provisioner;
CREATE FUNCTION hushh_identity.ensure_current_application_principal(p_evidence jsonb)
RETURNS TABLE(application_user_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, hushh_identity, pg_temp
AS $provision$
DECLARE
  uid text := NULLIF(current_setting('app.firebase_uid',true),'');
  existing hushh_identity.identity_links%ROWTYPE;
  admission hushh_identity.runtime_admission%ROWTYPE;
  principal uuid;
  provider jsonb;
  first_provider jsonb;
  account_created timestamptz;
BEGIN
  IF uid IS NULL OR length(uid)>128 OR current_setting('app.firebase_project',true) IS DISTINCT FROM 'hushh-tech-uat'
  THEN RAISE EXCEPTION 'IDENTITY_DENIED'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('identity:'||uid,0));
  IF (SELECT count(*) FROM hushh_identity.identity_links WHERE firebase_uid=uid)>1
  THEN RAISE EXCEPTION 'IDENTITY_REVIEW_REQUIRED'; END IF;
  SELECT * INTO existing FROM hushh_identity.identity_links WHERE firebase_uid=uid;
  IF FOUND THEN
    IF existing.status<>'ACTIVE' THEN RAISE EXCEPTION 'IDENTITY_DENIED'; END IF;
    IF existing.mapping_basis='FIREBASE_NATIVE' AND existing.provenance->>'firebaseCreatedAt' IS DISTINCT FROM p_evidence->>'createdAt'
    THEN RAISE EXCEPTION 'IDENTITY_REVIEW_REQUIRED'; END IF;
    RETURN QUERY SELECT existing.legacy_user_uuid,false;
    RETURN;
  END IF;
  SELECT * INTO admission FROM hushh_identity.runtime_admission WHERE singleton;
  IF NOT FOUND OR NOT admission.creation_enabled THEN RAISE EXCEPTION 'IDENTITY_CREATION_DISABLED'; END IF;
  IF NOT admission.evidence_complete OR admission.new_accounts_after IS NULL
     OR admission.evidence_reference IS NULL OR admission.fingerprint_scheme IS DISTINCT FROM p_evidence->>'fingerprintScheme'
  THEN RAISE EXCEPTION 'IDENTITY_EVIDENCE_UNAVAILABLE'; END IF;
  IF jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' OR jsonb_typeof(p_evidence->'providers') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_evidence->'providers') NOT BETWEEN 1 AND 2
  THEN RAISE EXCEPTION 'IDENTITY_REVIEW_REQUIRED'; END IF;
  BEGIN account_created := (p_evidence->>'createdAt')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'IDENTITY_REVIEW_REQUIRED'; END;
  IF account_created IS NULL OR account_created<=admission.new_accounts_after OR account_created>clock_timestamp()
  THEN RAISE EXCEPTION 'IDENTITY_REVIEW_REQUIRED'; END IF;
  IF (SELECT count(DISTINCT value->>'providerId') FROM jsonb_array_elements(p_evidence->'providers'))<>jsonb_array_length(p_evidence->'providers')
  THEN RAISE EXCEPTION 'IDENTITY_REVIEW_REQUIRED'; END IF;
  -- A ready flag alone is insufficient: require coverage for every retained
  -- migration disposition (the live UAT snapshot includes a two-provider user).
  IF EXISTS (
    SELECT 1 FROM hushh_migration.identity_migration_dispositions d
    WHERE d.provider_evidence_count<>(SELECT count(*) FROM hushh_identity.provider_ownership o WHERE o.application_user_id=d.legacy_user_uuid)
  ) OR EXISTS (
    SELECT 1 FROM hushh_identity.identity_links l WHERE l.mapping_basis<>'FIREBASE_NATIVE' AND
      (l.status='UNCLAIMED_LEGACY_PRINCIPAL' OR
       (l.provider_subject_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hushh_identity.provider_ownership o
          WHERE o.application_user_id=l.legacy_user_uuid AND o.provider_id=l.provider_id AND o.subject_hash=l.provider_subject_hash)))
  ) THEN RAISE EXCEPTION 'IDENTITY_EVIDENCE_UNAVAILABLE'; END IF;
  FOR provider IN SELECT value FROM jsonb_array_elements(p_evidence->'providers') ORDER BY value->>'providerId',value->>'fingerprint'
  LOOP
    IF provider->>'providerId' NOT IN ('google.com','apple.com') OR provider->>'fingerprint' IS NULL
       OR provider->>'providerId' IS NULL OR (provider->>'fingerprint') !~ '^[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'IDENTITY_REVIEW_REQUIRED'; END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('provider:'||(provider->>'providerId')||':'||(provider->>'fingerprint'),0));
    IF EXISTS (SELECT 1 FROM hushh_identity.provider_ownership o WHERE o.provider_id=provider->>'providerId' AND o.subject_hash=decode(provider->>'fingerprint','hex'))
       OR EXISTS (SELECT 1 FROM hushh_identity.identity_links l WHERE l.provider_id=provider->>'providerId' AND l.provider_subject_hash=decode(provider->>'fingerprint','hex'))
    THEN RAISE EXCEPTION 'IDENTITY_REVIEW_REQUIRED'; END IF;
    IF first_provider IS NULL THEN first_provider:=provider; END IF;
  END LOOP;
  principal:=gen_random_uuid();
  INSERT INTO hushh_identity.identity_links(legacy_project,legacy_user_uuid,firebase_uid,firebase_project,provider_id,provider_subject_hash,mapping_basis,status,provenance)
  VALUES (NULL,principal,uid,'hushh-tech-uat',first_provider->>'providerId',decode(first_provider->>'fingerprint','hex'),'FIREBASE_NATIVE','ACTIVE',
    jsonb_build_object('origin','FIREBASE_NATIVE','firebaseProject','hushh-tech-uat','firebaseCreatedAt',p_evidence->>'createdAt',
      'fingerprintScheme',admission.fingerprint_scheme,'admissionEvidence',admission.evidence_reference,'provisionedAt',clock_timestamp()));
  INSERT INTO public.users(id) VALUES (principal);
  FOR provider IN SELECT value FROM jsonb_array_elements(p_evidence->'providers') LOOP
    INSERT INTO hushh_identity.provider_ownership(provider_id,subject_hash,application_user_id,disposition,evidence_reference)
      VALUES (provider->>'providerId',decode(provider->>'fingerprint','hex'),principal,'OWNED','FIREBASE_NATIVE');
  END LOOP;
  RETURN QUERY SELECT principal,true;
END
$provision$;
REVOKE ALL ON FUNCTION hushh_identity.ensure_current_application_principal(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hushh_identity.ensure_current_application_principal(jsonb) TO "hushh-tech-web-uat@hushh-tech-uat.iam";
RESET ROLE;
SET LOCAL ROLE hushh_tech_schema_owner;
REVOKE CREATE ON SCHEMA hushh_identity FROM hushh_tech_identity_provisioner;
RESET ROLE;
REVOKE hushh_tech_identity_provisioner FROM postgres;
REVOKE hushh_tech_schema_owner FROM postgres;
DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid IN
      (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN ('hushh_tech_schema_owner','hushh_tech_identity_provisioner')))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE p.oid='hushh_identity.ensure_current_application_principal(jsonb)'::regprocedure
          AND a.grantee NOT IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN ('hushh_tech_identity_provisioner','hushh-tech-web-uat@hushh-tech-uat.iam')))
     OR has_table_privilege('hushh-tech-web-uat@hushh-tech-uat.iam','hushh_identity.identity_links','INSERT')
     OR has_table_privilege('hushh_tech_identity_provisioner','hushh_identity.identity_links','UPDATE')
     OR has_schema_privilege('hushh_tech_identity_provisioner','hushh_identity','CREATE')
  THEN RAISE EXCEPTION 'IDENTITY_PROVISIONER_NOT_SEALED'; END IF;
END
$verify$;
COMMIT;
