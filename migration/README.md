# GCP data and identity migration foundation

This directory is the plan-only foundation for issue #1950. It does not open a
network connection, query Supabase, write Cloud SQL, import Firebase users, or
execute change-data-capture statements.

## Locked boundary

| Stage | GCP project | Region | Cloud SQL instance | Database | PostgreSQL |
| --- | --- | --- | --- | --- | --- |
| UAT | `hushh-tech-uat` | `us-central1` | `hushh-tech-app-pg-uat` | `hushh_tech_app` | 17 |
| Production | `hushh-tech-prod` | `us-central1` | `hushh-tech-app-pg-prod` | `hushh_tech_app` | 17 |

The only accepted source is project ref `ibsisfnjxeowvdtvgzff`, database
`postgres`. The checked-in contract names all 70 public tables and requires 369
Auth identities. The repository contains 203 `CREATE POLICY` declarations. The
frozen sanitized live catalog contains 118 public policies, 10 storage policies,
and 142 public function signatures. Of those functions, 24 are custom: 16 are
callable remote procedure call (RPC) contracts and eight return `trigger`. A
missing, additional, or duplicate required record fails closed.

The frozen row baseline is 44,811. Each later source capture records an
`observedDelta` that is bound into the canonical inventory hash; validation
requires the 70 table counts to reconcile to
`44,811 + observedDelta`. This records legitimate source changes instead of
pretending the still-live baseline never moves.

The allowlist is bound to
`migration/manifests/supabase-retirement.v1.json` by the manifest's
`sha256_sorted_newline_v1` digest. That manifest lands through its own governed
PR; either list changing without the matching reviewed digest stops this
tooling at load time.

## Plan generation

Generate the UAT inventory and `pgoutput` plan:

```bash
npm run --silent gcp:migration:plan -- \
  --environment=uat \
  --source-project-ref=ibsisfnjxeowvdtvgzff \
  --source-database=postgres \
  --target-project=hushh-tech-uat \
  --target-region=us-central1 \
  --target-instance=hushh-tech-app-pg-uat \
  --target-database=hushh_tech_app \
  --postgres-major=17 \
  --dry-run
```

For production planning, change only the environment, target project, and target
instance to `production`, `hushh-tech-prod`, and
`hushh-tech-app-pg-prod`. Any mixed UAT/production target is rejected.

The output includes SQL text for a scoped 70-table publication, a precreated
`pgoutput` slot, and a disabled target subscription template with
`copy_data=true`, `create_slot=false`, and the named slot. The package contains
no SQL executor. `--execute`, `--apply`, and `--dry-run=false` are rejected.

The source connection must be direct. Supabase is IPv6 by default, so a
temporary IPv4 add-on may be required for the migration window. Cloud SQL stays
zonal while it is a subscriber; the plan disables and drops the subscription
and source slot before the instance becomes regional high availability and
private-only. See the official
[Supabase external replication guide](https://supabase.com/docs/guides/database/postgres/setup-replication-external)
and [Cloud SQL logical replication guide](https://docs.cloud.google.com/sql/docs/postgres/replication/configure-logical-replication).

A private-only Cloud SQL instance with no stable outgoing address remains
`BLOCKED_PRECONDITION`. Caller-supplied flags and a shaped artifact hash are
recorded only as untrusted claims. This plan-only package always withholds the
subscription-enable SQL and reports `LIVE_ATTESTATION_EXECUTOR_REQUIRED`; a
later governed executor must verify the live state before it may enable CDC:

```bash
npm run --silent gcp:migration:plan -- \
  --environment=uat \
  --source-project-ref=ibsisfnjxeowvdtvgzff \
  --source-database=postgres \
  --target-project=hushh-tech-uat \
  --target-region=us-central1 \
  --target-instance=hushh-tech-app-pg-uat \
  --target-database=hushh_tech_app \
  --postgres-major=17 \
  --source-direct-connectivity-verified=true \
  --source-ipv4-addon-verified=true \
  --target-outgoing-ip-mode=TEMPORARY_PUBLIC_IPV4 \
  --target-outgoing-ip-verified=true \
  --connectivity-evidence-hash=<sha256-of-sanitized-preflight> \
  --dry-run
```

The generated JSON never prints the address or source credentials. Supplying a
hash does not attest the artifact here. Temporary public/outgoing connectivity
must be independently verified and later removed before regional high
availability and GCP writes are enabled.

## Offline source inventory

`migration/sql/source_inventory_read_only.sql` is the reviewed catalog query.
It starts a repeatable-read, read-only transaction, emits tagged result sets,
and rolls back. It captures exact row counts and metadata-only facts for
columns, primary/foreign keys, checks, indexes, sequences, triggers, all public
function signatures, public and storage policies, extensions, grants, and the
Auth count. Default expressions and custom function definitions are normalized
and represented only by SHA-256 hashes; their literal values and bodies never
enter the output. A future governed export job may run it with a read-only
source role and convert the tagged result sets to the sanitized shape below in
an encrypted temporary workspace. Do not commit that snapshot.

The later authorized capture job uses a preconfigured read-only PostgreSQL
service entry so no connection string appears in the command or process list:

```bash
umask 077
PGSERVICE=hushh-tech-supabase-readonly \
  psql --no-psqlrc --set=ON_ERROR_STOP=1 --csv --quiet \
  --file=migration/sql/source_inventory_read_only.sql \
  > /secure-temporary-path/source-catalog.csv
```

This checked-in command remains a reference. The protected evidence capture ran
outside the repository; these scripts do not create a service entry, open the
source connection, or store the captured catalog in Git.

The snapshot contract is:

```json
{
  "version": 1,
  "source": {
    "projectRef": "ibsisfnjxeowvdtvgzff",
    "database": "postgres",
    "schema": "public",
    "readOnly": true
  },
  "tables": [
    {
      "schema": "public",
      "name": "agent_profiles",
      "rowCount": 1,
      "primaryKey": ["id"],
      "columns": [
        {
          "name": "id",
          "ordinalPosition": 1,
          "dataType": "uuid",
          "udtSchema": "pg_catalog",
          "udtName": "uuid",
          "nullable": false,
          "hasDefault": false,
          "defaultExpressionHash": null,
          "identity": false,
          "generated": false
        }
      ]
    }
  ],
  "schemaFacts": {
    "foreignKeys": [],
    "checkConstraints": [],
    "indexes": [],
    "sequences": [],
    "triggers": [],
    "functions": [],
    "publicPolicies": [],
    "storagePolicies": [],
    "extensions": [],
    "grants": []
  },
  "catalogCounts": {
    "publicTables": 70,
    "columns": 1,
    "foreignKeys": 0,
    "checkConstraints": 0,
    "indexes": 0,
    "sequences": 0,
    "triggers": 0,
    "publicFunctionSignatures": 142,
    "customPublicFunctions": 24,
    "applicationRpcs": 16,
    "customTriggerFunctions": 8,
    "publicPolicies": 118,
    "storagePolicies": 10,
    "extensions": 0,
    "grants": 0,
    "authUsers": 369
  },
  "rowCountCapture": {
    "baselineRowCount": 44811,
    "observedDelta": 0
  },
  "frozenLiveEvidence": {
    "state": "FROZEN_SANITIZED",
    "hashAlgorithm": "sha256_canonical_json_v1",
    "publicPolicies": 118,
    "storagePolicies": 10,
    "publicFunctionSignatures": 142,
    "customPublicFunctions": 24,
    "applicationRpcs": 16,
    "customTriggerFunctions": 8,
    "defaultExpressions": 381,
    "publicPoliciesHash": "<sha256>",
    "storagePoliciesHash": "<sha256>",
    "allPoliciesHash": "<sha256>",
    "publicFunctionSignaturesHash": "<sha256>",
    "customFunctionSignaturesHash": "<sha256>",
    "applicationRpcSignaturesHash": "<sha256>",
    "customTriggerSignaturesHash": "<sha256>",
    "defaultExpressionHashesHash": "<sha256>",
    "customFunctionDefinitionEvidence": {
      "state": "CAPTURED_HASH_ONLY",
      "hashAlgorithm": "sha256_canonical_json_v1",
      "functionCount": 24,
      "hash": "<sha256>"
    }
  },
  "schemaDumpArtifact": {
    "state": "CAPTURED_ENCRYPTED_REVIEWED",
    "sha256": "da99ca16a8cee1646814f05087db9487555180ae653770b298467ddd63c606d7",
    "encryption": "CLOUD_KMS",
    "reviewed": true,
    "containsData": false
  },
  "authUsers": [
    {
      "legacyUserUuid": "00000000-0000-4000-8000-000000000001",
      "providerSubjects": [
        { "providerId": "apple.com", "subject": "synthetic-apple-subject" }
      ],
      "emailPresent": false,
      "passwordCredential": { "present": false, "algorithm": null }
    }
  ]
}
```

The abbreviated arrays above show shape only; the evidence hashes must use the
exact values in `migration/contracts/source-inventory.v1.json`. The real
snapshot must contain all 70 contract tables, 118 public and 10 storage
policies, 142 public function signatures, the exact 24 custom signature
allowlist (16 callable plus eight trigger functions), and 369 users. The
validator separately scans the repository for exactly 203 `CREATE POLICY`
declarations. The checked-in sanitized evidence artifact binds the exact 128
policy contracts, 142 function contracts, and 381 default-expression hashes;
it contains no default literals or function bodies. The separate
`frozen-live-schema-capture-hashes.v1.json` artifact binds the exact read-only,
repeatable-read capture, 24 per-function definition hashes, aggregate collection
hashes, and capture-query hash. The
`frozen-encrypted-schema-dump-evidence.v1.json` artifact separately binds the
reviewed schema-only dump, the exact 25,886-byte compressed plaintext and its
hash, Cloud Key Management Service key version, ciphertext hash, exact Cloud
Storage generations, bucket controls, round-trip verification, and zero-finding
secret scan. Plaintext, compressed plaintext, ciphertext, the
source capture, and the raw query envelope remain outside Git and are explicitly
forbidden from repository storage. Raw emails are not required. Password
hashes, sessions, refresh/access tokens, one-time passwords, magic links, keys,
connection strings, function bodies, and default literals are rejected or
excluded from the committed sanitized contracts.

Rebuild the hash-only evidence from protected local capture files without
printing definitions:

```bash
npm run --silent gcp:migration:bind-schema-evidence -- \
  --capture=/secure-temporary-path/schema-capture.v1.json \
  --raw-envelope=/secure-temporary-path/schema-capture.raw.json
```

The output is counts, signatures, and SHA-256 hashes only. It must exactly match
`migration/contracts/frozen-live-schema-capture-hashes.v1.json`; the plaintext
inputs must not be committed or uploaded as CI artifacts.

Inventory hashes prove metadata parity, but they do not recreate schema. The
reviewed schema-only dump is now Cloud Key Management Service encrypted in the
private UAT evidence bucket and bound here only by hashes and immutable object
generations. It contains no row data, its encryption round trip was verified,
and the validator accepts only the exact ciphertext SHA-256 value. This clears
the encrypted-artifact evidence gate; execution remains plan-only, so
`applyReady` stays false and `PLAN_ONLY_EXECUTION` remains.

The temporary capture role was disabled with an epoch validity after capture. A
later command-line metadata check refreshed its validity timestamp without
enabling login; the final cleanup restored `NOLOGIN` plus epoch and verified
both in the same result. The exact cleanup timestamp was not captured, and the
sanitized evidence records that fact instead of inventing one.

## Offline target-schema compilation

The reviewed encrypted schema-only dump may be decrypted only into an
operator-owned temporary file outside this repository. The target compiler
accepts that private plaintext path, verifies its exact frozen SHA-256, byte and
line counts, and requires the captured 70 tables, 24 custom functions, 118
public policies, 24 triggers, and 121 explicit indexes. It does not call
Supabase, GCP, PostgreSQL, Firebase, or a shell subprocess.

The output directory must also be new and outside the repository. The compiler
creates it with mode `0700` and writes seven mode-`0600` `.sql.plan` review
artifacts plus one hash-only manifest. Source SQL, function bodies, policy
expressions, absolute paths, and credentials never enter standard output. Each
phase starts a transaction that raises `PLAN_ONLY_EXECUTION` before any target
statement and ends with `ROLLBACK`; this package has no apply path.

```bash
umask 077
npm run --silent gcp:migration:compile-target-schema -- \
  --schema-dump=/secure-temporary-path/hushh-tech-public-schema.sql \
  --output-dir=/secure-temporary-path/compiled-target-schema \
  --dry-run
```

Compilation is deterministic and fail-closed:

- all 70 raw public tables remain present with their source UUID values
  unchanged;
- `hushh_identity.identity_links` retains the legacy UUID while Firebase UID is
  canonical;
- `UNCLAIMED_LEGACY_PRINCIPAL` rows have no Firebase UID and cannot read through
  row-level security;
- the 70 explicitly mapped ownership policies replace `auth.uid()` with an
  ACTIVE-only lookup from transaction-local `app.firebase_uid`;
- all `auth.jwt()` claim policies, source service-role policies, and
  unconditional privileged policies stay blocked rather than being weakened;
- 48/118 public source policies have an explicit blocked disposition, so the
  plan cannot be marked apply-ready until their API authorization is reviewed;
- former `auth.users(id)` foreign keys are translated to the unique preserved
  legacy UUID in `hushh_identity.identity_links`, including denied unclaimed
  principals;
- all 70 tables enable and force row-level security for the non-privileged
  runtime role;
- `hushh_tech_schema_owner` is a sealed `NOLOGIN NOINHERIT` owner for the three
  target schemas and every reviewed table, sequence, and function; migration,
  runtime, audit, and rollback roles cannot own or inherit into it, and it has
  no member until a separate governed executor review; all four operational
  roles are explicitly denied database and target-schema `CREATE`;
- source owners and `anon`, `authenticated`, `service_role`, or public grants
  are discarded and replaced by target-role grants;
- none of the 16 legacy callable RPCs are created or granted; the four generic
  delete helpers are withheld completely;
- only the eight frozen trigger functions are retained, and each is assigned
  to the sealed schema owner and revoked from public plus the owner and all four
  operational roles in the same guarded phase;
- quoted source identifiers are tokenized outside literals and comments, so
  quoted `auth.uid()` is translated while quoted `auth.jwt()` and Storage calls
  remain blocking dependencies;
- source `ALTER TABLE` statements default-deny every form except the exact
  captured `ADD CONSTRAINT` family; and
- migration, audit, and rollback roles receive separate forced-row-level
  security policies for only their operational phases;
- the ten Storage policies are recorded as excluded because the six buckets
  move to GCS IAM rather than Cloud SQL.

The sanitized manifest always reports `applyReady: false` with
`PLAN_ONLY_EXECUTION`, `GOVERNED_EXECUTOR_NOT_PRESENT`, and
`SEALED_SCHEMA_OWNER_EXECUTOR_BINDING_REQUIRED`, plus
`LIVE_TARGET_ATTESTATION_REQUIRED`. It also keeps the 48 blocked policy
contracts, 16 withheld RPC contracts, and exact six-extension review as
cutover blockers. Function, trigger, and index bodies are bound by the reviewed
monolithic plaintext SHA-256; the independent capture hashes are loaded and
artifact-bound but are not falsely described as re-derived by this compiler.
A private write re-hashes the supplied dump and identity foundation, recompiles
all seven phases in the same process, and binds the full report envelope,
including the observed source hash, into the aggregate digest.
A later governed executor must independently attest the exact target, roles,
extension support, and catalog before it can produce executable SQL. Never
commit the decrypted dump or compiled private phases. The exact 210,601-byte
offline compile is a required operator gate because the decrypted input is
intentionally absent from the repository.

After that exact private compile and a zero-finding gitleaks scan, generate the
checked-in hash/count-only evidence before removing the private temporary
directory:

```bash
node scripts/gcp/migration/target-schema-compile-evidence.mjs \
  --generate \
  --private-output-dir=/secure-temporary-path/compiled-target-schema \
  --scan-findings=0 \
  --dry-run
npm run --silent gcp:migration:validate-target-schema-evidence
```

The evidence binds the reviewed compiler and validator bytes, the identity
foundation, the encrypted-dump manifest, opaque source/KMS locator digests,
all seven phase hashes and counts, and the plan-only blocker set. It contains
no source SQL, function bodies, defaults, identities, absolute paths, object
names, key resource names, or credentials. It closes only the exact private
dump offline-compile gate; target catalog attestation and apply authority stay
blocked.

Validate an encrypted-workspace snapshot without printing identities:

```bash
npm run --silent gcp:migration:validate-inventory -- \
  --input=/secure-temporary-path/source-inventory.json \
  --environment=uat \
  --source-project-ref=ibsisfnjxeowvdtvgzff \
  --source-database=postgres \
  --target-project=hushh-tech-uat \
  --target-region=us-central1 \
  --target-instance=hushh-tech-app-pg-uat \
  --target-database=hushh_tech_app \
  --postgres-major=17 \
  --dry-run
```

Standard output is aggregate-only and checked for secret-shaped material.

## Identity mapping

Firebase UID is canonical. Existing accounts link only through an immutable
provider ID plus provider subject. New UIDs derive deterministically from
provider subjects, falling back to the legacy UUID when no provider subject
exists. Email presence is metadata only; an email value never enters the
mapping algorithm. A provider subject shared by multiple source legacy UUIDs
invalidates the snapshot before mapping begins.

The plan uses unkeyed SHA-256 fingerprints only for offline evidence comparison.
Cloud SQL stores a server-generated HMAC-SHA-256 provider-subject key whose HMAC
key remains in Secret Manager; the raw provider subject is not stored there.

The terminal status vocabulary is shared with the retirement manifest:
`LINKED_EXISTING_FIREBASE`, `IMPORTED_FIREBASE`, `MANUAL_RECOVERY`,
`LEGALLY_RETAINED_NO_LOGIN`, and `INTENTIONALLY_DELETED`. The frozen acceptance
totals are:

- 165 existing Firebase provider-subject links
- 204 deterministic new Firebase identities
- three separate Apple-subject accounts without email
- four email/password identities using bcrypt import metadata or password setup
- 65 `UNCLAIMED_LEGACY_PRINCIPAL` records with no Firebase UID and no access

The Firebase provider index is an exact authority envelope:

```json
{
  "projectId": "hushh-pda",
  "tenantId": null,
  "users": [
    {
      "firebaseUid": "existing_uid",
      "providerSubjects": [
        { "providerId": "google.com", "subject": "immutable-provider-subject" }
      ]
    }
  ]
}
```

Wrong or missing Firebase authority fails closed. Validate the offline mapping
inputs:

```bash
npm run --silent gcp:migration:validate-identity-map -- \
  --inventory=/secure-temporary-path/source-inventory.json \
  --firebase=/secure-temporary-path/firebase-provider-index.json \
  --unclaimed=/secure-temporary-path/unclaimed-principals.json \
  --environment=uat \
  --source-project-ref=ibsisfnjxeowvdtvgzff \
  --source-database=postgres \
  --target-project=hushh-tech-uat \
  --target-region=us-central1 \
  --target-instance=hushh-tech-app-pg-uat \
  --target-database=hushh_tech_app \
  --postgres-major=17 \
  --dry-run
```

Only counts and SHA-256 input hashes go to standard output. Provider subjects
and identity rows remain in the encrypted workspace.

### Firebase import dry run

`migration/contracts/firebase-identity-import-dry-run.v1.json` freezes the
execution-disabled Firebase import contract. It binds the tenantless
`hushh-pda` issuer and audience to the `hushh-tech` product, the exact
165 existing links and 204 deterministic imports, the three Apple identities
without email, four email sign-in identities, and 65 denied unclaimed legacy
principals. The contract also freezes the allowed Firebase Admin import record
fields. Protected email, profile, provider, and bcrypt values are named only as
runtime field classes; no value or identity row is stored in the repository.

The dry run additionally requires a protected calendar reconnect file with
exactly one boolean row for every Auth identity:

```json
{
  "version": 1,
  "sourceProjectRef": "ibsisfnjxeowvdtvgzff",
  "contents": "SANITIZED_RECONNECT_FLAGS_ONLY",
  "users": [
    {
      "legacyUserUuid": "00000000-0000-4000-8000-000000000001",
      "reconnectRequired": true
    }
  ]
}
```

The abbreviated array shows shape only. The protected file must contain the
exact same 369 legacy UUIDs as the sanitized inventory. It contains no Google
refresh token; such tokens are deliberately not migrated. Identities marked
`reconnectRequired` receive a one-time calendar reconnect action.

All four protected input files must be regular files outside the repository,
owned by the current user, and have permissions exactly `0600`. Symbolic links,
group/world permissions, oversized files, and metadata changes during a read
fail closed.

Generate the aggregate-only UAT import dry run:

```bash
npm run --silent gcp:migration:plan-firebase-identities -- \
  --inventory=/secure-temporary-path/source-inventory.json \
  --firebase=/secure-temporary-path/firebase-provider-index.json \
  --unclaimed=/secure-temporary-path/unclaimed-principals.json \
  --calendar=/secure-temporary-path/calendar-reconnect-evidence.json \
  --relogin-epoch=2026-08-22T00:00:00Z \
  --environment=uat \
  --source-project-ref=ibsisfnjxeowvdtvgzff \
  --source-database=postgres \
  --target-project=hushh-tech-uat \
  --target-region=us-central1 \
  --target-instance=hushh-tech-app-pg-uat \
  --target-database=hushh_tech_app \
  --postgres-major=17 \
  --dry-run
```

The proposed re-login epoch is bound into the replay key. Hushh Tech APIs use
it as a product-local `auth_time` cutoff. The plan forbids Firebase global token
revocation and Hushh Research session revocation. A changed epoch, authority
index, calendar classification, mapping input, target, or payload schema creates
a different replay key and cannot resume an older checkpoint chain.

Disposition rows use four batches of 100/100/100/69. The 204 new Firebase
identities use three import batches of 100/100/4. Every batch has a deterministic
idempotency key and hash-chained checkpoint. Output contains aggregate counts,
input and contract hashes, batch row counts, checkpoint hashes, and rollback
schema evidence only. It never contains a legacy UUID, Firebase UID, provider
subject, email, password hash, session, or token.

This package has no Firebase Admin dependency, network client, import call, or
output-file option. `--execute`, `--apply`, implicit dry run, and
`--dry-run=false` fail closed. The plan remains blocked by `DRY_RUN_ONLY`,
`PROTECTED_IMPORT_VALUES_NOT_PRESENT`, `LIVE_FIREBASE_IMPORT_EXECUTOR_ABSENT`,
`FRESH_LIVE_UID_COLLISION_PREFLIGHT_REQUIRED`, and
`CUTOVER_APPROVAL_REQUIRED`. This dry-run planner has no user-deletion or
rollback-write authority. A later independently reviewed executor must bind
protected values, re-read Firebase immediately before every batch, recheck UID
collisions and provider ownership, and append rollback evidence before any
import can be considered.

## Target schema

`migration/sql/001_identity_migration_foundation.sql` defines:

- canonical `hushh_identity.identity_links`, with one active legacy UUID,
  Firebase UID, and provider subject mapping;
- forced row-level security based on transaction-local `app.firebase_uid`;
- migration runs with locked source and target guards;
- deterministic checkpoints and replay hashes;
- append-only audit events; and
- an idempotent outbox for cutover and rollback deltas.

The SQL refuses any database except `hushh_tech_app` on PostgreSQL 17. It is a
review artifact in this PR, not an authorization to apply it. A later governed
workflow must bind separate migration, runtime, audit, and rollback roles and
apply the schema only after the target instance is independently verified. The
one-shot migration role creates or attests `pgcrypto`; the runtime role keeps
DML permissions only and must have no database `CREATE`, schema DDL, or
extension-management privilege.

## Security boundary

- No production source or GCP connection is made by these scripts.
- No email-only mapping exists.
- No raw password/session/token/key value is accepted by the sanitized inventory.
- Plan-only CDC never becomes ready and never emits enable SQL from caller claims.
- No source connection material appears in generated plans or standard output.
- Canonical row hashes include schema, allowlisted table, primary key, and full
  JSON-compatible row content without printing the row.
- Checkpoints form a hash chain under one deterministic replay key; a changed
  input produces a different replay key and cannot silently resume.
