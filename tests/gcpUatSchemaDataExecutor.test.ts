import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildCapturedEvidence,
} from '../cloud-run/hushh-tech-cloudsql-attestor/src/evidence.js';
import {
  compareBaseline,
  loadBaseline,
} from '../cloud-run/hushh-tech-cloudsql-attestor/src/baseline.js';
import {
  CHECK_NAMES,
  COLLECTIONS,
} from '../cloud-run/hushh-tech-cloudsql-attestor/src/constants.js';
import { canonicalHash, canonicalJson } from '../scripts/gcp/migration/canonical-hash.mjs';
import { PUBLIC_TABLES } from '../scripts/gcp/migration/contract.mjs';
import { loadValidatedSourceMembers } from '../scripts/gcp/migration/uat-cloudsql-import-bundle.mjs';
import {
  buildUatSourceKeyManifest,
  hashPrimaryKeys,
  validateUatSourceKeyManifest,
} from '../scripts/gcp/migration/uat-source-key-manifest.mjs';
import {
  SOURCE_BOUNDARY,
  UAT_TARGET,
  UatMigrationError,
  activateReviewedPhase,
  buildExecutionEvidence,
  buildUatTransientIdentityPlan,
  captureIdentityInputs,
  createPostgresTargetDriver,
  deriveUatIdentityEvidence,
  executeUatSchemaDataMigration,
  hashRowObjects,
  validateGreenCatalogAttestation,
  validateRowsForTable,
  validateSourceCaptureManifest,
  validateUatIdentityArtifact,
} from '../scripts/gcp/migration/uat-schema-data-executor.mjs';

const digest = (label: string) => canonicalHash({ label });
const attestedBaseline = () => compareBaseline(loadBaseline().expectedCatalog);

function greenEvidence() {
  const checks = Object.fromEntries(CHECK_NAMES.map((name) => [name, true]));
  const collections = COLLECTIONS.map((name) => ({
    name,
    status: 'CAPTURED',
    rowCount: ['relations', 'sequences', 'functions', 'triggers'].includes(name) ? 0 : 1,
    sha256: digest(name),
  }));
  return buildCapturedEvidence({
    normalized: { checks, collections, baseline: attestedBaseline() },
    imageDigest: `sha256:${'a'.repeat(64)}`,
    cleanup: {
      connectorCreated: true,
      poolCreated: true,
      connectorCloseCalled: true,
      poolCloseCalled: true,
    },
  });
}

function sourceManifest({ total = 0, overrides = {} as Record<string, unknown> } = {}) {
  const bundle = {
    bucket: 'hushh-tech-migration-evidence-uat',
    encryption: 'CLOUD_KMS',
    generation: '1',
    kmsKeyVersion: 'projects/hushh-tech-uat/locations/us-central1/keyRings/hushh-tech-cutover-uat/cryptoKeys/migration-archive/cryptoKeyVersions/1',
    object: `source-data/uat/${digest('bundle')}-rows.tar.gz`,
    objectSha256: digest('ciphertext'),
  };
  const tables = PUBLIC_TABLES.map((name, index) => ({
    schema: 'public',
    name,
    rowCount: index === 0 ? total : 0,
    rowColumns: ['id'],
    insertColumns: ['id'],
    primaryKey: ['id'],
    rowSha256: index === 0 && total > 0 ? digest('rows') : hashRowObjects([]),
    artifact: {
      encryption: 'CLOUD_KMS',
      ciphertextSha256: bundle.objectSha256,
      generation: bundle.generation,
      containsRows: true,
      bucket: bundle.bucket,
      object: bundle.object,
      member: `${String(index + 1).padStart(2, '0')}-${name}.rows.json`,
      memberSha256: index === 0 && total > 0 ? digest('member') : canonicalHash([]),
      kmsKeyVersion: bundle.kmsKeyVersion,
    },
  }));
  const payload = {
    version: 1,
    kind: 'HUSHH_TECH_SUPABASE_READ_ONLY_DATA_CAPTURE',
    source: SOURCE_BOUNDARY,
    capture: {
      transactionReadOnly: true,
      converged: true,
      passes: 2,
      rawRowsLogged: false,
      rawRowsPersistedOutsidePrivateDirectory: false,
    },
    baselineRowCount: 44_811,
    observedDelta: total - 44_811,
    totalRowCount: total,
    tables,
    contractDrift: 'CONTRACT_DRIFT_65_TO_0',
    sourceDraftManifestSha256: digest('draft'),
    bundle,
    ...overrides,
  };
  return { ...payload, manifestSha256: canonicalHash(payload) };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(UatMigrationError);
    expect((error as UatMigrationError).code).toBe(code);
  }
}

function identityArtifact() {
  const authUsers = Array.from({ length: 369 }, (_, index) => {
    const legacyUserUuid = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    return {
      legacyUserUuid,
      emailVerified: false,
      disabled: false,
      passwordAlgorithm: null,
      passwordHashBase64: null,
      providerSubjects: [{ providerId: 'google.com', subject: `subject-${index}` }],
    };
  });
  return buildUatTransientIdentityPlan({
    authUsers,
    existingFirebaseUsers: [],
    sourceCaptureSha256: digest('identity-source'),
    foreignKeyParitySha256: digest('identity-fks'),
  });
}

function rehashIdentity(artifact: Record<string, unknown>) {
  const payload = structuredClone(artifact);
  delete (payload as { artifactSha256?: string }).artifactSha256;
  return { ...payload, artifactSha256: canonicalHash(payload) };
}

describe('immutable UAT catalog gate', () => {
  it('accepts a hash-bound, green and empty catalog capture', () => {
    const evidence = greenEvidence();
    expect(validateGreenCatalogAttestation(evidence, evidence.evidenceSha256)).toMatchObject({
      targetEmpty: true,
      evidenceSha256: evidence.evidenceSha256,
    });
  });

  it('rejects a different evidence digest', () => {
    const evidence = greenEvidence();
    expectCode(() => validateGreenCatalogAttestation(evidence, digest('other')), 'ATTESTATION_NOT_GREEN');
  });

  it('rejects evidence tampering even when the status remains green', () => {
    const evidence = structuredClone(greenEvidence());
    evidence.collections[0].rowCount += 1;
    expectCode(() => validateGreenCatalogAttestation(evidence, evidence.evidenceSha256), 'ATTESTATION_INVALID');
  });

  it('rejects any pre-existing target relation', () => {
    const checks = Object.fromEntries(CHECK_NAMES.map((name) => [name, true]));
    checks.applicationRelationsEmpty = false;
    const collections = COLLECTIONS.map((name) => ({
      name,
      status: 'CAPTURED',
      rowCount: name === 'relations' ? 1 : 0,
      sha256: digest(name),
    }));
    const evidence = buildCapturedEvidence({
      normalized: { checks, collections, baseline: attestedBaseline() },
      imageDigest: `sha256:${'b'.repeat(64)}`,
      cleanup: { connectorCreated: true, poolCreated: true, connectorCloseCalled: true, poolCloseCalled: true },
    });
    expectCode(() => validateGreenCatalogAttestation(evidence, evidence.evidenceSha256), 'ATTESTATION_NOT_GREEN');
  });
});

describe('read-only source capture manifest', () => {
  it('binds all 70 tables, counts, generations and hashes', () => {
    expect(validateSourceCaptureManifest(sourceManifest())).toMatchObject({ tableCount: 70, totalRowCount: 0 });
  });

  it('rejects a missing table even with a recomputed envelope digest', () => {
    const manifest = sourceManifest();
    const payload = { ...manifest, tables: manifest.tables.slice(1) };
    delete (payload as { manifestSha256?: string }).manifestSha256;
    const changed = { ...payload, manifestSha256: canonicalHash(payload) };
    expectCode(() => validateSourceCaptureManifest(changed), 'SOURCE_CAPTURE_MANIFEST_INVALID');
  });

  it('rejects duplicate table substitution', () => {
    const manifest = sourceManifest();
    manifest.tables[1] = structuredClone(manifest.tables[0]);
    const payload = structuredClone(manifest);
    delete (payload as { manifestSha256?: string }).manifestSha256;
    manifest.manifestSha256 = canonicalHash(payload);
    expectCode(() => validateSourceCaptureManifest(manifest), 'SOURCE_TABLE_SET_MISMATCH');
  });

  it('rejects a single-pass or drifting capture', () => {
    for (const capture of [
      { transactionReadOnly: true, converged: true, passes: 1 },
      { transactionReadOnly: true, converged: false, passes: 2 },
      { transactionReadOnly: false, converged: true, passes: 2 },
    ]) {
      const manifest = sourceManifest({ overrides: { capture: {
        ...sourceManifest().capture,
        ...capture,
      } } });
      expectCode(() => validateSourceCaptureManifest(manifest), 'SOURCE_CAPTURE_MANIFEST_INVALID');
    }
  });

  it('rejects total-row arithmetic drift', () => {
    const manifest = sourceManifest();
    manifest.totalRowCount = 1;
    const payload = structuredClone(manifest);
    delete (payload as { manifestSha256?: string }).manifestSha256;
    manifest.manifestSha256 = canonicalHash(payload);
    expectCode(() => validateSourceCaptureManifest(manifest), 'SOURCE_CAPTURE_MANIFEST_INVALID');
  });

  it('rejects an unhashed or unencrypted table artifact', () => {
    const manifest = sourceManifest();
    manifest.tables[0].artifact.encryption = 'NONE';
    const payload = structuredClone(manifest);
    delete (payload as { manifestSha256?: string }).manifestSha256;
    manifest.manifestSha256 = canonicalHash(payload);
    expectCode(() => validateSourceCaptureManifest(manifest), 'SOURCE_TABLE_MANIFEST_INVALID');
  });
});

describe('reviewed phase activation and row parity', () => {
  const privatePlanDirectory = process.env.HUSHH_TECH_PRIVATE_PLAN_DIRECTORY ?? '';

  it('never lets the executor own the role bootstrap phase', () => {
    expectCode(() => activateReviewedPhase('00_extension_and_role_preflight.sql.plan', ''), 'PHASE_00_OWNED_BY_ROLE_BOOTSTRAP');
  });

  it('rejects one-byte phase drift', () => {
    expectCode(() => activateReviewedPhase('20_raw_parity_schema.sql.plan', 'x'), 'SCHEMA_PHASE_DIGEST_MISMATCH');
  });

  it.runIf(existsSync(privatePlanDirectory))('activates all six exact private phases and strips only their guard', () => {
    const names = [
      '10_firebase_identity_context.sql.plan',
      '20_raw_parity_schema.sql.plan',
      '30_constraints_triggers_indexes.sql.plan',
      '40_firebase_rls_policies.sql.plan',
      '50_target_privileges.sql.plan',
      '60_catalog_validation.sql.plan',
    ];
    for (const name of names) {
      const phase = activateReviewedPhase(name, readFileSync(join(privatePlanDirectory, name), 'utf8'));
      expect(phase.statements.length).toBeGreaterThan(0);
      expect(phase.statements.join('\n')).not.toContain('PLAN_ONLY_EXECUTION');
    }
  });

  it('canonical row hashing is order independent', () => {
    expect(hashRowObjects([{ id: 2 }, { id: 1 }])).toBe(hashRowObjects([{ id: 1 }, { id: 2 }]));
  });

  it('rejects a generated-column omission from source hash rows', () => {
    const table = {
      ...sourceManifest().tables[0],
      rowCount: 1,
      rowColumns: ['id', 'amount'],
      insertColumns: ['id'],
      rowSha256: hashRowObjects([{ id: '1', amount: 2 }]),
      artifact: { ...sourceManifest().tables[0].artifact, memberSha256: canonicalHash([{ id: '1', amount: 2 }]) },
    };
    expectCode(() => validateRowsForTable(table, [{ id: '1' }]), 'SOURCE_ROW_SHAPE_MISMATCH');
  });

  it('rejects a row-content hash mismatch before target insertion', () => {
    const changedRows = [{ id: 'changed' }];
    const table = {
      ...sourceManifest().tables[0],
      rowCount: 1,
      rowSha256: hashRowObjects([{ id: 'expected' }]),
      artifact: { ...sourceManifest().tables[0].artifact, memberSha256: canonicalHash(changedRows) },
    };
    expectCode(() => validateRowsForTable(table, changedRows), 'SOURCE_ROW_HASH_MISMATCH');
  });

  it('rejects same-count member substitution even with a recomputed row hash', () => {
    const changedRows = [{ id: 'changed' }];
    const table = {
      ...sourceManifest().tables[0],
      rowCount: 1,
      rowSha256: hashRowObjects(changedRows),
      artifact: { ...sourceManifest().tables[0].artifact, memberSha256: canonicalHash([{ id: 'expected' }]) },
    };
    expectCode(() => validateRowsForTable(table, changedRows), 'SOURCE_MEMBER_HASH_MISMATCH');
  });

  it('validates all 70 member files before bundle SQL generation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hushh-uat-members-'));
    try {
      const manifest = sourceManifest({ total: 1 });
      const expectedRows = [{ id: 'expected' }];
      manifest.tables[0].rowSha256 = hashRowObjects(expectedRows);
      manifest.tables[0].artifact.memberSha256 = canonicalHash(expectedRows);
      const rowsByTable = new Map<string, Array<Record<string, unknown>>>();
      for (const [index, table] of manifest.tables.entries()) {
        const rows = index === 0 ? expectedRows : [];
        rowsByTable.set(table.name, rows);
        writeFileSync(join(directory, table.artifact.member), `${canonicalJson(rows)}\n`, { mode: 0o600 });
      }
      const sourceKeyManifest = buildUatSourceKeyManifest({ sourceManifest: manifest, rowsByTable });
      expect(loadValidatedSourceMembers({
        sourceManifest: manifest,
        rowDirectory: directory,
        sourceKeyManifest,
        expectedSourceKeyManifestSha256: sourceKeyManifest.manifestSha256,
        expectedSourceRowCount: 1,
      }).size).toBe(70);
      writeFileSync(join(directory, manifest.tables[0].artifact.member), `${canonicalJson([{ id: 'changed' }])}\n`);
      expectCode(
        () => loadValidatedSourceMembers({
          sourceManifest: manifest,
          rowDirectory: directory,
          sourceKeyManifest,
          expectedSourceKeyManifestSha256: sourceKeyManifest.manifestSha256,
          expectedSourceRowCount: 1,
        }),
        'SOURCE_KEY_PARITY_MISMATCH',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a same-count primary-key substitution after row/member hashes are recomputed', () => {
    const originalRows = [{ id: 'expected' }];
    const changedRows = [{ id: 'changed' }];
    const table = {
      ...sourceManifest().tables[0],
      rowCount: 1,
      rowSha256: hashRowObjects(changedRows),
      artifact: { ...sourceManifest().tables[0].artifact, memberSha256: canonicalHash(changedRows) },
    };
    const expectedKey = {
      name: table.name,
      primaryKey: table.primaryKey,
      keyCount: 1,
      keySha256: hashPrimaryKeys(table, originalRows),
    };
    expectCode(() => validateRowsForTable(table, changedRows, expectedKey), 'SOURCE_KEY_PARITY_MISMATCH');
  });

  it('rejects a same-count key drop replaced by a duplicate', () => {
    const table = sourceManifest().tables[0];
    expect(() => hashPrimaryKeys(table, [{ id: 'kept' }, { id: 'kept' }])).toThrow('SOURCE_ROW_KEY_DUPLICATE');
  });
});

describe('retained 70-table key manifest', () => {
  const expected = JSON.parse(readFileSync(
    new URL('../migration/cloud-run/hushh-tech-schema-data-verifier-uat/expected-manifest.v1.json', import.meta.url),
    'utf8',
  ));

  it('binds an explicit key digest and count for every governed table', () => {
    expect(validateUatSourceKeyManifest(expected.sourceKeys, expected.sourceManifest)).toBe(expected.sourceKeys);
    expect(expected.sourceKeys.tables).toHaveLength(70);
    expect(expected.sourceKeys.tables.every((table: any) => /^[a-f0-9]{64}$/.test(table.keySha256))).toBe(true);
  });

  it('rejects a same-count key-digest swap after the envelope is rehashed', () => {
    const changed = structuredClone(expected.sourceKeys);
    [changed.tables[0].keySha256, changed.tables[1].keySha256] =
      [changed.tables[1].keySha256, changed.tables[0].keySha256];
    const payload = structuredClone(changed);
    delete payload.manifestSha256;
    changed.manifestSha256 = canonicalHash(payload);
    expect(() => validateUatSourceKeyManifest(changed, expected.sourceManifest)).toThrow('SOURCE_KEY_MANIFEST_INVALID');
  });
});

describe('exact identity import evidence', () => {
  it('accepts a strict 369-row one-to-one identity/import envelope', () => {
    const artifact = identityArtifact();
    expect(validateUatIdentityArtifact(artifact, deriveUatIdentityEvidence(artifact))).toBe(true);
  });

  it('rejects a duplicate legacy UUID with the same row count', () => {
    const artifact = structuredClone(identityArtifact());
    artifact.identityRows[1].legacyUserUuid = artifact.identityRows[0].legacyUserUuid;
    const changed = rehashIdentity(artifact);
    expectCode(() => validateUatIdentityArtifact(changed, deriveUatIdentityEvidence(changed)), 'UAT_IDENTITY_ROW_INVALID');
  });

  it('rejects a Firebase UID swap even when every count is unchanged', () => {
    const artifact = structuredClone(identityArtifact());
    [artifact.identityRows[0].firebaseUid, artifact.identityRows[1].firebaseUid] = [artifact.identityRows[1].firebaseUid, artifact.identityRows[0].firebaseUid];
    const changed = rehashIdentity(artifact);
    expectCode(() => validateUatIdentityArtifact(changed, deriveUatIdentityEvidence(changed)), 'UAT_IDENTITY_ROW_INVALID');
  });

  it('rejects a drop-and-duplicate import substitution with 369 rows', () => {
    const artifact = structuredClone(identityArtifact());
    artifact.importUsers[1] = structuredClone(artifact.importUsers[0]);
    const changed = rehashIdentity(artifact);
    expectCode(() => validateUatIdentityArtifact(changed, deriveUatIdentityEvidence(changed)), 'UAT_FIREBASE_IMPORT_ROW_INVALID');
  });

  it('rejects duplicate provider subjects across different users', () => {
    const artifact = structuredClone(identityArtifact());
    artifact.importUsers[1].providerUserInfo[0].rawId = artifact.importUsers[0].providerUserInfo[0].rawId;
    const changed = rehashIdentity(artifact);
    expectCode(() => validateUatIdentityArtifact(changed, deriveUatIdentityEvidence(changed)), 'UAT_FIREBASE_IMPORT_PROVIDER_DUPLICATE');
  });

  it('rejects a refreshed and rehashed source envelope against the bound evidence', () => {
    const artifact = identityArtifact();
    const expected = deriveUatIdentityEvidence(artifact);
    const changed = rehashIdentity({ ...structuredClone(artifact), sourceCaptureSha256: digest('refreshed-source') });
    expectCode(() => validateUatIdentityArtifact(changed, expected), 'UAT_IDENTITY_EVIDENCE_MISMATCH');
  });

  it('rejects a self-consistent provider swap against retained import evidence', () => {
    const artifact = identityArtifact();
    const expected = deriveUatIdentityEvidence(artifact);
    const changed = structuredClone(artifact);
    [changed.importUsers[0].providerUserInfo[0].rawId, changed.importUsers[1].providerUserInfo[0].rawId] =
      [changed.importUsers[1].providerUserInfo[0].rawId, changed.importUsers[0].providerUserInfo[0].rawId];
    for (const index of [0, 1]) {
      const provider = changed.importUsers[index].providerUserInfo[0];
      changed.identityRows[index].providerSubjectHash = createHash('sha256')
        .update(`${provider.providerId}\0${provider.rawId}`, 'utf8')
        .digest('hex');
    }
    const rehashed = rehashIdentity(changed);
    expectCode(() => validateUatIdentityArtifact(rehashed, expected), 'UAT_IDENTITY_EVIDENCE_MISMATCH');
  });

  it('rejects undeclared identity fields even after the envelope is rehashed', () => {
    const artifact = identityArtifact();
    const changed = rehashIdentity({ ...structuredClone(artifact), refreshedAt: '2026-08-22T00:00:00Z' });
    expectCode(() => validateUatIdentityArtifact(changed, deriveUatIdentityEvidence(changed)), 'UAT_IDENTITY_ARTIFACT_INVALID');
  });
});

describe('automatic identity readers, execution gate and rollback evidence', () => {
  it('requires read-only Supabase HTTPS and Firebase Admin readers', async () => {
    await expect(captureIdentityInputs({
      sourceReader: { readOnly: false },
      firebaseAdminReader: {},
      inventory: {},
      boundary: {},
    })).rejects.toMatchObject({ code: 'IDENTITY_READERS_INVALID' });
  });

  it('captures 369 Auth users without accepting a manual mapping artifact', async () => {
    const authUsers = Array.from({ length: 369 }, (_, index) => ({ id: index }));
    const result = await captureIdentityInputs({
      sourceReader: {
        readOnly: true,
        transport: SOURCE_BOUNDARY.transport,
        readAuthUsers: vi.fn().mockResolvedValue(authUsers),
        readUnclaimedLegacyPrincipals: vi.fn().mockResolvedValue([]),
      },
      firebaseAdminReader: {
        projectId: 'hushh-tech-uat',
        tenantId: null,
        readOnly: true,
        listUsers: vi.fn().mockResolvedValue([]),
      },
      inventory: { authUsers: [] },
      boundary: { target: UAT_TARGET },
    });
    expect(result.inventory.authUsers).toHaveLength(369);
    expect(result.firebaseAuthority).toMatchObject({ projectId: 'hushh-tech-uat', tenantId: null });
  });

  it('fails before any target call when the transient identity artifact is absent', async () => {
    const evidence = greenEvidence();
    const driver = { assertBoundary: vi.fn() };
    await expect(executeUatSchemaDataMigration({
      catalogEvidence: evidence,
      expectedCatalogEvidenceSha256: evidence.evidenceSha256,
      sourceManifest: sourceManifest(),
      phaseTexts: {},
      readRows: vi.fn(),
      identityArtifact: null,
      driver,
    })).rejects.toMatchObject({ code: 'IDENTITY_ARTIFACT_REQUIRED' });
    expect(driver.assertBoundary).not.toHaveBeenCalled();
  });

  it('seals truthful execution evidence without claiming a bound rollback', () => {
    const evidence = greenEvidence();
    const catalog = validateGreenCatalogAttestation(evidence, evidence.evidenceSha256);
    const source = validateSourceCaptureManifest(sourceManifest());
    const manifest = buildExecutionEvidence({
      replayKey: digest('replay'),
      catalog,
      source,
      sourceKeyManifestSha256: digest('source-keys'),
      identityArtifactSha256: digest('identity'),
      phases: [{ name: '20_raw_parity_schema.sql.plan', sha256: digest('phase') }],
      tables: [{ name: PUBLIC_TABLES[0], rowCount: 0, rowSha256: hashRowObjects([]) }],
    });
    expect(manifest.target).toEqual(UAT_TARGET);
    expect(manifest.recovery).toMatchObject({ rollbackReady: false, restoreProcedureBound: false, automaticDestructiveRollback: false, productionAllowed: false });
    const { manifestSha256, ...payload } = manifest;
    expect(manifestSha256).toBe(canonicalHash(payload));
  });

  it('rejects duplicate primary keys even when count and row hash match', () => {
    const rows = [{ id: 'same' }, { id: 'same' }];
    const table = {
      ...sourceManifest().tables[0],
      rowCount: rows.length,
      rowSha256: hashRowObjects(rows),
      artifact: { ...sourceManifest().tables[0].artifact, memberSha256: canonicalHash(rows) },
    };
    expectCode(() => validateRowsForTable(table, rows), 'SOURCE_ROW_KEY_DUPLICATE');
  });

  it('the PostgreSQL adapter rolls back instead of masking target failures', async () => {
    const query = vi.fn(async ({ text }: { text: string }) => {
      if (text.startsWith('SELECT current_database')) {
        return { rows: [{ database: 'wrong_database', version_num: 170000, read_only: 'off' }] };
      }
      return { rows: [] };
    });
    const driver = createPostgresTargetDriver({ query });
    await expect(driver.assertBoundary()).rejects.toMatchObject({ code: 'TARGET_BOUNDARY_MISMATCH' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
