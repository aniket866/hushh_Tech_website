import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '../scripts/gcp/migration/canonical-hash.mjs';
import { validateTargetCloudSqlAttestation } from '../scripts/gcp/migration/target-cloudsql-attestation-evidence.mjs';

const evidencePath = new URL(
  '../migration/contracts/uat-cloudsql-readonly-attestation.v1.json',
  import.meta.url,
);
const queryPath = new URL(
  '../migration/sql/target_cloudsql_attestation_read_only.sql',
  import.meta.url,
);
const historicalSourceCompileEvidencePath = new URL(
  '../migration/contracts/history/pr-1965-target-schema-offline-compile-evidence.v1.json',
  import.meta.url,
);
const currentSourceCompileEvidencePath = new URL(
  '../migration/contracts/target-schema-offline-compile-evidence.v1.json',
  import.meta.url,
);
const historicalSourceCompileEvidenceSha256 =
  '3b5d53544710bd8e41f870667bed1fb645f539341be82819470c0078bf7cf666';
const currentSourceCompileEvidenceSha256 =
  'c19dc15529429983ac2068c26468f9d4060417d903059031dc4725a13f66aa6e';
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function cloneEvidence() {
  return structuredClone(evidence);
}

function rehash(candidate: Record<string, unknown>) {
  const payload = structuredClone(candidate);
  delete payload.evidenceSha256;
  candidate.evidenceSha256 = canonicalHash(payload);
  return candidate;
}

function expectFailureCode(candidate: Record<string, unknown>, code: string) {
  try {
    validateTargetCloudSqlAttestation(candidate);
    throw new Error('expected validation to fail');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('fail-closed UAT Cloud SQL attestation evidence', () => {
  it('preserves the exact PR 1965 compile evidence separately from the composed compiler evidence', () => {
    expect(sha256(readFileSync(historicalSourceCompileEvidencePath))).toBe(
      historicalSourceCompileEvidenceSha256,
    );
    expect(sha256(readFileSync(currentSourceCompileEvidencePath))).toBe(
      currentSourceCompileEvidenceSha256,
    );
    expect(currentSourceCompileEvidenceSha256).not.toBe(historicalSourceCompileEvidenceSha256);
  });

  it('validates the exact sanitized partial attestation', () => {
    expect(validateTargetCloudSqlAttestation(evidence)).toEqual({
      valid: true,
      state: 'LIVE_READ_ONLY_PARTIAL_ATTESTATION',
      catalogStatus: 'BLOCKED',
      blockerCount: 7,
      evidenceSha256: '66d4bbd24ecf1af4cd4b3b4fb7cb841252a7af9678c09a5de8dbaef81ed8be82',
    });
  });

  it('rejects the old mutable source path even with the historical digest', () => {
    const candidate = cloneEvidence();
    candidate.compileBlockerDisposition.source =
      'migration/contracts/target-schema-offline-compile-evidence.v1.json';
    candidate.compileBlockerDisposition.sourceSha256 = historicalSourceCompileEvidenceSha256;
    expectFailureCode(rehash(candidate), 'SOURCE_COMPILE_EVIDENCE_DRIFT');
  });

  it('rejects an unknown compile-evidence digest at the immutable historical path', () => {
    const candidate = cloneEvidence();
    candidate.compileBlockerDisposition.sourceSha256 = '0'.repeat(64);
    expectFailureCode(rehash(candidate), 'SOURCE_COMPILE_EVIDENCE_DRIFT');
  });

  it('rejects the current composed compiler digest as a rewrite of the PR 1965 attestation', () => {
    const candidate = cloneEvidence();
    candidate.compileBlockerDisposition.sourceSha256 = currentSourceCompileEvidenceSha256;
    expectFailureCode(rehash(candidate), 'SOURCE_COMPILE_EVIDENCE_DRIFT');
  });

  it('locks the target to the exact UAT project, instance, database, region, and PG17', () => {
    const candidate = cloneEvidence();
    candidate.target.project = 'hushh-tech-prod';
    expectFailureCode(rehash(candidate), 'TARGET_ATTESTATION_BOUNDARY');
  });

  it('rejects a self-rehashed zero instance Admin API digest', () => {
    const candidate = cloneEvidence();
    candidate.cloudSqlAdminApi.instanceCanonicalSha256 = '0'.repeat(64);
    expectFailureCode(rehash(candidate), 'TARGET_ADMIN_API_DIGEST_DRIFT');
  });

  it('rejects a self-rehashed forged database-inventory Admin API digest', () => {
    const candidate = cloneEvidence();
    candidate.cloudSqlAdminApi.databaseInventoryCanonicalSha256 = '1'.repeat(64);
    expectFailureCode(rehash(candidate), 'TARGET_ADMIN_API_DIGEST_DRIFT');
  });

  it('rejects a self-rehashed forged IAM-database-user Admin API digest', () => {
    const candidate = cloneEvidence();
    candidate.cloudSqlAdminApi.iamDatabaseUsersCanonicalSha256 = '2'.repeat(64);
    expectFailureCode(rehash(candidate), 'TARGET_ADMIN_API_DIGEST_DRIFT');
  });

  it('rejects a forged catalog row count or digest while capture is blocked', () => {
    const candidate = cloneEvidence();
    candidate.catalogAttestation.collections[1] = {
      name: 'schemas',
      status: 'CAPTURED',
      rowCount: 0,
      sha256: '0'.repeat(64),
    };
    expectFailureCode(rehash(candidate), 'FALSE_CATALOG_CLAIM');
  });

  it('keeps all seven PR 1965 blockers open', () => {
    const candidate = cloneEvidence();
    candidate.compileBlockerDisposition.closedByThisAttestation = [
      'LIVE_TARGET_ATTESTATION_REQUIRED',
    ];
    candidate.compileBlockerDisposition.remaining =
      candidate.compileBlockerDisposition.remaining.filter(
        (entry: string) => entry !== 'LIVE_TARGET_ATTESTATION_REQUIRED',
      );
    expectFailureCode(rehash(candidate), 'INVALID_TARGET_ATTESTATION');
  });

  it('rejects a false transaction-read-only or target-emptiness claim', () => {
    const candidate = cloneEvidence();
    candidate.catalogAttestation.transactionReadOnlyObserved = true;
    candidate.catalogAttestation.targetEmptyAndSafe = 'PROVEN_EMPTY';
    expectFailureCode(rehash(candidate), 'FALSE_CATALOG_CLAIM');
  });

  it('locks the reviewed audit identity and its existing Cloud SQL roles without executing it', () => {
    const candidate = cloneEvidence();
    candidate.reviewedInVpcRemedy.cloudSqlInstanceUser = false;
    expectFailureCode(rehash(candidate), 'UNSAFE_IN_VPC_REMEDY');
  });

  it('rejects a different principal even when the root hash is recomputed', () => {
    const candidate = cloneEvidence();
    candidate.reviewedInVpcRemedy.iamDatabaseUsername = 'other@example.invalid';
    expectFailureCode(rehash(candidate), 'UNSAFE_IN_VPC_REMEDY');
  });

  it('binds the root hash over every sanitized evidence field', () => {
    const candidate = cloneEvidence();
    candidate.cleanup.verifiedAt = '2026-08-21T20:47:38Z';
    expectFailureCode(candidate, 'TARGET_ATTESTATION_HASH_MISMATCH');
  });

  it('keeps the SQL transaction repeatable-read, read-only, time-bounded, and rollback-only', () => {
    const query = readFileSync(queryPath, 'utf8');
    expect(query).toContain('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;');
    expect(query).toContain("SET LOCAL statement_timeout = '10s';");
    expect(query).toContain("SET LOCAL lock_timeout = '1s';");
    expect(query).toContain("SET LOCAL idle_in_transaction_session_timeout = '15s';");
    expect(query.trimEnd().endsWith('ROLLBACK;')).toBe(true);
    expect(query).not.toMatch(/(^|\n)\s*COMMIT\s*;/i);
  });

  it('contains no endpoint, private IP, credential, or unreviewed full principal', () => {
    const serialized = JSON.stringify(evidence).replaceAll(
      'hushh-tech-audit-uat@hushh-tech-uat.iam',
      'REVIEWED_AUDIT_DB_USERNAME',
    );
    expect(serialized).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(serialized).not.toMatch(/\b(?:postgres(?:ql)?|https?|wss?):\/\//i);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});
