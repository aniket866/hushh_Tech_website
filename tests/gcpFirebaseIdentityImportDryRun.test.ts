import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '../scripts/gcp/migration/canonical-hash.mjs';
import {
  SOURCE_CONTRACT,
  assertMigrationBoundary,
  safeJsonForStdout,
} from '../scripts/gcp/migration/contract.mjs';
import {
  FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT,
  buildFirebaseIdentityImportDryRunPlan,
  firebaseIdentityImportDryRunSummary,
  validateFirebaseIdentityImportDryRunPlan,
} from '../scripts/gcp/migration/firebase-import-plan.mjs';
import { validateTerminalDispositions } from '../scripts/gcp/migration/identity-mapping.mjs';
import {
  assertProtectedInputOwnershipAndMode,
  assertProtectedInputSnapshotUnchanged,
  readProtectedJsonFile,
} from '../scripts/gcp/migration/protected-json-input.mjs';

const root = process.cwd();
type MappingHashRow = { legacyUserUuid: string } & Record<string, unknown>;
type MappingPlanForHash = {
  mappingOutputHash: string;
  authMappings: MappingHashRow[];
  unclaimedMappings: MappingHashRow[];
};
type MutableReloginPolicy = Record<string, unknown> & {
  epoch: string;
  firebaseGlobalRevocationAllowed: boolean;
  productBinding: string;
  researchSessionRevocationAllowed: boolean;
};
type MutableRollbackPolicy = Record<string, unknown> & {
  createdUidDeletionAllowed: boolean;
};
type MutableFutureExecutorGates = Record<string, unknown> & {
  satisfiedByDryRun: boolean;
};
type MutableDryRunPlan = Record<string, unknown> & {
  blockers: string[];
  counts: { importedFirebase: number };
  firebaseImportBatches: Array<{ rowCount: number }>;
  firebaseImportRecords: Array<{ mappingBasis: string }>;
  futureExecutorGates: MutableFutureExecutorGates;
  futureExecutorGatesHash: string;
  policyContractHash: string;
  relogin: MutableReloginPolicy;
  reloginPolicyHash: string;
  rollback: MutableRollbackPolicy;
  rollbackPolicyHash: string;
};
const providerSubject = (index: number) =>
  index < 165
    ? `existing-provider-subject-${index}`
    : `new-provider-subject-${index}`;
const providerFingerprint = (providerId: string, subject: string) =>
  createHash('sha256')
    .update(`${providerId}\u0000${subject}`, 'utf8')
    .digest('hex');
const providerEvidence = (index: number) =>
  providerFingerprint('google.com', providerSubject(index));

function legacyUuid(index: number) {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function uatBoundary() {
  return assertMigrationBoundary({
    environment: 'uat',
    sourceProjectRef: 'ibsisfnjxeowvdtvgzff',
    sourceDatabase: 'postgres',
    targetProject: 'hushh-tech-uat',
    targetRegion: 'us-central1',
    targetInstance: 'hushh-tech-app-pg-uat',
    targetDatabase: 'hushh_tech_app',
    postgresMajor: 17,
    dryRun: true,
  });
}

function refreshMappingOutputHash(mappingPlan: MappingPlanForHash) {
  const byLegacyUuid = (left: MappingHashRow, right: MappingHashRow) =>
    left.legacyUserUuid.localeCompare(right.legacyUserUuid);
  mappingPlan.mappingOutputHash = canonicalHash({
    authMappings: [...mappingPlan.authMappings].sort(byLegacyUuid),
    unclaimedMappings: [...mappingPlan.unclaimedMappings].sort(byLegacyUuid),
  });
}

function syntheticDryRunInputs() {
  const authMappings = Array.from({ length: 369 }, (_, index) => {
    const linked = index < 165;
    const appleWithoutEmail = index >= 165 && index < 168;
    const emailSignInUser = index >= 168 && index < 172;
    const hasProviderEvidence = !emailSignInUser;
    return {
      legacyProject: 'ibsisfnjxeowvdtvgzff',
      legacyUserUuid: legacyUuid(index + 1),
      providerEvidenceHashes: hasProviderEvidence ? [providerEvidence(index)] : [],
      emailWasUsed: false,
      emailPresent: !appleWithoutEmail,
      appleNoEmail: appleWithoutEmail,
      isEmailPasswordUser: emailSignInUser,
      passwordAction: emailSignInUser
        ? index < 170
          ? 'IMPORT_BCRYPT'
          : 'PASSWORD_SETUP_REQUIRED'
        : 'NOT_APPLICABLE',
      terminal: true,
      firebaseUid: linked ? `existing_firebase_${index}` : `ht_test_${index}`,
      status: linked ? 'LINKED_EXISTING_FIREBASE' : 'IMPORTED_FIREBASE',
      mappingBasis: emailSignInUser ? 'LEGACY_UUID' : 'PROVIDER_SUBJECT',
      accessAllowed: true,
    };
  });
  const unclaimedMappings = Array.from({ length: 65 }, (_, index) => ({
    legacyProject: 'ibsisfnjxeowvdtvgzff',
    legacyUserUuid: legacyUuid(1000 + index),
    firebaseUid: null,
    status: 'UNCLAIMED_LEGACY_PRINCIPAL',
    mappingBasis: 'UNCLAIMED',
    emailWasUsed: false,
    accessAllowed: false,
    terminal: true,
  }));
  const mappingPlan = {
    version: 1,
    mode: 'DRY_RUN',
    sourceInventoryHash: canonicalHash({ sourceInventory: 369 }),
    mappingInputHash: canonicalHash({ providerMapping: 165, imports: 204 }),
    mappingOutputHash: canonicalHash({ authMappings, unclaimedMappings }),
    authMappings,
    unclaimedMappings,
  };
  const firebaseAuthority = {
    projectId: 'hushh-pda',
    tenantId: null,
    users: Array.from({ length: 165 }, (_, index) => ({
      firebaseUid: `existing_firebase_${index}`,
      providerSubjects: [
        { providerId: 'google.com', subject: providerSubject(index) },
      ],
    })),
  };
  const calendarEvidence = {
    version: 1,
    sourceProjectRef: 'ibsisfnjxeowvdtvgzff',
    contents: 'SANITIZED_RECONNECT_FLAGS_ONLY',
    users: Array.from({ length: 369 }, (_, index) => ({
      legacyUserUuid: legacyUuid(index + 1),
      reconnectRequired: index % 10 === 0,
    })),
  };
  return {
    mappingPlan,
    firebaseAuthority,
    calendarEvidence,
    boundary: uatBoundary(),
    reloginEpoch: '2026-08-22T00:00:00Z',
  };
}

describe('Firebase identity import dry-run contract', () => {
  it('locks the authority, aggregate evidence, payload schema, and execution ban', () => {
    expect(SOURCE_CONTRACT.firebaseIdentityImportDryRunContractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.authority).toEqual({
      projectId: 'hushh-pda',
      tenantId: null,
      issuer: 'https://securetoken.google.com/hushh-pda',
      audience: 'hushh-pda',
      productId: 'hushh-tech',
    });
    expect(FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.lockedDispositions).toEqual({
      authUsers: 369,
      linkedExistingFirebase: 165,
      importedFirebase: 204,
      appleWithoutEmail: 3,
      emailSignInUsers: 4,
      unclaimedLegacyPrincipals: 65,
      emailOnlyLinks: 0,
    });
    expect(FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.execution).toEqual({
      mode: 'DRY_RUN',
      executionEnabled: false,
      liveSourceReads: false,
      firebaseAdminReads: false,
      firebaseAdminWrites: false,
      gcpWrites: false,
      productionMutations: false,
    });
    expect(
      FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.firebaseAdminImportSchema
        .recordRequiredKeys,
    ).toEqual(['uid', 'emailVerified', 'disabled']);
    expect(
      FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.firebaseAdminImportSchema
        .protectedRuntimeOnlyFields,
    ).toContain('passwordHash');
    expect(
      FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.firebaseAdminImportSchema
        .repositoryPayloadStorage,
    ).toBe('FORBIDDEN');
    expect(FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.relogin).toEqual({
      scope: 'HUSHH_TECH_PRODUCT_ONLY',
      productBinding: 'hushh-tech',
      enforcement: 'SERVER_AUTH_TIME_CUTOFF',
      epochFormat: 'RFC3339_UTC_SECONDS',
      firebaseGlobalRevocationAllowed: false,
      researchSessionRevocationAllowed: false,
    });
    expect(FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.futureExecutorGates).toEqual({
      freshFirebaseAuthorityRead: 'REQUIRED',
      uidCollisionCheck: 'REQUIRED_IMMEDIATELY_BEFORE_EACH_BATCH',
      providerOwnershipCheck: 'REQUIRED_IMMEDIATELY_BEFORE_EACH_BATCH',
      maximumEvidenceAgeSeconds: 300,
      satisfiedByDryRun: false,
    });
    expect(FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.blockers).toContain(
      'FRESH_LIVE_UID_COLLISION_PREFLIGHT_REQUIRED',
    );
  });

  it('contains no Firebase executor or network client', () => {
    const implementation = [
      'scripts/gcp/migration/firebase-import-plan.mjs',
      'scripts/gcp/migration/plan-firebase-identity-import.mjs',
    ]
      .map((path) => readFileSync(join(root, path), 'utf8'))
      .join('\n');
    expect(implementation).not.toMatch(/from\s+['"]firebase-admin/);
    expect(implementation).not.toMatch(/\.importUsers\s*\(/);
    expect(implementation).not.toMatch(/\bfetch\s*\(/);
    expect(implementation).not.toMatch(/https?\.request\s*\(/);
  });
});

describe('deterministic Firebase identity import plan', () => {
  it('produces exact 369/165/204/3/4/65 results and bounded checkpoints', () => {
    const plan = buildFirebaseIdentityImportDryRunPlan(syntheticDryRunInputs());
    expect(validateTerminalDispositions(syntheticDryRunInputs().mappingPlan)).toMatchObject({
      authTerminalCount: 369,
      linkedExistingFirebase: 165,
      importedFirebase: 204,
      appleNoEmail: 3,
      emailPasswordUsers: 4,
      unclaimedLegacyPrincipals: 65,
      emailOnlyLinks: 0,
    });
    expect(plan.counts).toEqual({
      authTerminalCount: 369,
      linkedExistingFirebase: 165,
      importedFirebase: 204,
      manualRecovery: 0,
      legallyRetainedNoLogin: 0,
      intentionallyDeleted: 0,
      appleWithoutEmail: 3,
      emailSignInUsers: 4,
      emailOnlyLinks: 0,
      unclaimedLegacyPrincipals: 65,
      firebaseImportRecords: 204,
      bcryptMetadataUsers: 2,
      setupRequiredUsers: 2,
      calendarReconnectUsers: 37,
    });
    expect(plan.dispositionBatches.map(({ rowCount }) => rowCount)).toEqual([
      100,
      100,
      100,
      69,
    ]);
    expect(plan.firebaseImportBatches.map(({ rowCount }) => rowCount)).toEqual([
      100,
      100,
      4,
    ]);
    expect(plan.unclaimedRecords).toHaveLength(65);
    expect(plan.unclaimedRecords.every(({ firebaseImportAllowed }) => !firebaseImportAllowed)).toBe(
      true,
    );
    expect(plan.relogin).toEqual({
      scope: 'HUSHH_TECH_PRODUCT_ONLY',
      productBinding: 'hushh-tech',
      enforcement: 'SERVER_AUTH_TIME_CUTOFF',
      epoch: '2026-08-22T00:00:00Z',
      firebaseGlobalRevocationAllowed: false,
      researchSessionRevocationAllowed: false,
    });
    expect(plan.rollback).toMatchObject({
      mode: 'DRY_RUN_NO_MUTATION',
      createdUidCandidateCount: 204,
      existingLinkedUidDeletionAllowed: false,
      createdUidDeletionAllowed: false,
      evidenceWriteMode: 'UNAVAILABLE_IN_DRY_RUN',
    });
    expect(plan.reloginPolicyHash).toBe(canonicalHash(plan.relogin));
    expect(plan.rollbackPolicyHash).toBe(canonicalHash(plan.rollback));
    expect(plan.futureExecutorGatesHash).toBe(canonicalHash(plan.futureExecutorGates));
    expect(plan.futureExecutorGates.satisfiedByDryRun).toBe(false);
    expect(validateFirebaseIdentityImportDryRunPlan(plan)).toMatchObject({
      valid: true,
      dispositionBatchCount: 4,
      firebaseImportBatchCount: 3,
    });
  });

  it('is order-independent and binds the product-local re-login epoch', () => {
    const firstInputs = syntheticDryRunInputs();
    const first = buildFirebaseIdentityImportDryRunPlan(firstInputs);
    const reorderedInputs = syntheticDryRunInputs();
    reorderedInputs.mappingPlan.authMappings.reverse();
    reorderedInputs.mappingPlan.unclaimedMappings.reverse();
    reorderedInputs.firebaseAuthority.users.reverse();
    reorderedInputs.calendarEvidence.users.reverse();
    const reordered = buildFirebaseIdentityImportDryRunPlan(reorderedInputs);
    expect(reordered.replayKey).toBe(first.replayKey);
    expect(reordered.dispositionBatches).toEqual(first.dispositionBatches);
    expect(reordered.firebaseImportBatches).toEqual(first.firebaseImportBatches);

    const changedEpoch = buildFirebaseIdentityImportDryRunPlan({
      ...syntheticDryRunInputs(),
      reloginEpoch: '2026-08-22T00:00:01Z',
    });
    expect(changedEpoch.replayKey).not.toBe(first.replayKey);
  });

  it('keeps identity rows and sensitive import values out of standard output', () => {
    const plan = buildFirebaseIdentityImportDryRunPlan(syntheticDryRunInputs());
    const output = safeJsonForStdout(firebaseIdentityImportDryRunSummary(plan));
    expect(output).toContain('"authTerminalCount": 369');
    expect(output).toContain('"executionEnabled": false');
    expect(output).not.toContain(legacyUuid(1));
    expect(output).not.toContain('existing_firebase_0');
    expect(output).not.toContain('existing-provider-subject-0');
    expect(output).not.toContain('passwordHash');
    expect(output).not.toContain('$2a$');
    expect(output).not.toContain('refreshToken');
  });
});

describe('Firebase identity dry-run adversarial rejection', () => {
  it('rejects issuer, audience, tenant, and product drift', () => {
    const inputs = syntheticDryRunInputs();
    for (const authority of [
      { ...FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.authority, issuer: 'https://evil.test' },
      { ...FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.authority, audience: 'other' },
      { ...FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.authority, tenantId: 'tenant-a' },
      { ...FIREBASE_IDENTITY_IMPORT_DRY_RUN_CONTRACT.authority, productId: 'hushh-research' },
    ]) {
      expect(() => buildFirebaseIdentityImportDryRunPlan({ ...inputs, authority })).toThrow(
        expect.objectContaining({ code: 'FIREBASE_AUTHORITY_BINDING_MISMATCH' }),
      );
    }
  });

  it('rejects provider-subject, existing UID, and generated UID collisions', () => {
    const duplicateProvider = syntheticDryRunInputs();
    duplicateProvider.firebaseAuthority.users[1].providerSubjects = [
      { ...duplicateProvider.firebaseAuthority.users[0].providerSubjects[0] },
    ];
    expect(() => buildFirebaseIdentityImportDryRunPlan(duplicateProvider)).toThrow(
      expect.objectContaining({ code: 'DUPLICATE_FIREBASE_PROVIDER_SUBJECT' }),
    );

    const missingExisting = syntheticDryRunInputs();
    missingExisting.mappingPlan.authMappings[0].firebaseUid = 'missing_existing_uid';
    refreshMappingOutputHash(missingExisting.mappingPlan);
    expect(() => buildFirebaseIdentityImportDryRunPlan(missingExisting)).toThrow(
      expect.objectContaining({ code: 'EXISTING_FIREBASE_UID_NOT_FOUND' }),
    );

    const generatedCollision = syntheticDryRunInputs();
    generatedCollision.mappingPlan.authMappings[165].firebaseUid = 'existing_firebase_0';
    refreshMappingOutputHash(generatedCollision.mappingPlan);
    expect(() => buildFirebaseIdentityImportDryRunPlan(generatedCollision)).toThrow();
  });

  it('accepts an exact multi-provider link only when every fingerprint has one owner', () => {
    const exact = syntheticDryRunInputs();
    const secondSubject = 'existing-provider-subject-0-secondary';
    exact.firebaseAuthority.users[0].providerSubjects.push({
      providerId: 'apple.com',
      subject: secondSubject,
    });
    exact.mappingPlan.authMappings[0].providerEvidenceHashes.push(
      providerFingerprint('apple.com', secondSubject),
    );
    refreshMappingOutputHash(exact.mappingPlan);

    const plan = buildFirebaseIdentityImportDryRunPlan(exact);
    expect(validateFirebaseIdentityImportDryRunPlan(plan).valid).toBe(true);
    expect(plan.dispositionRecords[0].providerEvidenceHashes).toHaveLength(2);
  });

  it('rejects a linked provider set when only a subset resolves', () => {
    const subset = syntheticDryRunInputs();
    subset.mappingPlan.authMappings[0].providerEvidenceHashes.push(
      providerFingerprint('apple.com', 'unmatched-provider-subject'),
    );
    refreshMappingOutputHash(subset.mappingPlan);

    expect(() => buildFirebaseIdentityImportDryRunPlan(subset)).toThrow(
      expect.objectContaining({ code: 'FIREBASE_PROVIDER_LINK_MISMATCH' }),
    );
  });

  it('rejects a linked provider set whose fingerprints resolve to different UIDs', () => {
    const ambiguous = syntheticDryRunInputs();
    const alternateSubject = 'existing-provider-subject-1-alternate';
    ambiguous.firebaseAuthority.users[1].providerSubjects.push({
      providerId: 'apple.com',
      subject: alternateSubject,
    });
    ambiguous.mappingPlan.authMappings[0].providerEvidenceHashes.push(
      providerEvidence(1),
    );
    ambiguous.mappingPlan.authMappings[1].providerEvidenceHashes = [
      providerFingerprint('apple.com', alternateSubject),
    ];
    refreshMappingOutputHash(ambiguous.mappingPlan);

    expect(() => buildFirebaseIdentityImportDryRunPlan(ambiguous)).toThrow(
      expect.objectContaining({ code: 'FIREBASE_PROVIDER_LINK_MISMATCH' }),
    );
  });

  it('rejects missing, duplicate, extra, or secret-shaped calendar evidence', () => {
    const missing = syntheticDryRunInputs();
    missing.calendarEvidence.users.pop();
    expect(() => buildFirebaseIdentityImportDryRunPlan(missing)).toThrow(
      expect.objectContaining({ code: 'INVALID_CALENDAR_EVIDENCE' }),
    );

    const duplicate = syntheticDryRunInputs();
    duplicate.calendarEvidence.users[1].legacyUserUuid =
      duplicate.calendarEvidence.users[0].legacyUserUuid;
    expect(() => buildFirebaseIdentityImportDryRunPlan(duplicate)).toThrow(
      expect.objectContaining({ code: 'INVALID_CALENDAR_EVIDENCE' }),
    );

    const unclaimed = syntheticDryRunInputs();
    unclaimed.calendarEvidence.users[0].legacyUserUuid = legacyUuid(1000);
    expect(() => buildFirebaseIdentityImportDryRunPlan(unclaimed)).toThrow(
      expect.objectContaining({ code: 'CALENDAR_IDENTITY_SET_MISMATCH' }),
    );

    const secretShaped = syntheticDryRunInputs();
    Object.assign(secretShaped.calendarEvidence.users[0], {
      oauthRefreshToken: 'must-never-enter-plan',
    });
    expect(() => buildFirebaseIdentityImportDryRunPlan(secretShaped)).toThrow(
      expect.objectContaining({ code: 'INVALID_CALENDAR_EVIDENCE' }),
    );
  });

  it('rejects invalid re-login epochs and any execution flag', () => {
    for (const reloginEpoch of [
      '2026-08-22T00:00:00.000Z',
      '2026-02-30T00:00:00Z',
      '2026-08-22T00:00:00+00:00',
      'not-a-date',
    ]) {
      expect(() =>
        buildFirebaseIdentityImportDryRunPlan({
          ...syntheticDryRunInputs(),
          reloginEpoch,
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_RELOGIN_EPOCH' }));
    }
    expect(() =>
      buildFirebaseIdentityImportDryRunPlan({
        ...syntheticDryRunInputs(),
        execute: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'EXECUTION_FORBIDDEN' }));
    expect(() =>
      buildFirebaseIdentityImportDryRunPlan({
        ...syntheticDryRunInputs(),
        apply: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'EXECUTION_FORBIDDEN' }));
    expect(() =>
      buildFirebaseIdentityImportDryRunPlan({
        ...syntheticDryRunInputs(),
        dryRun: false,
      }),
    ).toThrow(expect.objectContaining({ code: 'EXECUTION_FORBIDDEN' }));
  });

  it('detects modified rows, checkpoints, counts, blockers, and contract hashes', () => {
    const original = buildFirebaseIdentityImportDryRunPlan(syntheticDryRunInputs());
    const mutations: Array<(plan: MutableDryRunPlan) => void> = [
      (plan) => {
        plan.counts.importedFirebase = 203;
      },
      (plan) => {
        plan.firebaseImportRecords[0].mappingBasis = 'EMAIL';
      },
      (plan) => {
        plan.firebaseImportBatches[0].rowCount = 99;
      },
      (plan) => {
        plan.blockers.pop();
      },
      (plan) => {
        plan.policyContractHash = '0'.repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(original) as unknown as MutableDryRunPlan;
      mutate(tampered);
      expect(() => validateFirebaseIdentityImportDryRunPlan(tampered)).toThrow();
    }
  });

  it('rejects paired relogin mutations even when their policy hash is refreshed', () => {
    const original = buildFirebaseIdentityImportDryRunPlan(syntheticDryRunInputs());

    const globalRevocation = structuredClone(original) as unknown as MutableDryRunPlan;
    globalRevocation.relogin.firebaseGlobalRevocationAllowed = true;
    globalRevocation.reloginPolicyHash = canonicalHash(globalRevocation.relogin);
    expect(() => validateFirebaseIdentityImportDryRunPlan(globalRevocation)).toThrow(
      expect.objectContaining({ code: 'INVALID_RELOGIN_POLICY' }),
    );

    const researchRevocation = structuredClone(original) as unknown as MutableDryRunPlan;
    researchRevocation.relogin.researchSessionRevocationAllowed = true;
    researchRevocation.reloginPolicyHash = canonicalHash(researchRevocation.relogin);
    expect(() => validateFirebaseIdentityImportDryRunPlan(researchRevocation)).toThrow(
      expect.objectContaining({ code: 'INVALID_RELOGIN_POLICY' }),
    );

    const productDrift = structuredClone(original) as unknown as MutableDryRunPlan;
    productDrift.relogin.productBinding = 'hushh-research';
    productDrift.reloginPolicyHash = canonicalHash(productDrift.relogin);
    expect(() => validateFirebaseIdentityImportDryRunPlan(productDrift)).toThrow(
      expect.objectContaining({ code: 'INVALID_RELOGIN_POLICY' }),
    );

    const unknownField = structuredClone(original) as unknown as MutableDryRunPlan;
    unknownField.relogin.globalSessionEpoch = unknownField.relogin.epoch;
    unknownField.reloginPolicyHash = canonicalHash(unknownField.relogin);
    expect(() => validateFirebaseIdentityImportDryRunPlan(unknownField)).toThrow(
      expect.objectContaining({ code: 'INVALID_RELOGIN_POLICY' }),
    );
  });

  it('rejects paired rollback and future-executor mutations with refreshed hashes', () => {
    const original = buildFirebaseIdentityImportDryRunPlan(syntheticDryRunInputs());

    const deletion = structuredClone(original) as unknown as MutableDryRunPlan;
    deletion.rollback.createdUidDeletionAllowed = true;
    deletion.rollbackPolicyHash = canonicalHash(deletion.rollback);
    expect(() => validateFirebaseIdentityImportDryRunPlan(deletion)).toThrow(
      expect.objectContaining({ code: 'INVALID_ROLLBACK_POLICY' }),
    );

    const unknownRollback = structuredClone(original) as unknown as MutableDryRunPlan;
    unknownRollback.rollback.deleteBatchSize = 100;
    unknownRollback.rollbackPolicyHash = canonicalHash(unknownRollback.rollback);
    expect(() => validateFirebaseIdentityImportDryRunPlan(unknownRollback)).toThrow(
      expect.objectContaining({ code: 'INVALID_ROLLBACK_POLICY' }),
    );

    const falselySatisfied = structuredClone(original) as unknown as MutableDryRunPlan;
    falselySatisfied.futureExecutorGates.satisfiedByDryRun = true;
    falselySatisfied.futureExecutorGatesHash = canonicalHash(
      falselySatisfied.futureExecutorGates,
    );
    expect(() => validateFirebaseIdentityImportDryRunPlan(falselySatisfied)).toThrow(
      expect.objectContaining({ code: 'INVALID_FIREBASE_EXECUTOR_GATES' }),
    );

    const summary = firebaseIdentityImportDryRunSummary(original);
    expect(Object.keys(summary.relogin).sort()).toEqual(
      [
        'enforcement',
        'epoch',
        'firebaseGlobalRevocationAllowed',
        'productBinding',
        'researchSessionRevocationAllowed',
        'scope',
      ].sort(),
    );
    expect(Object.keys(summary.rollback).sort()).toEqual(
      [
        'createdUidCandidateCount',
        'createdUidDeletionAllowed',
        'evidenceSchemaHash',
        'evidenceWriteMode',
        'existingLinkedUidDeletionAllowed',
        'mode',
      ].sort(),
    );
  });

  it('requires current-user ownership and exact 0600 private-input permissions', () => {
    const metadata = (uid: bigint, mode: bigint) => ({
      isFile: () => true,
      uid,
      mode,
    });

    expect(() =>
      assertProtectedInputOwnershipAndMode(metadata(1235n, 0o100600n), 1234),
    ).toThrow(expect.objectContaining({ code: 'PRIVATE_INPUT_OWNER_REQUIRED' }));
    for (const mode of [0o100400n, 0o100640n, 0o100660n, 0o100604n, 0o100666n]) {
      expect(() =>
        assertProtectedInputOwnershipAndMode(metadata(1234n, mode), 1234),
      ).toThrow(expect.objectContaining({ code: 'PRIVATE_INPUT_MODE_REQUIRED' }));
    }
    expect(
      assertProtectedInputOwnershipAndMode(metadata(1234n, 0o100600n), 1234),
    ).toBe(true);
  });

  it('rejects protected-input mutation, symlinks, repository files, and unsafe modes', () => {
    const snapshot = {
      dev: 1n,
      ino: 2n,
      uid: 1234n,
      mode: 0o100600n,
      size: 2n,
      mtimeNs: 3n,
      ctimeNs: 4n,
    };
    expect(assertProtectedInputSnapshotUnchanged(snapshot, { ...snapshot }, 2)).toBe(true);
    expect(() =>
      assertProtectedInputSnapshotUnchanged(
        snapshot,
        { ...snapshot, mtimeNs: snapshot.mtimeNs + 1n },
        2,
      ),
    ).toThrow(expect.objectContaining({ code: 'INPUT_CHANGED_DURING_READ' }));

    const directory = mkdtempSync(join(tmpdir(), 'hushh-firebase-dry-run-'));
    const inputPath = join(directory, 'identity-input.json');
    const linkPath = join(directory, 'identity-input-link.json');
    try {
      writeFileSync(inputPath, '{}', { encoding: 'utf8', mode: 0o600 });
      chmodSync(inputPath, 0o600);
      expect(
        readProtectedJsonFile({
          path: inputPath,
          label: 'Synthetic',
          maximumBytes: 64,
          repositoryRoot: root,
        }),
      ).toEqual({});

      chmodSync(inputPath, 0o640);
      expect(() =>
        readProtectedJsonFile({
          path: inputPath,
          label: 'Synthetic',
          maximumBytes: 64,
          repositoryRoot: root,
        }),
      ).toThrow(expect.objectContaining({ code: 'PRIVATE_INPUT_MODE_REQUIRED' }));

      chmodSync(inputPath, 0o600);
      symlinkSync(inputPath, linkPath);
      expect(() =>
        readProtectedJsonFile({
          path: linkPath,
          label: 'Synthetic',
          maximumBytes: 64,
          repositoryRoot: root,
        }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT_FILE' }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    expect(() =>
      readProtectedJsonFile({
        path: join(root, 'migration/contracts/source-inventory.v1.json'),
        label: 'Synthetic',
        maximumBytes: 1_000_000,
        repositoryRoot: root,
      }),
    ).toThrow(expect.objectContaining({ code: 'PROTECTED_INPUT_IN_REPOSITORY' }));
  });

  it('fails closed in the CLI before reading files or printing rejected values', () => {
    const baseArgs = [
      'scripts/gcp/migration/plan-firebase-identity-import.mjs',
      '--environment=uat',
      '--source-project-ref=ibsisfnjxeowvdtvgzff',
      '--source-database=postgres',
      '--target-project=hushh-tech-uat',
      '--target-region=us-central1',
      '--target-instance=hushh-tech-app-pg-uat',
      '--target-database=hushh_tech_app',
      '--postgres-major=17',
    ];
    const execute = spawnSync(process.execPath, [...baseArgs, '--dry-run', '--execute'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(execute.status).toBe(1);
    expect(execute.stdout).toBe('');
    expect(execute.stderr).toContain('EXECUTION_FORBIDDEN');

    const unknown = spawnSync(
      process.execPath,
      [...baseArgs, '--dry-run', '--service-account=/private/forbidden.json'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toContain('INVALID_ARGUMENT');
    expect(unknown.stderr).not.toContain('/private/forbidden.json');

    const implicit = spawnSync(process.execPath, baseArgs, {
      cwd: root,
      encoding: 'utf8',
    });
    expect(implicit.status).toBe(1);
    expect(implicit.stdout).toBe('');
    expect(implicit.stderr).toContain('DRY_RUN_FLAG_REQUIRED');

    const repositoryInput = spawnSync(
      process.execPath,
      [
        ...baseArgs,
        '--dry-run',
        '--inventory=migration/contracts/source-inventory.v1.json',
        '--firebase=migration/contracts/source-inventory.v1.json',
        '--unclaimed=migration/contracts/source-inventory.v1.json',
        '--calendar=migration/contracts/source-inventory.v1.json',
        '--relogin-epoch=2026-08-22T00:00:00Z',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(repositoryInput.status).toBe(1);
    expect(repositoryInput.stdout).toBe('');
    expect(repositoryInput.stderr).toContain('PROTECTED_INPUT_IN_REPOSITORY');
  });
});
