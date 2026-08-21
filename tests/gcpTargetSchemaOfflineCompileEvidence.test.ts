import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '../scripts/gcp/migration/canonical-hash.mjs';
import { validateTargetSchemaOfflineCompileEvidence } from '../scripts/gcp/migration/target-schema-compile-evidence.mjs';

const root = process.cwd();
const evidencePath = join(
  root,
  'migration/contracts/target-schema-offline-compile-evidence.v1.json',
);

function frozenEvidence() {
  return JSON.parse(readFileSync(evidencePath, 'utf8'));
}

function reseal(evidence: Record<string, unknown>) {
  const { evidenceSha256: _digest, ...envelope } = evidence;
  return { ...envelope, evidenceSha256: canonicalHash(envelope) };
}

describe('exact private-dump offline compile evidence', () => {
  it('validates the checked-in hash/count-only artifact', () => {
    const evidence = frozenEvidence();

    expect(validateTargetSchemaOfflineCompileEvidence(evidence)).toBe(true);
    expect(evidence.plan.phases).toHaveLength(7);
    expect(evidence.plan.execution.blockers).not.toContain(
      'REAL_DUMP_OFFLINE_COMPILE_REQUIRED',
    );
    expect(evidence.plan.execution).toMatchObject({
      mode: 'PLAN_ONLY',
      applyReady: false,
      liveConnectionsAvailable: false,
    });
  });

  it('rejects a paired source-binding and evidence-digest mutation', () => {
    const evidence = frozenEvidence();
    evidence.bindings.plaintextSha256 = '0'.repeat(64);

    expect(() => validateTargetSchemaOfflineCompileEvidence(reseal(evidence))).toThrow(
      expect.objectContaining({ code: 'OFFLINE_COMPILE_EVIDENCE_INVALID' }),
    );
  });

  it('rejects paired compressed-hash, byte-count, and evidence-digest forgery', () => {
    const evidence = frozenEvidence();
    evidence.bindings.compressedPlaintextSha256 = '2'.repeat(64);
    evidence.bindings.compressedPlaintextBytes += 1;

    expect(() => validateTargetSchemaOfflineCompileEvidence(reseal(evidence))).toThrow(
      expect.objectContaining({ code: 'OFFLINE_COMPILE_EVIDENCE_INVALID' }),
    );
  });

  it('rejects a paired phase and plan/evidence digest mutation', () => {
    const evidence = frozenEvidence();
    evidence.plan.phases[0].sha256 = '1'.repeat(64);
    const { planSha256: _planDigest, ...planEnvelope } = evidence.plan;
    evidence.plan.planSha256 = canonicalHash(planEnvelope);

    expect(() => validateTargetSchemaOfflineCompileEvidence(reseal(evidence))).toThrow(
      expect.objectContaining({ code: 'OFFLINE_COMPILE_EVIDENCE_INVALID' }),
    );
  });

  it('rejects path, raw SQL, and identity-shaped material', () => {
    const evidence = frozenEvidence();
    evidence.retention.retainedContents =
      'CREATE TABLE leaked (email text DEFAULT user@example.com) /private/tmp/leak';

    expect(() => validateTargetSchemaOfflineCompileEvidence(reseal(evidence))).toThrow();
  });
});
