import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '../scripts/gcp/migration/canonical-hash.mjs';
import {
  PINNED_CANDIDATE_EVIDENCE_SHA256,
  validateUatCandidateEvidence,
} from '../scripts/gcp/migration/validate-uat-candidate-evidence.mjs';

const evidencePath = new URL('../migration/contracts/uat-schema-data-candidate-evidence.v2.json', import.meta.url);

function evidenceInput() {
  return JSON.parse(readFileSync(evidencePath, 'utf8'));
}

function rehashOuter(evidence: Record<string, any>) {
  const unsigned = structuredClone(evidence);
  delete unsigned.evidenceSha256;
  evidence.evidenceSha256 = canonicalHash(unsigned);
  return evidence;
}

function rehashMainLog(evidence: Record<string, any>) {
  const payload = evidence.deployment.mainLog.entry.jsonPayload;
  const unsignedPayload = structuredClone(payload);
  delete unsignedPayload.evidenceSha256;
  payload.evidenceSha256 = canonicalHash(unsignedPayload);
  evidence.deployment.mainLog.entrySha256 = canonicalHash(evidence.deployment.mainLog.entry);
  return rehashOuter(evidence);
}

function validateRehashed(evidence: Record<string, any>) {
  return validateUatCandidateEvidence(evidence, {
    expectedEvidenceSha256: evidence.evidenceSha256,
    expectedMainLogSha256: evidence.deployment.mainLog.entrySha256,
    expectedDiagnosticLogSha256: evidence.deployment.runtimeDiagnosticLog.entrySha256,
    expectedVerifierPayloadSha256: evidence.deployment.mainLog.entry.jsonPayload.evidenceSha256,
  });
}

describe('complete UAT schema/data candidate evidence', () => {
  it('accepts the complete immutable clean-build and live verifier artifact', () => {
    const evidence = evidenceInput();
    expect(evidence.evidenceSha256).toBe(PINNED_CANDIDATE_EVIDENCE_SHA256);
    expect(validateUatCandidateEvidence(evidence)).toBe(evidence);
    expect(evidence.deployment.mainLog.entry.jsonPayload.tableParity).toHaveLength(70);
    expect(evidence.verifierBuild.context.files).toHaveLength(6);
    expect(evidence.deployment.mainLog.entry.jsonPayload.access.engagementRuntime).toMatchObject({
      ready: true,
      executable_application_routine_count: 164,
      executable_procedure_count: 0,
      executable_security_definer_routine_count: 0,
    });
  });

  it('rejects a same-count key digest swap after every mutable envelope is rehashed', () => {
    const evidence = evidenceInput();
    const tables = evidence.deployment.mainLog.entry.jsonPayload.tableParity;
    [tables[0].keySha256, tables[2].keySha256] = [tables[2].keySha256, tables[0].keySha256];
    evidence.deployment.mainLog.entry.jsonPayload.tableParitySha256 = canonicalHash(tables);
    expect(() => validateRehashed(rehashMainLog(evidence))).toThrow('CANDIDATE_TABLE_PARITY_MISMATCH');
  });

  it('rejects a same-count substituted row and key set with self-consistent hashes', () => {
    const evidence = evidenceInput();
    const tables = evidence.deployment.mainLog.entry.jsonPayload.tableParity;
    tables[0].rowSha256 = canonicalHash({ substitutedRows: tables[0].rowCount });
    tables[0].keySha256 = canonicalHash({ substitutedKeys: tables[0].rowCount });
    evidence.deployment.mainLog.entry.jsonPayload.tableParitySha256 = canonicalHash(tables);
    expect(() => validateRehashed(rehashMainLog(evidence))).toThrow('CANDIDATE_TABLE_PARITY_MISMATCH');
  });

  it('rejects a drop-and-duplicate table substitution that preserves 70 entries', () => {
    const evidence = evidenceInput();
    const tables = evidence.deployment.mainLog.entry.jsonPayload.tableParity;
    tables.splice(0, 1);
    tables.push(structuredClone(tables.at(-1)));
    evidence.deployment.mainLog.entry.jsonPayload.tableParitySha256 = canonicalHash(tables);
    expect(() => validateRehashed(rehashMainLog(evidence))).toThrow('CANDIDATE_TABLE_PARITY_MISMATCH');
  });

  it('rejects a substituted NDA object generation after the outer digest is refreshed', () => {
    const evidence = evidenceInput();
    evidence.ndaBoundaryOperation.object.generation = '1787367841243087';
    expect(() => validateRehashed(rehashOuter(evidence))).toThrow('CANDIDATE_NDABOUNDARYOPERATION_MISMATCH');
  });

  it('rejects a build image substitution after the outer digest is refreshed', () => {
    const evidence = evidenceInput();
    evidence.verifierBuild.image.digest = `sha256:${canonicalHash({ replacement: true })}`;
    expect(() => validateRehashed(rehashOuter(evidence))).toThrow('CANDIDATE_VERIFIERBUILD_MISMATCH');
  });

  it('rejects enabling the mutation job after the outer digest is refreshed', () => {
    const evidence = evidenceInput();
    evidence.mutationSafety.identityMigrationJob.env.find((entry: any) => entry.name === 'EXECUTION_MODE').value = 'IMPORT';
    expect(() => validateRehashed(rehashOuter(evidence))).toThrow('CANDIDATE_MUTATIONSAFETY_MISMATCH');
  });

  it('rejects adding a trigger reference after the inventory and outer digests are refreshed', () => {
    const evidence = evidenceInput();
    const scheduler = evidence.mutationSafety.triggerInventory.cloudScheduler;
    scheduler.jobs.push({
      name: 'projects/hushh-tech-uat/locations/us-central1/jobs/unsafe',
      region: 'us-central1',
      state: 'ENABLED',
      description: null,
      httpUri: 'https://run.googleapis.com/v2/projects/hushh-tech-uat/locations/us-central1/jobs/hushh-tech-identity-migration-uat:run',
      pubsubTopic: null,
      appEngineRelativeUri: null,
      schedule: '* * * * *',
      timeZone: 'UTC',
    });
    scheduler.directMigrationJobReferenceCount = 1;
    scheduler.inventorySha256 = canonicalHash(scheduler.jobs);
    expect(() => validateRehashed(rehashOuter(evidence))).toThrow('CANDIDATE_MUTATIONSAFETY_MISMATCH');
  });

  it('rejects any stale outer evidence digest', () => {
    const evidence = evidenceInput();
    evidence.cleanup.temporaryVerifierTagCount = 1;
    expect(() => validateUatCandidateEvidence(evidence)).toThrow('CANDIDATE_EVIDENCE_DIGEST_MISMATCH');
  });
});
