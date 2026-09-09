# Supabase Retirement Contract

Tracking issue: [#1950](https://github.com/hushh-labs/hushh_Tech_website/issues/1950)

This contract freezes the source inventory for the no-hybrid Hushh Tech cutover.
It is a migration control, not a claim that migration or production cutover has
already happened.

## Canonical files

- Manifest: `migration/manifests/supabase-retirement.v1.json`
- Sanitized live-bundle evidence: `migration/evidence/supabase-live-function-bundles.v1.json`
- Sanitized 30-day function-traffic evidence: `migration/evidence/supabase-function-traffic-30d.v1.json`
- Validator: `scripts/ci/check-supabase-retirement-manifest.mjs`
- Traffic validator: `scripts/ci/check-supabase-function-traffic-evidence.mjs`
- Generator: `scripts/ci/generate-supabase-retirement-function-registry.mjs`
- Evidence generator: `scripts/ci/generate-supabase-live-function-bundle-evidence.mjs`
- Traffic evidence generator: `scripts/ci/generate-supabase-function-traffic-evidence.mjs`
- Runtime registry: `api/shared/supabaseRetirementFunctionRegistry.generated.js`
- Fail-closed resolver: `api/shared/supabaseRetirementFunctionRegistry.js`
- Negative tests: `tests/supabaseRetirementManifest.test.ts`

Run the blocking check locally:

```bash
npm run migration:retirement:check
npm run migration:function-traffic:check
```

When an approved migration-state change is made in the manifest, regenerate the
runtime copy before validation:

```bash
npm run migration:retirement:generate
```

## Frozen source inventory

| Surface | Frozen count |
| --- | ---: |
| Public PostgreSQL tables | 70 |
| Exact public rows at the freeze | 44,811 |
| Active Edge Functions | 112 |
| Storage buckets | 6 |
| Storage objects | 124 |
| Storage bytes | 111,078,397 |
| Supabase Auth users | 369 |
| Provider identities | 370 |
| Known secondary project references | 6 |

The 112 functions are locked to these GCP owner groups:

| GCP owner group | Functions |
| --- | ---: |
| Investor API | 21 |
| Identity API | 10 |
| Content API | 10 |
| Engagement API and worker | 16 |
| Signed webhook service | 6 |
| Financial API and worker | 48 |
| Security retirement | 1 |

Source recovery is also frozen: 80 functions have checked-in source, 18 must be
recovered from Git history, and 14 require contract reconstruction. The sole
security retirement is `get-secrets`, which must return
`410 FEATURE_RETIRED`; it must never be recreated as a secret-returning route.

## Sanitized live-bundle evidence

A read-only Supabase CLI 2.115.0 capture attempted all 112 active slugs with the
current bundle extractor. It extracted 96 bundles and received the exact
function-store 404 for 16. The repository contains only per-slug canonical
content-tree digests, file counts, and byte counts. Recovered source, command
output, temporary paths, tokens, secrets, and production personal data are not
committed.

The extracted tree contains 445 files and 2,677,504 bytes. Its locked canonical
SHA-256 is
`a976749fa43425152fddb2649ba6442500e412627a004f6ff60ca2892b9011a2`.
The validator cross-checks every evidence slug, function ID, version,
authentication flag, recovery mode, final disposition, and migration state
against the retirement manifest.

`fund-payment-admin-list` and `public-signup-metrics` now have extracted bundle
evidence, but remain `RECONSTRUCT_CONTRACT` and `INVENTORY_FROZEN`. Bundle
capture alone does not prove request, response, authentication, idempotency, or
side-effect parity and does not mark either function as ported. `get-secrets`
remains `RETIRE_WITH_410` and its unavailable store bundle is never recreated.

## Sanitized 30-day traffic evidence

The traffic capture used the supported read-only Supabase Management API route
`GET /v1/projects/{ref}/analytics/endpoints/logs` with ClickHouse SQL against
`function_edge_logs`. It ran one aggregate query for each of 30 daily windows,
from `2026-07-22T16:00:00.000Z` through `2026-08-21T16:00:00.000Z`. Every query
enforces a half-open interval in SQL: the start is included and the end is
excluded. Adjacent windows therefore have no gap and cannot double-count an
event exactly on a shared boundary.

One shared limiter runs before every Management API attempt: deployment
inventory, first window attempts, HTTP retries, and complete-window retries.
The minimum spacing is 6.5 seconds, which stays below the observed 10 requests
per minute limit.

The provider contracts are documented in the [Management API logs
reference](https://supabase.com/docs/reference/api/v1-get-project-logs), the
[logs endpoint migration notice](https://supabase.com/changelog/48235-migration-of-supabase-management-api-logs-all-analytics-endpoint-to-logs-endpoint),
and the [ClickHouse log filtering
guide](https://supabase.com/docs/guides/monitoring-and-debugging/advanced-log-filtering).

The current provider boundary was observed at 90 days, so the requested 30-day
window was available. This is capture evidence, not a promise that provider
retention cannot change. The artifact contains only per-slug UTC aggregates:
request counts, status classes, method counts, authorization-marker presence,
latency and response-size ranges, and deterministic query/response hashes. It
contains no raw logs, bodies, headers, tokens, email addresses, IP addresses,
object names, or request paths.

The 30 global window records retain every boundary, materialized query hash,
provider-response hash, and reconciled count. Per-function records retain
totals plus only nonzero buckets keyed by global window index; an omitted bucket
is validator-defined zero. This keeps the checked-in evidence reviewable
without weakening daily reconciliation.

The standalone traffic check does not trust the three artifacts merely because
they agree with one another. It independently recomputes the frozen active
function inventory digest and the live-bundle evidence digest, then binds the
traffic artifact's computed summary, window, query, deployment, update-time,
and full-artifact digests to the retirement manifest. A consistent slug or
digest substitution across all three files still fails closed.

All 112 active slugs have a terminal traffic-evidence status. Eighteen had
traffic and 94 had zero traffic observed; zero traffic is never labeled unused.
The 30 windows contain 26,481 attributed requests and zero unattributed
requests. A later nonzero `__UNATTRIBUTED__` aggregate is cutover-blocking and
requires a separate private investigation.

All 16 function-store `STORE_NOT_FOUND` slugs had zero traffic observed in this
window. That does not make them safe to retire: 11 still require contract
reconstruction, four still lack a recoverable live bundle, and `get-secrets`
remains the deliberate `410 FEATURE_RETIRED` route. Including the two extracted
functions that still require contract reconstruction, 17 source contracts
remain cutover-blocking.

The current read-only deployment inventory also differs from the frozen bundle
snapshot for 96 of 112 slugs. Only hash-bound deployment bindings and drift
statuses are committed; raw deployment metadata is not. This drift blocks
cutover and requires a separately reviewed source re-extraction. The existing
live-bundle evidence is not rewritten by this traffic lane.

The bound version-delta histogram is exact: 16 functions have delta `0` and all
96 drifted functions have delta `+40`. Its SHA-256 is
`7f4d4af8fb38ece4c5ba58e02a1a204616933db08dc05c9762c05403acead7d7`.
The validator rejects any histogram, digest, or manifest-binding change.

Traffic capture output is always explicit and create-only. The generator
accepts only a new, policy-named direct child of `migration/evidence`, rejects
symlink traversal, uses exclusive file creation, and never creates arbitrary
directories or overwrites an artifact:

```bash
npm run migration:function-traffic:capture -- \
  --project-ref ibsisfnjxeowvdtvgzff \
  --window-end 2026-08-21T16:00:00.000Z \
  --output migration/evidence/supabase-function-traffic-30d.review.json
```

The live-bundle evidence can only be regenerated from an approved read-only
recovery root:

```bash
node scripts/ci/generate-supabase-live-function-bundle-evidence.mjs \
  --recovery-root <read-only-recovery-root> \
  --capture-tool-version 2.115.0
```

## Required entry fields

Every table, function, bucket, Auth aggregate, and secondary reference records:

- source
- GCP owner
- target auth mode
- migration method
- parity check
- rollback treatment
- final disposition
- current migration state

The validator checks exact counts, uniqueness, locked SHA-256 inventory
fingerprints, function ownership, source-recovery treatment, storage totals,
identity rules, and the deliberate `get-secrets` retirement.

The generated registry is copied into the Cloud Run image with `api/`; it does
not read `migration/` at runtime. The resolver denies unknown slugs, returns
`410 FEATURE_RETIRED` for `get-secrets`, and returns
`503 FEATURE_DISABLED` for every non-retired function until its manifest state
is exactly `PORTED_AND_VERIFIED`. This is an explicit allowlist, never a generic
Supabase proxy.

## Identity privacy

Production identity rows do not belong in this public repository. The manifest
therefore records the 369-user inventory as a privacy-safe aggregate and defines
the required private execution ledger.

The private ledger must reach a terminal disposition for 369 of 369 users:

- linked to an existing Firebase identity by provider-subject proof
- imported into Firebase
- manual recovery
- legally retained without login
- intentionally deleted

Email, phone number, and Apple relay email are prohibited mapping keys. The
private ledger itself must remain outside Git and must contain hashed source
references and evidence hashes instead of production personal data.

## Secondary project references

The manifest tracks all currently known non-primary project references:

- legacy community data: `gsqmwxqgqrgzhlhmbscg`
- KYC client runtime: `hkdlmkpqwbjnmcwlxczv`
- DevOps webhook: `jbvfjyxpjyspafqzohmi`
- KYC protocol documentation: `qoeqfmeimagulpzjptbj`
- legacy metrics project: `rpmzykoxqnbozgdoqbpc`
- reports and market storage: `spmxyqxjqxcyywkapong`

Each reference requires ownership and non-use proof before deletion. An
unrelated Supabase project must never be deleted merely because its identifier
appears in the repository.

## Profile migration gate

The legacy `public.members` profile/preferences dependency is now behind the
dedicated authenticated `/api/hushh-profile` and public
`/api/public/hushh-profile/:hushhId` boundaries. Active profile routes do not
query `members`, Supabase, or the generic anonymous data API.

Persistence intentionally remains gated. The repository does not claim that
`public.hushh_profiles` exists or that legacy data has been migrated. The
unresolved contract includes the live `members` schema, `members.id` semantics,
Firebase identity mapping, public Hushh ID semantics, visibility rules, and the
final Cloud SQL ownership contract.

## Blocking lanes

`Supabase Retirement Contract` blocks pull-request validation and merge-queue
validation. The same validator runs in `Main Post-Merge Smoke` before the
deploy-eligible artifact is built.

A legitimate source-inventory change must be investigated on issue #1950. Do
not edit a count or fingerprint only to make CI green. Refresh the read-only
source evidence, explain the drift, update the full disposition, and review the
new frozen contract as a migration-scope change.
