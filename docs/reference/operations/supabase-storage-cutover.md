# Supabase Storage Cutover Foundation

This foundation describes the fail-closed storage migration contract for issue #1950. The base contract remains `PLANNING_ONLY_NO_LIVE_IO`: it does not authorize a copy, deletion, signed URL, or production execution. A separate candidate policy permits only explicitly requested read-only UAT inventory collection. Copy execution remains hard-blocked pending independent security review and a separate parent-approved activation commit.

## Frozen source and UAT targets

The 2026-08-20 source snapshot is locked to six buckets, 124 objects, and 111,078,397 bytes.

| Supabase bucket | Public at freeze | Objects | Bytes | UAT Google Cloud Storage bucket | Target delivery |
| --- | ---: | ---: | ---: | --- | --- |
| `assets` | yes | 5 | 19,971,280 | `hushh-tech-assets-legal-uat` | private service or five-minute signed URL |
| `community-uploads` | yes | 115 | 81,259,134 | `hushh-tech-community-content-uat` | private storage; reviewed content may use the controlled media host |
| `hushh-agent-profile-images` | yes | 1 | 716,241 | `hushh-tech-profile-images-uat` | private original; controlled public rendition only |
| `hushh-ai-media` | yes | 0 | 0 | `hushh-tech-ai-media-uat` | owner-scoped private access |
| `hushh-gamma-pdf` | yes | 3 | 9,131,742 | `hushh-tech-reports-uat` | private five-minute signed URL |
| `wa-evidence` | no | 0 | 0 | `hushh-tech-wa-evidence-uat` | Google service identity only |

Every target bucket must use uniform bucket-level access and enforced public-access prevention. A public Supabase source bucket does not authorize a public object access control list in Google Cloud Storage. Public delivery is a separate, reviewed application/media-route decision.

The machine-readable source of truth is `migration/storage/supabase-storage-cutover.v1.json`.

## Private inventory input

Production object keys belong only in a private newline-delimited JSON (JSONL) inventory. Keep that file outside the repository or under the ignored `tmp/` directory. The planner rejects remote paths, symbolic links, tracked repository paths, non-regular files, files larger than 8 MiB, and arguments that do not belong to the selected mode.

The first record is the frozen header:

```json
{"recordType":"sourceInventory","schemaVersion":"supabase-storage-source-jsonl-v1","snapshotKind":"FROZEN_BASELINE","sourceProjectRef":"<locked-project-ref>","frozenAt":"<locked-timestamp>","snapshotSequence":0,"exportRunId":"<unique-export-run>","bucketCount":6,"objectCount":124,"totalBytes":111078397,"tombstoneCount":0,"deltaEvidenceDigestSha256":null,"previousCheckpointDigestSha256":null,"previousSourceInventoryDigestSha256":null,"previousSourceArtifactDigestSha256":null,"previousDeltaEvidenceDigestSha256":null,"inventoryDigestSha256":"<lowercase-sha256>","sourceArtifactDigestSha256":"<lowercase-sha256>"}
```

Add exactly six bucket records:

```json
{"recordType":"sourceBucket","bucketId":"assets","public":true,"objectCount":5,"totalBytes":19971280}
```

Add exactly 124 object records. The hash must be calculated from the source bytes, not from an entity tag or encoded response:

```json
{"recordType":"sourceObject","bucketId":"assets","objectKey":"<private-object-key>","sizeBytes":123,"mimeType":"application/octet-stream","sourceUpdatedAt":"2026-08-20T20:14:47Z","cacheControl":null,"sha256":"<lowercase-sha256>"}
```

The canonical source digest is the SHA-256 of sorted canonical bucket and object records. The source artifact digest separately binds the snapshot header, continuity fields, buckets, objects, and tombstones without a circular self-reference. Input ordering does not change either digest. Planner output uses a SHA-256 object identity and never includes object keys or object URLs.

A later complete inventory may use `snapshotKind: RECORDED_DELTA`. It must bind the exact prior checkpoint, source inventory digest, source artifact digest, prior delta evidence digest, the next sequence number, a unique export run, a separate delta evidence digest, and a strictly later timestamp. Each checkpoint retains a digest-bound, duplicate-free history of every export run and delta evidence digest. The history is capped at 256 entries, so non-adjacent replay is rejected without allowing unbounded input. Reusing a run, artifact, evidence chain, stale timestamp, or swapped checkpoint fails closed.

Every checkpoint carries the complete prior source object-ID and fingerprint set. Each entry records `TARGET_PRESENT` with the exact generation and fingerprint or `TARGET_ABSENT` with no target data. A source deletion requires one key-free record:

```json
{"recordType":"sourceTombstone","objectId":"<lowercase-sha256>","priorSourceFingerprintSha256":"<lowercase-sha256>","deletedAt":"<timestamp inside delta window>","deletionReason":"<reviewed reason>","previousSourceInventoryDigestSha256":"<prior digest>","deltaEvidenceDigestSha256":"<current evidence digest>","sourceArtifactDigestSha256":"<current artifact digest>"}
```

The tombstone must match the prior fingerprint and current evidence/artifact. Missing, unknown, duplicated, forged, replayed, or resurrected objects stop delta planning, checkpointing, and reconciliation. The older offline planner can describe a non-executable generation-matched delete, but the live-copy candidate does not accept that action: it removes the later database pointer, retains immutable target bytes, and never calls a Google Cloud Storage delete or metadata-update endpoint.

## Target inventory input

The target header records the UAT project, region, current object and byte totals, and the source inventory digest:

```json
{"recordType":"targetInventory","schemaVersion":"gcs-storage-target-jsonl-v1","environment":"uat","project":"hushh-tech-uat","region":"us-central1","bucketCount":6,"objectCount":124,"totalBytes":111078397,"signedUrlIssuerCount":5,"signedUrlIssuerEvidenceDigestSha256":"<lowercase-sha256>","sourceInventoryDigestSha256":"<lowercase-sha256>","inventoryDigestSha256":"<lowercase-sha256>"}
```

Each target bucket must include this security evidence:

```json
{"recordType":"targetBucket","bucketName":"hushh-tech-assets-legal-uat","uniformBucketLevelAccess":true,"publicAccessPrevention":"enforced","publicIamMembers":[],"location":"US-CENTRAL1","versioningEnabled":true,"iamEvidenceScope":"EFFECTIVE_PROJECT_AND_BUCKET","bucketIamBindings":[{"role":"roles/storage.objectViewer","members":["serviceAccount:<allowlisted-runtime>"]}],"inheritedIamBindings":[],"effectiveIamBindings":[{"role":"roles/storage.objectViewer","members":["serviceAccount:<allowlisted-runtime>"]}],"iamPolicyDigestSha256":"<lowercase-sha256>"}
```

The normalized bucket policy and effective project-plus-bucket policy must exactly match the per-bucket service-account/role allowlist. The evidence exporter must include every project, folder, or organization binding that grants storage data-plane or administration access; this contract requires that inherited set to be empty. Public principals, basic project principals, legacy roles, conditional bindings, domains, groups, users, external-project service identities, and unlisted service identities fail closed. The policy digest binds the evidence scope, bucket bindings, inherited bindings, and effective bindings.

Each approved signing identity has a separate evidence record that binds the bucket, exact enabled service account and project, verified `signBlob` permission, `GET`/`HEAD`, 300-second maximum, generation pin, bucket/key allowlist, `private, no-store`, no browser credentials, and an evidence digest.

Each target object record carries the original key privately, a positive Google Cloud Storage generation, and all parity fields:

```json
{"recordType":"targetObject","sourceBucketId":"assets","sourceObjectKey":"<private-object-key>","targetBucket":"hushh-tech-assets-legal-uat","targetObjectKey":"<same-private-object-key>","generation":"123456789","sizeBytes":123,"mimeType":"application/octet-stream","sourceUpdatedAtMetadata":"2026-08-20T20:14:47Z","sourceCacheControlMetadata":"<legacy provenance or null>","servingCacheControl":"private, no-store","sha256":"<lowercase-sha256>","accessMode":"PRIVATE_SERVICE_OR_SIGNED_URL","publicAcl":false}
```

Reconciliation requires exact bucket, key, byte, Multipurpose Internet Mail Extensions (MIME) type, source timestamp metadata, legacy cache provenance, safe target serving cache policy, SHA-256, access mode, and generation-bearing target evidence. Every inventory and evidence record uses an exact field schema. A raw target `cacheControl` field that contradicts `private, no-store` is rejected; legacy public cache directives are retained only as provenance and are never installed as the serving policy for private originals.

## Dry-run modes

Run the locked contract check:

```bash
npm run migration:storage:contract
```

Run a private source validation or seed plan:

```bash
node scripts/migration/storage-cutover-plan.mjs --mode validate-source --source tmp/private-source.jsonl
node scripts/migration/storage-cutover-plan.mjs --mode seed-plan --source tmp/private-source.jsonl
node scripts/migration/storage-cutover-plan.mjs --mode validate-source --source tmp/private-delta.jsonl --checkpoint tmp/private-checkpoint.json
```

Validate target evidence, build a checkpoint plan, or reconcile:

```bash
node scripts/migration/storage-cutover-plan.mjs --mode validate-target --target tmp/private-target.jsonl
node scripts/migration/storage-cutover-plan.mjs --mode checkpoint-plan --source tmp/private-source.jsonl --target tmp/private-target.jsonl
node scripts/migration/storage-cutover-plan.mjs --mode reconcile --source tmp/private-source.jsonl --target tmp/private-target.jsonl
```

For a delta plan, save the key-free checkpoint output to an ignored or external file, then provide it with the current private inventories. Pass the prior checkpoint to reconciliation and the next checkpoint plan when the source uses `RECORDED_DELTA`:

```bash
node scripts/migration/storage-cutover-plan.mjs --mode delta-plan --source tmp/private-source.jsonl --target tmp/private-target.jsonl --checkpoint tmp/private-checkpoint.json
```

The delta planner never overwrites blindly. New objects use a does-not-exist precondition. Changed objects and reviewed tombstones require the exact prior target generation. The checkpoint also binds the full target inventory digest and the aggregate signed-URL issuer evidence digest; both must match before a delta plan is produced. Missing or forged tombstones, changed target generations, untracked target objects, stale snapshots, evidence swaps, and unrecorded source deletions stop the plan.

## Read-only live inventory candidate

`migration/storage/supabase-storage-copy-policy.candidate.v1.json` is separate from the base contract. It keeps `executionActivated` and `copyExecutionAllowed` false. The collector is a no-network dry run unless `--allow-read-only-live` is present, and it is restricted to UAT project `hushh-tech-uat` in `us-central1`.

The partial-evidence collector records a fail-closed source bucket-set check and target namespace, configuration, Identity and Access Management, and inherited-policy reads without downloading source or target object bytes. Its raw provider responses stay in a private `0600` artifact. The sanitized artifact binds the raw file digest, one capture identifier and window, every raw-response digest, exact read method and endpoint class, HTTP or process status, required source public states, normalized target policy, and hashed unknown names and principals. It never proves signing, source-byte parity, or copy readiness.

Check the partial collector without making any provider request:

```bash
npm run migration:storage:partial
```

After explicit read-only authorization, capture both artifacts outside tracked paths:

```bash
npm run migration:storage:partial -- \
  --mode capture \
  --environment uat \
  --project hushh-tech-uat \
  --allow-read-only-live \
  --raw-output tmp/private-storage-partial-raw.json \
  --evidence-output tmp/private-storage-partial-evidence.json
```

Revalidate them using the exact file digests returned by capture:

```bash
npm run migration:storage:partial -- \
  --mode validate \
  --environment uat \
  --project hushh-tech-uat \
  --raw-capture tmp/private-storage-partial-raw.json \
  --raw-capture-file-digest-sha256 '<exact-raw-file-sha256>' \
  --evidence tmp/private-storage-partial-evidence.json \
  --evidence-file-digest-sha256 '<exact-evidence-file-sha256>'
```

An unknown live source bucket is always `SOURCE_UNKNOWN_BUCKET_REVIEW_REQUIRED`. Its identifier remains hash-only outside private evidence. Object metadata and aggregate traffic evidence must bind their exact capture windows, query and response digests, and file digests. Explicit ownership plus a reviewed migration-or-archive disposition is required before any source or target copy. The unknown bucket is not added to the frozen six-bucket contract and cannot be excluded by the collector.

Check the source collector without making a provider request:

```bash
npm run migration:storage:inventory -- --mode source
```

An authorized operator can create private, create-only source evidence after providing the existing server-side source credential through the process environment:

```bash
npm run migration:storage:inventory -- \
  --mode source \
  --environment uat \
  --project hushh-tech-uat \
  --allow-read-only-live \
  --output tmp/private-source-live.jsonl \
  --evidence-output tmp/private-source-live-evidence.json
```

The collector permits only `GET` requests plus the Supabase object-list `POST` contract. It performs two metadata passes and hashes bytes from the download stream. It accepts only the frozen six-bucket set and completes only at exactly 124 objects and 111,078,397 bytes. Source credentials, URLs, and object names are not written to console evidence.

After a reviewed checkpoint exists, the same read-only collector can emit the next complete `RECORDED_DELTA`. Both checkpoint arguments are required together and are verified before any provider read:

```bash
npm run migration:storage:inventory -- \
  --mode source \
  --environment uat \
  --project hushh-tech-uat \
  --allow-read-only-live \
  --previous-checkpoint tmp/private-checkpoint.json \
  --previous-checkpoint-file-digest-sha256 '<exact-checkpoint-file-sha256>' \
  --output tmp/private-source-delta.jsonl \
  --evidence-output tmp/private-source-delta-evidence.json
```

The delta binds the prior checkpoint and exact checkpoint-file digest, uses the next sequence and a new export run, rehashes every current object, and emits a typed tombstone for each prior object absent from both stable metadata passes. A prior tombstone cannot reappear. The source remains read-only.

Use the exact source file digest returned by that command to inspect the six UAT target buckets:

```bash
npm run migration:storage:inventory -- \
  --mode target \
  --environment uat \
  --project hushh-tech-uat \
  --allow-read-only-live \
  --source-inventory tmp/private-source-live.jsonl \
  --source-file-digest-sha256 '<exact-lowercase-sha256>' \
  --output tmp/private-target-preflight.json
```

For a `RECORDED_DELTA`, add the same exact `--previous-checkpoint` and `--previous-checkpoint-file-digest-sha256` pair. The target preflight will not accept a delta without both bindings.

The target preflight hashes unmanaged object names in its evidence and never emits them. It treats every object outside `_hushh_migrations/supabase-cutover-v1/` as unmanaged and read-only. This preserves the 563 unrelated objects already observed in `hushh-tech-community-content-uat`. Any unknown object inside the migration namespace, non-matching preexisting destination, unsafe bucket setting, or Identity and Access Management drift is a blocker.

The candidate destination mapping is deterministic and prefix-safe:

```text
_hushh_migrations/supabase-cutover-v1/<source-bucket>/<sha256(source-bucket + NUL + exact-UTF-8-source-key)>/<source-fingerprint-sha256>
```

The source fingerprint binds source bucket, exact key, bytes, MIME type, source timestamp, legacy cache directive, and SHA-256. An in-place source update therefore creates a different target name with `ifGenerationMatch=0`; it never overwrites the earlier immutable version. An unchanged version is an exact generation-bound no-op. A deletion retains every prior immutable version and produces only a typed database-pointer removal.

Source keys are bounded to 1,024 UTF-8 bytes, must round-trip exactly, and cannot contain dot segments. The private, version-stable target metadata retains the exact source key, source fingerprint, source timestamp, legacy cache directive, source SHA-256, and access mode. The copy/result evidence—not mutable object metadata—binds the exact source inventory, source artifact, checkpoint, preflight, plan, approval, and reviewed commit. Target serving cache control remains `private, no-store`.

Create a digest-bound review plan without writing to Google Cloud:

```bash
npm run migration:storage:copy -- \
  --source-inventory tmp/private-source-live.jsonl \
  --source-file-digest-sha256 '<exact-source-file-sha256>' \
  --target-preflight tmp/private-target-preflight.json \
  --target-preflight-file-digest-sha256 '<exact-preflight-file-sha256>' \
  --plan-output tmp/private-create-only-plan.json
```

For a delta, the plan command also requires the exact checkpoint path and file digest used by both collectors.

The plan contains only `CREATE_IF_ABSENT` actions with `ifGenerationMatch=0`, generation-bound `NOOP_PRESENT_EXACT` actions, or `RETAIN_TOMBSTONED_VERSIONS` actions that forbid target mutation and require a separate database-pointer removal. It contains no source keys, deletes, overwrites, or production path. Passing `--execute` currently fails with `COPY_EXECUTION_BLOCKED_PENDING_REVIEW` before reading artifacts or credentials or calling GitHub, Supabase, or Google Cloud.

Any later activation must be a separate reviewed change. It must bind the exact source, checkpoint (for deltas), preflight, plan, approval, pull request head, every pull-request commit author/committer, GitHub review, UAT project, and migration namespace; require a blocker-free fresh preflight; and retain create-only generation preconditions. The source download is hashed into an unlinked read-only file descriptor before any Google request, rehashed after resumable-session initiation, and sent with server-validated CRC32C and MD5 digests. The write primitive itself accepts only the six UAT buckets and the exact two-digest namespace.

The future activated path reserves a create-only private result file before its first target write. It then re-lists and rehashes the complete current source set, reconciles each current target generation and digest, rechecks every retained historical generation, and emits a digest-bound database-pointer manifest. For the frozen baseline this is 124 live source objects and 124 current target versions. A delta records live objects, typed tombstones, and retained immutable history separately; for example, one changed object plus one deletion remains 124 dispositions while producing 123 live pointers and 125 immutable target versions. No count-only result is accepted.

Supabase deletion and every production storage action remain outside this candidate.

## Secondary Supabase gates

The zero-dependency gate tracks exactly six references:

- `legacy-community-data`
- `kyc-client-runtime`
- `devops-webhook`
- `kyc-protocol-documentation`
- `legacy-metrics-project`
- `reports-market-storage`

Each entry requires ownership proof, runtime non-use proof, a clean reference scan, an evidence SHA-256, and one terminal disposition:

- `MIGRATED_AND_REFERENCE_REMOVED`
- `NON_USE_PROVEN_AND_REFERENCE_REMOVED`

Anything else fails closed.

## Signed access and archive plan

Private downloads are issued only by an allowlisted server service identity whose live evidence is bound into the target inventory. A signed URL allows only `GET` or `HEAD`, expires within 300 seconds, pins the exact object generation, uses a bucket/object allowlist, and forces `private, no-store`. Browser credentials are forbidden.

The later production archive remains planning-only here. It requires Cloud Key Management Service customer-managed encryption, object versioning, a successful restore drill, a locked 90-day retention period, and separate approval before deletion at expiry. The retention lock must not be applied until the restore evidence is complete because locking is irreversible.

## Required checks

```bash
npm run migration:storage:test
npx eslint scripts/migration/storage-cutover-contract.mjs scripts/migration/storage-cutover-plan.mjs scripts/migration/storage-live-common.mjs scripts/migration/storage-live-policy.mjs scripts/migration/storage-live-inventory.mjs scripts/migration/storage-readonly-partial-evidence.mjs scripts/migration/storage-copy-executor.mjs tests/storageCutoverPlan.test.ts tests/storageLiveCopy.test.ts tests/storageReadonlyPartialEvidence.test.ts
npx tsc --noEmit
git diff --check
```

These checks prove the offline contract and planner. They do not prove a live source export, a copied object, target bucket Identity and Access Management, a signed download, an archive restore, or production readiness.
