# UAT Firebase-native application identity and NDA boundary

## Scope and verified catalog

This patch targets only `hushh-tech-uat`, Cloud SQL `hushh-tech-app-pg-uat`,
database `hushh_tech_app`, PostgreSQL 17. The read-only IAM catalog audit found:

- `identity_links`, `users`, and `nda_signatures` owned by the sealed
  `hushh_tech_schema_owner`, all with FORCE RLS.
- Stable application UUIDs in `identity_links.legacy_user_uuid`; Firebase UIDs
  are strings, not those UUIDs. `users.id` references that canonical UUID.
- `nda_signatures.user_id` is unique; all document/consent evidence columns
  already exist. There is no NDA user-id FK or trigger to recreate.
- No `check_user_nda_status` or `sign_global_nda` function in any schema.
- 369 active migrated mappings, 365 primary provider fingerprints, four UUID
  imports. One migrated identity has two providers but only one fingerprint
  in its identity link. A primary-fingerprint-only snapshot is insufficient.
- Catalog comments claim keyed HMAC, while the checked-in identity executor
  uses SHA-256(provider ID + NUL + NFC subject). Catalog byte length alone
  cannot prove which encoding produced the retained hashes.

No live database writes are part of local verification. The integration fixture
uses synthetic records and reproduces only the relevant audited catalog.

Read-only follow-up on 2026-09-10 used the existing VM's audit-account
impersonation (not a new IAM grant) and compared current Firebase provider
subjects in memory. All 369 mapped Firebase accounts exist; all 365 retained
primary hashes match SHA-256(provider ID + NUL + NFC subject), zero mismatch,
and four mappings have no primary hash. Three mapped accounts currently have
multiple providers. No subjects, tokens or user records were exported. This
proves retained primary encoding parity, not complete historical/recovery
ownership or approval to activate admission. Reconcile current secondary
providers with the retained migration disposition counts before loading any
evidence; do not silently change those counts or weaken the coverage check.

## Per-file dependency and necessity review

No changed runtime file imports a Supabase SDK, calls a Supabase host, uses
Supabase token verification, or recreates either retired NDA RPC. References to
the locked legacy source ID are retained provenance constraints, not a runtime
service dependency. PDF/notification wrappers are preserved, not replaced or
newly introduced. There is no new per-user/UI verification state.

| File | Old dependency/assumption removed | Existing equivalent reused and reason |
| --- | --- | --- |
| `api/gcp-data.js` | Generic dispatch could not serve migrated NDA calls. | Existing Firebase bearer verification and Express route; dispatch explicit NDA operations, return auth errors safely. |
| `api/shared/gcpDataRuntime.js` | Generic consent mutations could bypass the explicit validator. | Existing UAT Cloud SQL pool, Firebase Admin app, transaction-local UID; exclude validator bypasses. Current main's legacy RPC blocklist remains unchanged. |
| `api/shared/gcpIdentityProvisioning.js` | No runtime equivalent for creating application principals after Firebase signup. | Existing Firebase Admin authority and identity resolver; derive trusted evidence server-side and call restricted provisioning. |
| `api/shared/gcpNdaRuntime.js` | Missing legacy status/sign RPC implementations. | Existing Cloud SQL signature table and ownership RLS; explicit validated status, record and atomic signing. |
| `migration/sql/003_firebase_native_mapping_basis.sql` | Mapping basis supported only migrated source identities. | Extend the existing enum, separately committed before use. No user data change. |
| `migration/sql/004_firebase_native_provisioning.sql` | Resolver required a legacy source for every identity; normal native provisioning was absent. | Extend existing identity links/resolver; sealed provisioning role, truthful native provenance and default-off admission policy. Separate provider ownership is necessary for the audited multi-provider gap. Existing UUIDs and legacy constraints remain. |
| `src/services/nda/ndaService.ts` | Two legacy RPC calls and a browser UID used as a database UUID selector. | Existing Firebase-backed session token, same-origin GCP operations, existing storage namespace. Errors propagate rather than pretending unsigned. |
| `src/services/access/accessControlApi.ts` | Protected-content/profile NDA checks still used an unserved PostgREST-style table URL after signing. | Reuse the same native status operation with the caller's Firebase token; preserve existing Approved/Pending UI values only for valid status responses. Other legacy form operations are not part of `/sign-nda` and are unchanged. |
| `src/pages/sign-nda/index.tsx` | RPC invocation omitted explicit consent boolean and tolerated missing notification signal. | Existing checkbox, document list, consent version and success navigation; supply the exact explicit signing contract. |
| `src/components/GlobalNDAGate.tsx` | Failed status could grant optimistic access; public-route access was stored as signed consent. | Existing session, NDA boolean and route-policy helpers; fail closed, show retryable errors, keep public permission separate from consent. No extra identity-verification field. |
| `src/components/nda/MyNdaDocuments.tsx` | Record lookup errors were previously collapsed to null. | Existing record view; handle the service's real error without showing an unsigned result. |
| `tests/gcpBackendRuntime.test.ts` | Missing explicit status-RPC denial assertion. | Add the denial assertion alongside main's existing signing-RPC block assertion. Main's contradictory legacy compatibility tests are recorded separately below, not weakened. |
| `tests/globalNDAGateFailClosed.test.ts` | Missing main-app timeout/error and public-page transition coverage. | Existing React/session mocks and gate; prove denial and retry without modifying Research behavior. |
| `tests/gcpNdaApi.test.ts` | No explicit NDA route auth/error boundary tests. | Existing handler with Firebase verification mocked; prove invalid/revoked tokens never reach NDA persistence. |
| `tests/gcpNdaContract.test.ts` | No server-native consent contract coverage. | Actual backend validator and existing frontend document constants; prove exact parity and bypass denial. |
| `tests/gcpNdaPostgres.test.ts` | Existing tests could not prove native provisioning/RLS without legacy services. | Real disposable PostgreSQL 17 and the restricted runtime role; prove transactions, concurrency, ownership, denial and retries. |
| `tests/fixtures/ndaUatCatalog.sql` | No isolated fixture of the verified migrated catalog. | Synthetic audited table/role/RLS shape, alongside canonical foundation SQL; no live records or external service. |
| `tests/ndaServiceGcp.test.ts` | Existing mirrored tests did not exercise the actual new service contract. | Actual NDA service with synthetic session/HTTP responses; status/error/record/consent and independent PDF/notification failure coverage. |
| `tests/noHybridNetwork.spec.ts` | Signed browser fixture still mocked the retired status RPC. | Mirror only explicit status/record operations, assert no client identity selector, and reject legacy/signing fixture operations. Existing route, persona and provider-egress assertions remain intact. |
| `src/services/nda/uatNdaPage.ts`, `src/services/analytics/siteAnalytics.ts`, `tests/uatNdaPageTraffic.test.ts` | Nonessential UAT NDA requests reached disabled ticker/collector and incompatible optional PDF services. | Exact UAT host/route boundary, existing header option and optional PDF architecture; do not invoke these requests. No status/signing suppression or production behavior change. |
| `scripts/gcp/migration/nda-release.mjs`, `migration/docker/nda-release.Dockerfile`, `tests/ndaReleaseExecutor.test.ts` | Historical migration executor does not support this reviewed release safely. | Existing Cloud SQL connector, migration identity and locked dependencies; exact-file/hash-bound, ordered, default-preflight executor. No legacy service dependency, live activation or permission bypass. |
| `docs/reference/architecture/gcp-nda-runtime.md` | No runbook for the missing runtime capability. | Verified catalog and existing governed UAT process; document admission evidence, migration order and non-destructive rollback. |

## Runtime contract

`POST /api/gcp/data`, Firebase bearer token, `Cache-Control: no-store`:

```json
{ "kind": "nda", "operation": "status" }
```

Returns `{ "data": { "hasSignedNda": false, "signedAt": null,
"ndaVersion": null, "signerName": null } }` only for a successfully resolved
unsigned principal. `record` returns the current signature or null. Identity
or lookup failures are errors, never interpreted as unsigned.

`sign` includes `signing` with `signerName`, `ndaVersion`, `consentVersion`,
`consentAccepted: true`, `documentsAcknowledged`, and optional `pdfUrl`.
Both versions must be `v1.0`; the four exact document names must match the
existing `ndaDocuments.ts` contract. Unknown fields, including any client
UID/application UUID/provider/provenance selector, are rejected.

The scalar success response retains `success`, `signedAt`, `signerName`,
`ndaVersion`, `shouldNotify`, `wasInserted`, and `versionChanged`.

1. Existing Firebase Admin verification checks token revocation and project.
2. Admin `getUser()` supplies account creation time and immutable provider
   subjects. No client-supplied provider data, email matching, or UID casting.
3. A transaction-local verified UID and project call
   `hushh_identity.ensure_current_application_principal(jsonb)`.
4. Existing active mappings resolve unchanged; revoked/ambiguous mappings deny.
5. An eligible native identity receives a DB-generated UUID, minimal `users`
   row, ownership records and truthful native provenance in the same transaction.
6. NDA status/signing uses that UUID with the existing ownership RLS. Advisory
   locks serialize bootstrap and signing; the unique `user_id` boundary handles
   retries. JSONB consent and server-generated signature evidence commit together.
7. Identical retries preserve original timestamp, PDF reference, signature ID,
   and document evidence. Conflicting same-version consent returns 409.

The provisioning owner is NOLOGIN, NOINHERIT, NOBYPASSRLS, has no members and
only the required SELECT/INSERT grants. Its SECURITY DEFINER function has a
fixed search path, no dynamic SQL, no PUBLIC execute, and only web IAM execute.
Web runtime cannot directly mutate identity links. Generic browser NDA
INSERT/UPDATE/UPSERT/DELETE and both legacy NDA RPC names are disallowed.
Existing NDA RLS policies are not weakened.

PDF references may be null or a caller-owned existing GCP storage path under
`assets/<firebase-uid>/signed-ndas/`. External/blob/traversal URLs are rejected.
No PDF provider contract is changed. PDF failure does not prevent consent;
notification runs after the durable result and cannot undo it. IP stays
`unknown` rather than trusting an unattested forwarded-header chain. User-agent
is bounded; timestamp and signature ID are generated server-side.

## Admission evidence: required before enabling new creation

Creation defaults OFF in `runtime_admission`. Existing active mappings work
with it off, including native mappings after an emergency stop.

Ankit/the identity owner must supply and approve a complete authoritative
provider/recovery snapshot, not infer it from the browser or primary links:

- Every provider subject for each migrated principal, including secondary
  providers; denied/revoked/deleted/recovery ownership retained as tombstones.
- Proven fingerprint encoding parity with existing data; no reinterpretation
  of HMAC as plain SHA-256. Resolve discrepancies before activation.
- A reviewed evidence reference and Firebase account-creation cutoff after
  the complete snapshot. Pre-cutoff unmapped accounts require manual recovery.
- Exact ownership disposition and stable application UUID where known. No
  blind backfill or unreviewed automatic reassignment.

The governed database owner loads this verified evidence into the restricted
`provider_ownership` table and attests `evidence_complete`, `evidence_reference`,
`new_accounts_after`, and `fingerprint_scheme` before `creation_enabled=true`.
There is deliberately no browser or generic runtime admin API to do this.
Do not seed production/user ownership from test fixtures. The function checks
coverage against migration dispositions and retained primary hashes, refuses
unclaimed principals, and denies provider collisions. These checks supplement,
not replace, the human-reviewed completeness assertion.

Until that evidence exists, genuinely new users return a retryable service/
identity-review error; **this is not a completed new-user UAT rollout**.

## Final caller trace

- `GlobalNDAGate` → `checkNDAStatus` → authenticated native `status`.
- `/sign-nda` → `signNDA` → authenticated native `sign` with explicit consent.
- `MyNdaDocuments` → `getNDARecord` → authenticated native `record`.
- Protected-content/profile `checkAccessStatus` → `checkNDAStatusWithToken` →
  the same native `status`, not `/rest/v1/nda_signatures`. Null, malformed,
  non-boolean or internally incomplete signed responses throw; they are not
  treated as unsigned or approved. No new session/verification state is added.
- Community server access still independently verifies Firebase, resolves the
  application UUID through `current_legacy_user_uuid()` and reads signed evidence
  under existing RLS. A browser status result is never backend authorization.

The separate `get_nda_metadata`, `accept_nda_v2`, and `request_file_access`
wrappers used by other legacy form surfaces are not called by `/sign-nda`.
They were not enabled, recreated, or redesigned in this patch.

## Ordered rollout and rollback

1. Review this branch, security results, live catalog comparison and migration
   privilege preconditions with the database owner. Re-run the read-only catalog
   attestation immediately before applying; abort on schema/owner/policy drift.
2. Apply `003_firebase_native_mapping_basis.sql` through the approved governed
   database execution path as the existing migration administrator. Commit this
   enum migration separately before `004_firebase_native_provisioning.sql`.
   Do not replay 001, historical source migrations, or migration importers.
3. Apply 004 once; it is transactional and deliberately rejects partial/replay
   targets. Check sealed owners/memberships, function ACLs, FORCE RLS, unchanged
   existing UUIDs/counts and creation OFF. No web startup schema mutation.
4. Prepare/attest admission evidence separately as above. Validate ownership
   collisions and recovery scenarios before activation.
5. Merge only after authorized review and required CI. Deploy the reviewed green
   main SHA through `.github/workflows/deploy-uat.yml`. No laptop, production,
   OAuth, Research, DNS or external PDF service change.
6. Use real existing mapped, new Google and new Apple test users. Verify status,
   complete document review and consent, successful signing/navigation, reload,
   protected content access, logout/login, cancellation and identical retries.
   Compare persisted evidence using the approved audit path without exporting
   user records. Verify forged generic mutations and cross-user requests deny.
7. Preserve release identity and the deployed sensitive-NDA gate. Its existing
   signed test identity must have a valid mapping and real consent. Do not alter
   the deployment gate to manufacture a passing result.

Emergency rollback: disable only `runtime_admission.creation_enabled` through
the governed DB owner. Do not delete native identities, ownership evidence,
consent or enum values. Existing mappings/resolver must remain supported.
An application rollback to the old missing-RPC implementation will break NDA
signing again; select a compatible reviewed release, not a destructive schema
rollback. If 004 fails its transaction, 003's unused enum value is harmless.

### Narrow release executor (prepared, NOT approved or activated)

`scripts/gcp/migration/nda-release.mjs` and
`migration/docker/nda-release.Dockerfile` prepare an exact-file replacement for
the existing UAT `schema-migrator` job, using the existing locked attestor
dependencies (no new package or service account). This is not deployed by the
web workflow and does not modify that workflow. The existing historical v6
`apply`/`grant` modes must NOT be used: the inspected v6 image lacks 003/004,
scans historical SQL, continues on errors and exposes broad public-schema grants.

The new entrypoint defaults to `preflight`. It verifies the actual GCP metadata
project/service account and existing job name; connects with the Cloud SQL
connector to the fixed private UAT instance as `postgres`; accepts only the two
SHA-256-pinned SQL files; and logs no password, SQL error details or user records.
It has no admission-enable or ownership-import operation.

Apply uses a session advisory lock across separately committed migrations.
Migration SQL and its completion marker commit together. The narrow
`hushh_migration.nda_release_migrations` ledger has FORCE RLS, sealed schema-owner
ownership, and explicit SELECT/INSERT for the migration administrator only.
There is no web grant. A failed 004 leaves a recorded committed 003 and can be
retried; unknown/unrecorded partial state or changed hashes fail closed. No
automatic down migration, role repair, or historical replay is provided.

### Managed-role capability: verified behavior, not a superuser assumption

The 2026-09-11 authorized UAT rollback probe disproved the earlier assumption
that Cloud SQL postgres cannot perform the required lifecycle. It successfully
granted/set/reset/revoked the existing owner, created the exact restricted
provisioner, granted/set/reset/revoked it, verified zero memberships and rolled
everything back. Cloud SQL did not retain the automatic creator membership
observed in ordinary PostgreSQL 17. This is target-specific operational proof,
not authority inferred from GCP Owner or CREATEROLE.

The separately authorized single web-to-schema-owner REVOKE was committed.
Fresh read-only catalog evidence confirms zero sealed-role memberships,
preserved web IAM/runtime memberships, FORCE RLS, owners and existing grants.
Aggregate fingerprints/counts of all 369 links, 104 users and 327 signatures
are unchanged. The original grantor was cloudsqladmin; the originating human
or invocation remains unproven. No further role repair is performed by this
executor. Migrations 003/004 and their ledger are still absent at this audit.

The corrected executor separates three modes:

- `preflight`: read-only catalog/hash/ledger/security checks. `ready=true`
  means catalog readiness, not permission to apply. Pending SQL reports
  `roleCapability=requires_rollback_probe`.
- `probe`: requires the release SHA and session lock; runs the exact temporary
  role lifecycle, verifies the selected actors and zero memberships, ALWAYS
  rolls back, then rechecks the original catalog. No SQL migration or ledger
  entry is committed. Success reports `proven_rolled_back`.
- `apply`: repeats preflight and the mandatory rollback probe itself before
  pending files. An earlier probe report is not trusted input. Failure stops
  before migration SQL. Completed releases need only read-only postconditions.

No boolean override, fake superuser result, persistent grant, provider evidence
or SQL checksum change is accepted. Real disposable PG17 tests preserve the
ordinary CREATEROLE-denial/creator-membership regression alongside successful
probe rollback, ordered commits, 004 failure recovery and idempotency tests.
The live managed-role behavior requires separate UAT proof, not a fixture claim.

The corrected local executor's `probe` mode was also run against live UAT on
2026-09-11 through the existing private VM/TLS path: preflight passed as
non-superuser postgres, capability reported `proven_rolled_back`, and the
subsequent preflight was identical. All 19 captured catalog/integrity sections
matched before/after. This diagnostic is not a deployed image or migration
approval. The governed NDA test account authenticated, but native `status` and
`record` still returned HTTP 500; fresh Cloud SQL logs confirmed the missing
`ensure_current_application_principal(jsonb)` function. No consent was submitted.

Exact release sequence:

1. Authorized review of the executor, pinned 003/004 bytes, fresh catalog and
   managed-role capability proof. Land the reviewed change and require green
   main checks before releasing its image. Do not alter the application gate.
2. Build the dedicated Dockerfile from a clean reviewed checkout. Use an explicit
   narrow build context: this Dockerfile, the runner, the two SQL files and the
   existing attestor package/lock files. The root `.gcloudignore` excludes SQL
   and scripts and is NOT a valid implicit migration build context.
3. The release owner binds the resulting immutable image digest to the existing
   `schema-migrator` job, preserving its service account, private VPC connection
   and postgres-secret reference. No historical SQL is packaged.
4. Run `MODE=preflight` on that reviewed image. The current image v6 is NOT this
   entrypoint. Abort on any blocker; do not use an execution override to defeat it.
5. Invoke `MODE=probe`, `RELEASE_SHA=<reviewed-full-main-sha>` and verify its
   rolled-back result. Only after successful proof/approval invoke the same image with `MODE=apply`
   and `RELEASE_SHA=<reviewed-full-main-sha>`. 003 commits before 004 starts; SQL
   and completion records are atomic and 004 failure stops the job immediately.
6. Re-run preflight and inspect restricted ledger/postconditions. Admission
   remains OFF until the separately approved complete evidence is loaded by the
   governed database owner. The SHA input records identity, not review approval.
7. Deploy only through the existing green-main UAT workflow, then perform real
   existing/Google/Apple signing and protected-content verification.

The executor correction must still pass review and land on green main before
its image is released. The old deployed v6 is not an acceptable substitute.
Provider/recovery evidence and an approved test identity remain separate
prerequisites; do not enable admission or create legal signatures to bypass them.

### Historical live snapshot before PR preparation (2026-09-10)

The last authorized live audit observed UAT `hushh-tech-website-00268-mug`, commit
`1e5b6f4adc095b57de7ce39ef7583578fe18c28d`. It still rejects the retired NDA RPCs
before opening a database transaction. The native fix at `d703bd72` plus local
follow-ups was not deployed at that audit. `schema-migrator` was generation 5,
image v6, using the existing migration service account/password-secret binding.
The native admission table, provisioner function and release ledger remain absent.
No live before/after schema difference was created by this continuation.

Local proof: 229 focused tests across 17 suites, including real disposable PG17
role-lifecycle, provider collision and signing concurrency tests; 20 smoke tests;
root typecheck, governed lint, changed-file lint, environment validation,
retirement contract, production build and source/artifact no-hybrid gates pass.
Current-tree gitleaks reports no leaks. `security:audit` still fails on known
historical `.env`/Apple-key paths; no history rewriting or policy change was done.
These are local results, not proof of real UAT signing or complete browser
no-hybrid verification.

Remaining release prerequisites are a reviewed managed-role execution/remediation
path, complete approved ownership/recovery evidence, and normal PR/green-main
release approval. The separate history-audit finding belongs to maintainers;
it is not the GitHub dependency-audit gate and this patch does not rewrite history.
Then run the exact migration preflight/apply/postconditions and existing UAT
deployment workflow, followed by approved existing/new Google/new Apple signing
tests. Until then this release is **NOT READY**, and native admission must stay
off. No real legal signature has been submitted by this continuation.

### PR preparation baseline

This branch incorporates `main` at `1e5b6f4adc095b57de7ce39ef7583578fe18c28d`.
There are no changes to OAuth, provider settings, production configuration,
release workflows or security gates. PR preparation performs no live database,
IAM, infrastructure or deployment operations. Disposable local PostgreSQL
tests are not UAT migration execution.

The full local suite initially reported 1,890 passed, 44 skipped and eight
failures. Five failures in `tests/gcpBackendRuntime.test.ts` reproduce on a
clean checkout of that exact main SHA: the compatibility tests expect three
legacy RPCs to work although main's allowlist is empty and its blocklist denies
them. They must not be resolved by restoring legacy NDA RPC access. Two
`retirementCandidateClassifier` 15-second timeouts also reproduce on clean
main; the single `gcpEdgeFunctionTerminalMatrix` timeout passes on a serial
rerun. No timeout or assertion was relaxed.

The main-integrated focused NDA/auth/proxy run passes 204 tests (one existing
skip), including all 20 disposable PostgreSQL tests. Root typecheck, governed
lint, env validation, production build, migration retirement/route/source
contracts, 20 smoke tests and the Cloud SQL attestor static checks pass.
All 174 service-foundation tests and all 18 Chromium/WebKit no-hybrid browser
tests pass. The browser fixture was aligned to explicit NDA status/record
operations; no runtime bypass, route assertion or provider-network guard was
removed. The browsers use CI's Node 20.19.0 and synthetic users only.
The eight extra file-level ESLint diagnostics (empty catches, React effect/
memoization warnings and a browser-fixture initial assignment) reproduce on
clean main; governed `lint:ci` is green.
The dependency audit reports zero vulnerabilities. Current-tree gitleaks
finds no leaks; `security:audit` still reports pre-existing history exposure
paths, with no tracked secret-bearing files introduced by this branch.

These baseline failures are documented for review, not waived. A PR remains
blocked from merge while a required GitHub check is red. Real existing/new
Google/Apple signing remains a later, separately authorized UAT release test.

## Reproducible local proof

Use PostgreSQL **17** binaries, for example the normal Homebrew
`postgresql@17` package. No new application dependency is required.

```sh
REQUIRE_NDA_POSTGRES=true HUSHH_TEST_POSTGRES_BIN=/path/to/postgresql17/bin npx vitest run tests/gcpNdaPostgres.test.ts
npx vitest run tests/gcpNdaContract.test.ts tests/gcpNdaApi.test.ts tests/ndaServiceGcp.test.ts tests/globalNDAGateFailClosed.test.ts tests/gcpBackendRuntime.test.ts tests/authCallback.test.ts tests/gcpBackendAuth.test.ts
```

The real PostgreSQL suite starts a disposable Unix-socket-only cluster; it
cannot accept a remote database URL. It connects as the non-superuser web IAM
role for runtime tests. Migration application is performed by the fixture's
privileged administrator, so Cloud SQL administrative execution permissions
still require pre-apply verification. Without PG17 binaries ordinary `npm test`
reports this suite skipped; `REQUIRE_NDA_POSTGRES=true` makes missing binaries a
hard error. CI without PG17 is not evidence that database integration passed.
