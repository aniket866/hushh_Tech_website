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
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));

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
  it('validates the exact sanitized partial attestation', () => {
    expect(validateTargetCloudSqlAttestation(evidence)).toEqual({
      valid: true,
      state: 'LIVE_READ_ONLY_PARTIAL_ATTESTATION',
      catalogStatus: 'BLOCKED',
      blockerCount: 7,
      evidenceSha256: '2150e0ad204b6fd3e4e87697772a882b07b0a1bebdcd137e68f453fc945ae238',
    });
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
