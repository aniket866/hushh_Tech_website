# Current Supabase Function Bundle Capture

Tracking issue: [#1950](https://github.com/hushh-labs/hushh_Tech_website/issues/1950)

This lane freezes a current, read-only Edge Function snapshot without rewriting
the historical retirement evidence in
`migration/evidence/supabase-live-function-bundles.v1.json`.

## Frozen snapshot

The v2 artifact records the Management API metadata captured at
`2026-08-21T17:52:04.388Z` and the bounded bundle capture completed at
`2026-08-21T18:03:38.344Z` for project `ibsisfnjxeowvdtvgzff`.

| Proof | Frozen result |
| --- | ---: |
| Active functions | 112 |
| Exact slug, function ID, and `verify_jwt` matches | 112 |
| Versions unchanged from the retirement manifest | 16 |
| Versions drifted from the retirement manifest | 96 |
| Uniform drift on those 96 functions | +43 |
| Current bundles extracted | 96 |
| Current provider retrieval failures | 16 |
| Total bounded download attempts | 144 |
| Extracted files | 445 |
| Extracted bytes | 2,842,656 |
| Recovered-source gitleaks findings | 0 |

All 16 unavailable bundles returned the allowlisted provider response
`500 Failed to retrieve function bundle` on three attempts. Historical v1 keeps
its original 16 store-404 classifications. The current artifact records both
statuses; it does not relabel the historical observation.

The source tree is temporary and is not committed. Public evidence contains
only function metadata, provider bundle digests where supplied, per-function
content-tree digests, file counts, byte counts, and safe retry classes. It does
not contain recovered source, raw command output, access tokens, secret values,
personal data, or temporary paths.

The offline v2 generator opens every recovery file exactly once with
`O_NOFOLLOW`, requires a regular single-link file owned by the current user with
a non-writable group/world mode, and compares `fstat` identity, size, and time
metadata before and after reading. Digests and gitleaks use only those sealed
bytes through an immutable private copy. Global file, directory, depth,
component/path-byte, per-file, and total-byte caps apply before the tree is
accepted.

Every successful attempt must contain
`supabase/functions/<exact-function-slug>/...`. Allowlisted shared dependency
files are re-rooted under that exact slug for canonicalization. A terminal
failure may contain the strictly checked CLI `.temp` bookkeeping, but its
`supabase/functions` attempt source root must be completely absent. All 945
files and 602 directories in the recovery snapshot are accounted for; any
additional file or directory blocks generation.

Canonical v2 digests use length-prefixed UTF-8 records, NFC-normalized fields,
and reject C0, C1, and DEL control characters. Historical v1 and current v2 are
reported only by their safe digest, bundle/file/byte counts, and capture status.
The artifact does not assert source equivalence across the two canonicalization
versions.

The captured supported metadata exposes provider bundle digests for 66
functions, but no deploy-run identifier or Git source SHA. Therefore the source
revision is `NOT_PROVEN`; the provider digest must not be described as a Git
commit.

This v2 run captured metadata once at the start. It did not perform an exact
end-of-run metadata comparison, and the body-download response does not include
the function version. The 96 content-tree digests therefore cannot be proven to
correspond to the exact start-of-run versions. The artifact records both
limitations as blocking facts. The
collector now fails future captures unless the full start and end metadata sets
match exactly; that strengthened rule does not retroactively upgrade v2.

## Cutover status

This snapshot is `CUTOVER_BLOCKING_VERSION_DRIFT`: 96 functions are +43 from
the retirement manifest. This artifact does not claim continuous deployment
churn because it does not bind a sibling traffic artifact or a second metadata
histogram. Do not infer churn from version drift alone.

Before parity or cutover can rely on function source:

1. freeze all Edge Function deployments;
2. run a new full 112-function read-only capture;
3. require the start and end metadata sets to be identical;
4. recover or reconstruct the 16 bundles still unavailable from the provider;
5. run contract, authorization, idempotency, and side-effect parity tests on the
   frozen source.

The next capture must be a new evidence version and a new reviewed lock. Never
overwrite v1 or v2 in place.

## Read-only commands

The collector permits only the official read surfaces:

- `GET /v1/projects/{ref}/functions`, through `supabase functions list`
- `GET /v1/projects/{ref}/functions/{slug}/body`, through
  `supabase functions download --use-api`

The Supabase Management API documents
[function listing](https://supabase.com/docs/reference/api/v1-list-all-functions)
and [function-body retrieval](https://supabase.com/docs/reference/api/v1-get-a-function-body)
with `edge_functions:read`; the
[CLI reference](https://supabase.com/docs/reference/cli/supabase-orgs-list)
documents `functions download --use-api`. The
collector hard-locks the project ref, rejects write-shaped CLI operations,
uses one global request-start limiter, limits output and command duration, and
allows at most three download attempts.

Capture to a private temporary directory:

```bash
node scripts/ci/capture-supabase-current-function-bundles.mjs \
  --project-ref ibsisfnjxeowvdtvgzff
```

Generate a create-only candidate after the recovered tree passes gitleaks:

```bash
node scripts/ci/generate-supabase-current-function-bundle-evidence.mjs \
  --recovery-root <private-temporary-recovery-root>
```

Validate the committed snapshot and its hard-coded roots:

```bash
node scripts/ci/check-supabase-current-function-bundle-evidence.mjs
npx vitest run tests/supabaseCurrentFunctionBundles.test.ts
```

The checker report is create-only at the exact direct child
`tmp/ci/supabase-current-function-bundles-report.json`. Its trusted parent must
already exist, and the checker creates the file with mode `0600`; it never
creates directories, follows a symlink, accepts an alternate path, or
overwrites a prior report.

## Traffic-evidence integration

The 30-day traffic lane is a sibling change based on the same PR #1951 head.
Keep the two evidence histories independent:

1. land the traffic artifact and validator without replacing this v2 snapshot;
2. land this lane as a disjoint stack containing only new files;
3. in a small follow-up, make the retirement orchestrator call both strict
   validators and bind each artifact's locked file digest;
4. if traffic evidence needs current versions, update it to bind v2 explicitly
   rather than silently treating historical v1 metadata as current;
5. require a fresh post-freeze v3 bundle capture before any function is marked
   parity-ready.

Traffic proves observed request volume. Bundle extraction proves source
availability and content identity. Neither alone proves request/response,
authorization, idempotency, or side-effect parity.
