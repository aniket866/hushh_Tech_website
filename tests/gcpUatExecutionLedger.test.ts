import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '../scripts/gcp/migration/canonical-hash.mjs';
import {
  buildPinnedUatExecutionLedger,
  validateUatExecutionLedger,
} from '../scripts/gcp/migration/validate-uat-execution-ledger.mjs';

const ledgerPath = new URL('../migration/contracts/uat-schema-data-execution-ledger.v1.json', import.meta.url);

function ledgerInput() {
  return JSON.parse(readFileSync(ledgerPath, 'utf8'));
}

function rehash(ledger: Record<string, any>) {
  const payload = structuredClone(ledger);
  delete payload.ledgerSha256;
  ledger.ledgerSha256 = canonicalHash(payload);
  return ledger;
}

describe('immutable UAT schema/data live execution ledger', () => {
  it('reproduces and accepts the exact 22-operation retained artifact', () => {
    const ledger = ledgerInput();
    expect(ledger).toEqual(buildPinnedUatExecutionLedger());
    expect(validateUatExecutionLedger(ledger)).toBe(ledger);
    expect(ledger.cloudSqlOperations.filter((operation: any) => operation.sqlOutcome === 'COMMITTED')).toHaveLength(11);
    expect(ledger.cloudSqlOperations.filter((operation: any) => operation.sqlOutcome === 'ROLLED_BACK')).toHaveLength(11);
    expect(ledger.recovery).toMatchObject({ rollbackReady: false, exactPreApplyRestoreLocator: null });
  });

  it('rejects an object-generation substitution even after the ledger is rehashed', () => {
    const ledger = ledgerInput();
    ledger.cloudSqlOperations[10].object.generation = '1787362075002262';
    expect(() => validateUatExecutionLedger(rehash(ledger))).toThrow('EXECUTION_LEDGER_OPERATION_EVIDENCE_MISMATCH');
  });

  it('rejects changing a rolled-back phase into a commit', () => {
    const ledger = ledgerInput();
    ledger.cloudSqlOperations[18].sqlOutcome = 'COMMITTED';
    ledger.cloudSqlOperations[18].blockerCode = null;
    expect(() => validateUatExecutionLedger(rehash(ledger))).toThrow('EXECUTION_LEDGER_OPERATION_EVIDENCE_MISMATCH');
  });

  it('rejects dropping failed history while keeping successful phases', () => {
    const ledger = ledgerInput();
    ledger.cloudSqlOperations.splice(0, 1);
    expect(() => validateUatExecutionLedger(rehash(ledger))).toThrow('EXECUTION_LEDGER_INVALID');
  });

  it('rejects a substituted retained bundle object with a self-consistent ledger digest', () => {
    const ledger = ledgerInput();
    ledger.retainedFutureReplayBundle.objects[5].sha256 = canonicalHash({ replacement: true });
    expect(() => validateUatExecutionLedger(rehash(ledger))).toThrow('EXECUTION_LEDGER_RETAINED_BUNDLE_INVALID');
  });

  it('rejects promoting point-in-time recovery capability into a rollback claim', () => {
    const ledger = ledgerInput();
    ledger.recovery.rollbackReady = true;
    ledger.recovery.restoreProcedureBound = true;
    ledger.recovery.exactPreApplyRestoreTimestamp = '2026-08-22T00:29:50.337131Z';
    expect(() => validateUatExecutionLedger(rehash(ledger))).toThrow('EXECUTION_LEDGER_RECOVERY_CLAIM_INVALID');
  });

  it('rejects identity mapping or post-verifier evidence replacement', () => {
    const identityLedger = ledgerInput();
    identityLedger.identityExecution.mappingSha256 = canonicalHash({ replacement: true });
    expect(() => validateUatExecutionLedger(rehash(identityLedger))).toThrow('EXECUTION_LEDGER_EVIDENCE_BINDING_MISMATCH');

    const verifierLedger = ledgerInput();
    verifierLedger.postApplyVerification.identityMappingSha256 = canonicalHash({ replacement: true });
    expect(() => validateUatExecutionLedger(rehash(verifierLedger))).toThrow('EXECUTION_LEDGER_EVIDENCE_BINDING_MISMATCH');
  });

  it('rejects any stale outer ledger digest', () => {
    const ledger = ledgerInput();
    ledger.cleanup.retainedFutureReplayObjects = 7;
    expect(() => validateUatExecutionLedger(ledger)).toThrow('EXECUTION_LEDGER_CLEANUP_INVALID');
  });
});
