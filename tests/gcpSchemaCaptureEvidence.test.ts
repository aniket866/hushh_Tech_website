import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../scripts/gcp/migration/canonical-hash.mjs';
import {
  CUSTOM_PUBLIC_FUNCTION_SIGNATURES,
  PUBLIC_TABLES,
  SOURCE_CONTRACT,
} from '../scripts/gcp/migration/contract.mjs';
import { buildSchemaCaptureEvidence } from '../scripts/gcp/migration/schema-capture-evidence.mjs';

const root = process.cwd();
const queryBytes = readFileSync(
  join(root, 'migration/sql/source_schema_capture_read_only.sql'),
);

function parseSignature(signature: string) {
  const resultSeparator = signature.lastIndexOf('->');
  const argumentsStart = signature.indexOf('(');
  const argumentsEnd = signature.lastIndexOf(')', resultSeparator);
  return {
    name: signature.slice(0, argumentsStart),
    identityArguments: signature.slice(argumentsStart + 1, argumentsEnd),
    result: signature.slice(resultSeparator + 2),
  };
}

function syntheticCapture() {
  const tableFor = (index: number) => PUBLIC_TABLES[index % PUBLIC_TABLES.length];
  return {
    schema_version: 1,
    source_project_ref: 'ibsisfnjxeowvdtvgzff',
    database_name: 'postgres',
    server_version_num: 170006,
    tables: PUBLIC_TABLES.map((name) => ({
      schema: 'public',
      name,
      kind: 'r',
      row_security: true,
      force_row_security: false,
      partition_key: null,
      partition_bound: null,
      reloptions: [],
      comment: null,
    })),
    columns: Array.from({ length: 1061 }, (_, index) => ({
      schema: 'public',
      table: tableFor(index),
      ordinal: index + 1,
      name: `column_${index}`,
      type: 'text',
      not_null: false,
      identity: '',
      generated: '',
      default: index === 0 ? 'safe-default-body-marker' : null,
      collation: null,
      comment: null,
    })),
    constraints: Array.from({ length: 270 }, (_, index) => ({
      schema: 'public',
      table: tableFor(index),
      name: `constraint_${index}`,
      type: 'c',
      definition: `safe-constraint-body-marker-${index}`,
      validated: true,
      deferrable: false,
      initially_deferred: false,
    })),
    indexes: Array.from({ length: 232 }, (_, index) => ({
      schema: 'public',
      table: tableFor(index),
      name: `index_${index}`,
      definition: `safe-index-body-marker-${index}`,
      unique: false,
      primary: false,
      valid: true,
      ready: true,
      clustered: false,
      replica_identity: false,
    })),
    triggers: Array.from({ length: 24 }, (_, index) => ({
      schema: 'public',
      table: tableFor(index),
      name: `trigger_${index}`,
      definition: `safe-trigger-body-marker-${index}`,
      enabled: 'O',
    })),
    policies: Array.from({ length: 118 }, (_, index) => ({
      schema: 'public',
      table: tableFor(index),
      name: `policy_${index}`,
      permissive: true,
      command: 'r',
      roles: ['public'],
      using: null,
      check: null,
    })),
    custom_functions: CUSTOM_PUBLIC_FUNCTION_SIGNATURES.map((signature, index) => {
      const parsed = parseSignature(signature);
      return {
        schema: 'public',
        name: parsed.name,
        identity_arguments: parsed.identityArguments,
        result: parsed.result,
        kind: parsed.result === 'trigger' ? 'f' : 'f',
        security_definer: false,
        volatility: 'v',
        parallel: 'u',
        definition: `safe-function-body-marker-${index}`,
      };
    }),
    sequences: null,
    enums: Array.from({ length: 12 }, (_, index) => ({
      schema: 'public',
      name: `enum_${index}`,
      label: `label_${index}`,
      order: index + 1,
    })),
    extensions: Array.from({ length: 6 }, (_, index) => ({
      name: `extension_${index}`,
      version: '1.0',
      schema: 'extensions',
    })),
    table_grants: Array.from({ length: 1929 }, (_, index) => ({
      schema: 'public',
      table: tableFor(index),
      grantee: 'authenticated',
      privilege: 'SELECT',
      grantable: 'NO',
    })),
    routine_grants: Array.from({ length: 585 }, (_, index) => ({
      schema: 'public',
      routine: `routine_${index}`,
      specific_name: `routine_${index}_1`,
      grantee: 'authenticated',
      privilege: 'EXECUTE',
      grantable: 'NO',
    })),
    publication_tables: Array.from({ length: 3 }, (_, index) => ({
      publication: 'migration_publication',
      schema: 'public',
      table: PUBLIC_TABLES[index],
    })),
  };
}

function evidenceInputs(capture: ReturnType<typeof syntheticCapture>) {
  const rawEnvelope = {
    boundary: 'read-only',
    rows: [{ schema_capture: capture }],
    warning: 'read-only query',
  };
  return {
    capture,
    captureBytes: Buffer.from(JSON.stringify(capture), 'utf8'),
    rawEnvelope,
    rawEnvelopeBytes: Buffer.from(JSON.stringify(rawEnvelope), 'utf8'),
    queryBytes,
  };
}

describe('hash-only schema capture evidence', () => {
  it('binds the checked-in query and artifact without storing captured bodies', () => {
    const evidence = buildSchemaCaptureEvidence(evidenceInputs(syntheticCapture()));
    const serialized = canonicalJson(evidence);

    expect(evidence.counts).toMatchObject({
      tables: 70,
      columns: 1061,
      custom_functions: 24,
      table_grants: 1929,
      routine_grants: 585,
    });
    expect(evidence.customFunctionDefinitionHashes).toHaveLength(24);
    expect(serialized).not.toContain('safe-function-body-marker');
    expect(serialized).not.toContain('safe-default-body-marker');
    expect(serialized).not.toContain('safe-constraint-body-marker');

    const frozen = SOURCE_CONTRACT.frozenSchemaCaptureHashes;
    expect(frozen.contents).toBe('HASHES_COUNTS_AND_FUNCTION_SIGNATURES_ONLY');
    expect(frozen.sourceArtifacts.repositoryStorage).toBe('FORBIDDEN');
    expect(frozen.sourceArtifacts.encryptedSchemaDumpState).toBe(
      'CAPTURED_ENCRYPTED_REVIEWED',
    );
    expect(frozen.sourceArtifacts.captureQuerySha256).toBe(
      createHash('sha256').update(queryBytes).digest('hex'),
    );
    expect(SOURCE_CONTRACT.frozenSchemaCaptureHashesArtifact.sha256).toBe(
      createHash('sha256')
        .update(
          readFileSync(
            join(root, 'migration/contracts/frozen-live-schema-capture-hashes.v1.json'),
          ),
        )
        .digest('hex'),
    );
    expect(frozen.customFunctionDefinitionsHash).toBe(
      SOURCE_CONTRACT.liveSchemaEvidence.customFunctionDefinitionEvidence.hash,
    );
    expect(JSON.stringify(frozen)).not.toContain('"definition":');

    const encryptedEvidenceBytes = readFileSync(
      join(
        root,
        'migration/contracts/frozen-encrypted-schema-dump-evidence.v1.json',
      ),
    );
    const encryptedEvidence = SOURCE_CONTRACT.frozenEncryptedSchemaDumpEvidence;
    expect(SOURCE_CONTRACT.frozenEncryptedSchemaDumpEvidenceArtifact.sha256).toBe(
      createHash('sha256').update(encryptedEvidenceBytes).digest('hex'),
    );
    expect(encryptedEvidence.dump).toMatchObject({
      compressedPlaintextBytes: 25886,
      tables: 70,
      functions: 24,
      policies: 118,
      triggers: 24,
      copyOrInsertStatements: 0,
      containsData: false,
    });
    expect(encryptedEvidence.encryption).toMatchObject({
      type: 'CLOUD_KMS',
      keyVersionState: 'ENABLED',
      roundTripVerified: true,
    });
    expect(encryptedEvidence.storage).toMatchObject({
      projectId: 'hushh-tech-uat',
      uniformBucketLevelAccess: true,
      publicAccessPrevention: 'enforced',
      versioning: true,
    });
    expect(encryptedEvidence.postCaptureVerification).toEqual({
      cliControlPlaneValidityRefreshObserved: true,
      loginRemainedDisabled: true,
      finalCleanupCanLogin: false,
      finalCleanupValidUntil: '1970-01-01T00:00:00Z',
      exactCleanupTimestampCaptured: false,
    });
    expect(encryptedEvidence.secretScan).toEqual({
      engine: 'gitleaks',
      findingCount: 0,
    });
    const encryptedEvidenceText = encryptedEvidenceBytes.toString('utf8');
    expect(encryptedEvidenceText).not.toMatch(/\bCREATE\s+(?:TABLE|FUNCTION)\b/i);
    expect(encryptedEvidenceText).not.toMatch(/"(?:definition|body|sql|ciphertextBase64)"\s*:/i);
  });

  it('rejects count drift, secret-shaped material, envelope drift, and write SQL', () => {
    const shortCapture = syntheticCapture();
    shortCapture.columns.pop();
    expect(() => buildSchemaCaptureEvidence(evidenceInputs(shortCapture))).toThrow(
      /locked live-schema count/,
    );

    const secretCapture = syntheticCapture();
    secretCapture.custom_functions[0].definition =
      `${['sk', 'live'].join('_')}_${'a'.repeat(36)}`;
    expect(() => buildSchemaCaptureEvidence(evidenceInputs(secretCapture))).toThrow(
      /secret-shaped material/,
    );

    const envelopeCapture = syntheticCapture();
    const envelopeInputs = evidenceInputs(envelopeCapture);
    envelopeInputs.rawEnvelope.rows = [];
    envelopeInputs.rawEnvelopeBytes = Buffer.from(
      JSON.stringify(envelopeInputs.rawEnvelope),
      'utf8',
    );
    expect(() => buildSchemaCaptureEvidence(envelopeInputs)).toThrow(
      /exactly the normalized schema capture/,
    );

    const writeInputs = evidenceInputs(syntheticCapture());
    writeInputs.queryBytes = Buffer.from(
      'BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ;\nDELETE FROM public.example;\nROLLBACK;\n',
      'utf8',
    );
    expect(() => buildSchemaCaptureEvidence(writeInputs)).toThrow(
      /read-only repeatable-read transaction/,
    );
  });
});
