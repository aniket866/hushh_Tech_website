# Supabase Storage Cutover Foundation

This foundation describes the offline, fail-closed storage migration contract for issue #1950. It does not connect to Supabase or Google Cloud, copy or delete objects, create signed URLs, or enable production execution.

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

The tombstone must match the prior fingerprint and current evidence/artifact. Missing, unknown, duplicated, forged, replayed, or resurrected objects stop delta planning, checkpointing, and reconciliation. A target-present tombstone produces only a dry-run generation-matched delete action; a target-absent tombstone produces a no-op.

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
npx eslint scripts/migration/storage-cutover-contract.mjs scripts/migration/storage-cutover-plan.mjs tests/storageCutoverPlan.test.ts
npx tsc --noEmit
git diff --check
```

These checks prove the offline contract and planner. They do not prove a live source export, a copied object, target bucket Identity and Access Management, a signed download, an archive restore, or production readiness.
