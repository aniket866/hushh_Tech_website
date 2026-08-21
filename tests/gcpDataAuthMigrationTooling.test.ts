import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canonicalHash,
  canonicalRowHash,
} from '../scripts/gcp/migration/canonical-hash.mjs';
import {
  assertCheckpointContinuation,
  createCheckpoint,
  createMigrationRunPlan,
} from '../scripts/gcp/migration/checkpoints.mjs';
import {
  assertCdcReady,
  buildCdcPlan,
} from '../scripts/gcp/migration/cdc-plan.mjs';
import {
  CUSTOM_PUBLIC_FUNCTION_SIGNATURES,
  PUBLIC_TABLES,
  SOURCE_CONTRACT,
  assertDryRunOnly,
  assertMigrationBoundary,
  safeJsonForStdout,
} from '../scripts/gcp/migration/contract.mjs';
import {
  buildIdentityMappingPlan,
  validateTerminalDispositions,
} from '../scripts/gcp/migration/identity-mapping.mjs';
import {
  buildSourceInventoryReadOnlySql,
  validateRepositoryPolicyDeclarations,
  validateSourceInventory,
} from '../scripts/gcp/migration/source-inventory.mjs';

const root = process.cwd();

function legacyUuid(index: number) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
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

function frozenPolicyFact(entry: Record<string, unknown>) {
  const roles = String(entry.roles);
  if (!roles.startsWith('{') || !roles.endsWith('}')) {
    throw new Error('Invalid frozen policy roles.');
  }
  return {
    schema: entry.schemaname,
    table: entry.tablename,
    name: entry.policyname,
    command: entry.cmd,
    permissive: entry.permissive,
    roles: roles.slice(1, -1).split(',').filter(Boolean),
    usingExpression: entry.qual,
    checkExpression: entry.with_check,
  };
}

function frozenFunctionFact(entry: Record<string, unknown>) {
  const signature = `${entry.function_name}(${entry.identity_arguments})->${entry.result_type}`;
  const isCustom = CUSTOM_PUBLIC_FUNCTION_SIGNATURES.includes(signature);
  const kind = ({
    f: 'FUNCTION',
    p: 'PROCEDURE',
    a: 'AGGREGATE',
  } as Record<string, string>)[String(entry.prokind)];
  const volatility = ({
    i: 'IMMUTABLE',
    s: 'STABLE',
    v: 'VOLATILE',
  } as Record<string, string>)[String(entry.volatility)];
  if (!kind || !volatility) throw new Error('Invalid frozen function contract.');
  return {
    schema: 'public',
    name: entry.function_name,
    identityArguments: entry.identity_arguments,
    resultType: entry.result_type,
    language: 'captured-at-runtime',
    kind,
    volatility,
    securityDefiner: entry.security_definer,
    extensionOwned: !isCustom,
    definitionHash: isCustom
      ? canonicalHash({ signature, bodyEvidence: 'not-captured-blocking' })
      : null,
  };
}

function syntheticInputs() {
  const authUsers = Array.from({ length: 369 }, (_, index) => {
    if (index >= 165 && index < 168) {
      return {
        legacyUserUuid: legacyUuid(index + 1),
        providerSubjects: [
          { providerId: 'apple.com', subject: `synthetic-apple-${index}` },
        ],
        emailPresent: false,
        passwordCredential: { present: false, algorithm: null },
      };
    }
    if (index >= 168 && index < 172) {
      const hasBcrypt = index < 170;
      return {
        legacyUserUuid: legacyUuid(index + 1),
        providerSubjects: [],
        emailPresent: true,
        email: 'shared-evidence@example.test',
        passwordCredential: {
          present: hasBcrypt,
          algorithm: hasBcrypt ? 'BCRYPT' : null,
        },
      };
    }
    return {
      legacyUserUuid: legacyUuid(index + 1),
      providerSubjects: [
        { providerId: 'google.com', subject: `synthetic-google-${index}` },
      ],
      emailPresent: true,
      passwordCredential: { present: false, algorithm: null },
    };
  });
  const defaultsByTable = new Map<string, Array<Record<string, string>>>();
  for (const fact of SOURCE_CONTRACT.frozenSchemaFacts.defaultExpressionHashes) {
    const entries = defaultsByTable.get(fact.table) ?? [];
    entries.push(fact);
    defaultsByTable.set(fact.table, entries);
  }
  const tables = PUBLIC_TABLES.map((name, index) => {
    const defaultFacts = defaultsByTable.get(name) ?? [];
    const defaultColumns = defaultFacts.map((fact) => ({
      name: fact.column,
      dataType: 'text',
      udtSchema: 'pg_catalog',
      udtName: 'text',
      nullable: false,
      hasDefault: true,
      defaultExpressionHash: fact.defaultExpressionHash,
      identity: false,
      generated: false,
    }));
    const columnsWithoutOrdinals = defaultColumns.some(({ name: column }) => column === 'id')
      ? defaultColumns
      : [
          {
            name: 'id',
            dataType: 'uuid',
            udtSchema: 'pg_catalog',
            udtName: 'uuid',
            nullable: false,
            hasDefault: false,
            defaultExpressionHash: null,
            identity: false,
            generated: false,
          },
          ...defaultColumns,
        ];
    return {
      schema: 'public',
      name,
      rowCount: index === 0 ? 44_811 : 0,
      primaryKey: ['id'],
      columns: columnsWithoutOrdinals.map((column, ordinalIndex) => ({
        ...column,
        ordinalPosition: ordinalIndex + 1,
      })),
    };
  });
  const frozenPolicies = SOURCE_CONTRACT.frozenSchemaFacts.policies.map(frozenPolicyFact);
  const frozenFunctions = SOURCE_CONTRACT.frozenSchemaFacts.functions.map(frozenFunctionFact);
  const inventory = {
    version: 1,
    source: {
      projectRef: 'ibsisfnjxeowvdtvgzff',
      database: 'postgres',
      schema: 'public',
      readOnly: true,
    },
    tables,
    schemaFacts: {
      foreignKeys: [
        {
          schema: 'public',
          table: 'agent_reviews',
          name: 'agent_reviews_profile_fk',
          definition: 'FOREIGN KEY (id) REFERENCES agent_profiles(id)',
        },
      ],
      checkConstraints: [
        {
          schema: 'public',
          table: 'agent_profiles',
          name: 'agent_profiles_id_check',
          definition: 'CHECK (id IS NOT NULL)',
        },
      ],
      indexes: [
        {
          schema: 'public',
          table: 'agent_profiles',
          name: 'agent_profiles_pkey',
          definition: 'UNIQUE INDEX agent_profiles_pkey USING btree (id)',
        },
      ],
      sequences: [
        {
          schema: 'public',
          name: 'synthetic_sequence',
          dataType: 'bigint',
          startValue: '1',
          minValue: '1',
          maxValue: '9223372036854775807',
          incrementBy: '1',
          cycle: false,
          cacheSize: '1',
          ownedBy: null,
        },
      ],
      triggers: [
        {
          schema: 'public',
          table: 'agent_profiles',
          name: 'agent_profiles_audit_trigger',
          functionSchema: 'public',
          functionName: 'synthetic_audit',
          definition: 'TRIGGER agent_profiles_audit_trigger BEFORE UPDATE ON agent_profiles',
        },
      ],
      functions: frozenFunctions,
      publicPolicies: frozenPolicies.filter(({ schema }) => schema === 'public'),
      storagePolicies: frozenPolicies.filter(({ schema }) => schema === 'storage'),
      extensions: [
        { name: 'pgcrypto', schema: 'extensions', version: '1.3' },
      ],
      grants: [
        {
          objectType: 'TABLE',
          objectSchema: 'public',
          objectName: 'agent_profiles',
          grantee: 'authenticated',
          privilege: 'SELECT',
          isGrantable: false,
        },
      ],
    },
    catalogCounts: {
      publicTables: 70,
      columns: tables.reduce((total, table) => total + table.columns.length, 0),
      foreignKeys: 1,
      checkConstraints: 1,
      indexes: 1,
      sequences: 1,
      triggers: 1,
      publicFunctionSignatures: 142,
      customPublicFunctions: 24,
      applicationRpcs: 16,
      customTriggerFunctions: 8,
      publicPolicies: 118,
      storagePolicies: 10,
      extensions: 1,
      grants: 1,
      authUsers: 369,
    },
    rowCountCapture: {
      baselineRowCount: 44_811,
      observedDelta: 0,
    },
    frozenLiveEvidence: { ...SOURCE_CONTRACT.liveSchemaEvidence },
    schemaDumpArtifact: {
      state: 'NOT_CAPTURED_BLOCKING',
      sha256: null,
      encryption: null,
      reviewed: false,
      containsData: false,
    },
    authUsers,
  };
  const firebaseAuthority = {
    projectId: 'hushh-pda',
    tenantId: null,
    users: Array.from({ length: 165 }, (_, index) => ({
      firebaseUid: `existing_firebase_${index}`,
      ...(index === 0 ? { email: 'shared-evidence@example.test' } : {}),
      providerSubjects: [
        { providerId: 'google.com', subject: `synthetic-google-${index}` },
      ],
    })),
  };
  const unclaimedLegacyPrincipals = Array.from({ length: 65 }, (_, index) => ({
    legacyUserUuid: legacyUuid(1000 + index),
  }));
  return { inventory, firebaseAuthority, unclaimedLegacyPrincipals };
}

describe('locked migration boundary', () => {
  it('documents every required frozen live-evidence count', () => {
    const readme = readFileSync(join(root, 'migration/README.md'), 'utf8');
    const evidenceStart = readme.indexOf('"frozenLiveEvidence"');
    const evidenceEnd = readme.indexOf('"schemaDumpArtifact"', evidenceStart);

    expect(evidenceStart).toBeGreaterThanOrEqual(0);
    expect(evidenceEnd).toBeGreaterThan(evidenceStart);
    expect(readme.slice(evidenceStart, evidenceEnd)).toContain(
      '"defaultExpressions": 381',
    );
  });

  it('freezes the 70/369 source and dedicated PostgreSQL 17 targets', () => {
    expect(PUBLIC_TABLES).toHaveLength(70);
    expect(new Set(PUBLIC_TABLES).size).toBe(70);
    expect(SOURCE_CONTRACT.expected.authUsers).toBe(369);
    expect(SOURCE_CONTRACT.expected.baselineRowCount).toBe(44_811);
    expect(SOURCE_CONTRACT.expected.repoPolicyDeclarations).toBe(203);
    expect(SOURCE_CONTRACT.expected.livePublicPolicies).toBe(118);
    expect(SOURCE_CONTRACT.expected.liveStoragePolicies).toBe(10);
    expect(SOURCE_CONTRACT.expected.livePublicFunctionSignatures).toBe(142);
    expect(SOURCE_CONTRACT.expected.liveCustomPublicFunctions).toBe(24);
    expect(SOURCE_CONTRACT.expected.applicationRpcs).toBe(16);
    expect(SOURCE_CONTRACT.expected.customTriggerFunctions).toBe(8);
    expect(SOURCE_CONTRACT.expected.defaultExpressions).toBe(381);
    expect(SOURCE_CONTRACT.firebaseAuthority).toEqual({
      projectId: 'hushh-pda',
      tenantId: null,
    });
    expect(SOURCE_CONTRACT.frozenSchemaFacts.policies).toHaveLength(128);
    expect(SOURCE_CONTRACT.frozenSchemaFacts.functions).toHaveLength(142);
    expect(SOURCE_CONTRACT.frozenSchemaFacts.defaultExpressionHashes).toHaveLength(381);
    expect(CUSTOM_PUBLIC_FUNCTION_SIGNATURES).toHaveLength(24);
    expect(SOURCE_CONTRACT.retirementManifest).toEqual({
      path: 'migration/manifests/supabase-retirement.v1.json',
      tableDigestAlgorithm: 'sha256_sorted_newline_v1',
      publicTablesDigest:
        'a5c06f073e40554d69923e1d75e8457dfaaadba70e7ada196d6f4d1a1b592d4e',
    });
    expect(SOURCE_CONTRACT.targets.uat).toEqual({
      projectId: 'hushh-tech-uat',
      region: 'us-central1',
      instance: 'hushh-tech-app-pg-uat',
      database: 'hushh_tech_app',
      postgresMajor: 17,
    });
    expect(SOURCE_CONTRACT.targets.production.instance).toBe(
      'hushh-tech-app-pg-prod',
    );
    expect(Object.isFrozen(SOURCE_CONTRACT.targets.uat)).toBe(true);
    expect(Object.isFrozen(SOURCE_CONTRACT.publicTables)).toBe(true);
    expect(validateRepositoryPolicyDeclarations()).toMatchObject({ count: 203 });
  });

  it('refuses wrong projects, instances, databases, and execution flags', () => {
    expect(() =>
      assertMigrationBoundary({
        environment: 'uat',
        sourceProjectRef: 'ibsisfnjxeowvdtvgzff',
        sourceDatabase: 'postgres',
        targetProject: 'hushh-tech-prod',
        targetRegion: 'us-central1',
        targetInstance: 'hushh-tech-app-pg-uat',
        targetDatabase: 'hushh_tech_app',
        postgresMajor: 17,
      }),
    ).toThrow(/targetProject/);
    expect(() => assertDryRunOnly({ execute: true })).toThrow(/plan-only/);
    expect(() => assertDryRunOnly({ execute: 'false' })).toThrow(/plan-only/);
    expect(() => assertDryRunOnly({ apply: true })).toThrow(/plan-only/);
    expect(() => assertDryRunOnly({ dryRun: false })).toThrow(/plan-only/);
  });

  it('fails closed through the CLI without echoing a rejected target value', () => {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/gcp/migration/plan-cutover.mjs',
        '--environment=uat',
        '--source-project-ref=ibsisfnjxeowvdtvgzff',
        '--source-database=postgres',
        '--target-project=wrong-sensitive-target',
        '--target-region=us-central1',
        '--target-instance=hushh-tech-app-pg-uat',
        '--target-database=hushh_tech_app',
        '--postgres-major=17',
        '--dry-run',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('BOUNDARY_MISMATCH');
    expect(result.stderr).not.toContain('wrong-sensitive-target');
  });
});

describe('read-only source inventory', () => {
  it('accepts only all 70 tables with primary keys and 369 unique Auth users', () => {
    const { inventory } = syntheticInputs();
    const summary = validateSourceInventory(inventory, uatBoundary());
    expect(summary).toMatchObject({
      mode: 'READ_ONLY_SNAPSHOT',
      publicTableCount: 70,
      authUserCount: 369,
      totalRowCount: 44_811,
      baselineRowCount: 44_811,
      observedRowCountDelta: 0,
      repositoryPolicyDeclarationCount: 203,
      publicPolicyCount: 118,
      storagePolicyCount: 10,
      publicFunctionSignatureCount: 142,
      customPublicFunctionCount: 24,
      rpcCount: 16,
      customTriggerFunctionCount: 8,
      schemaDumpArtifactReady: false,
      applyReady: false,
    });
    expect(summary.blockers).toEqual([
      'PLAN_ONLY_EXECUTION',
      'CUSTOM_FUNCTION_DEFINITION_EVIDENCE_NOT_CAPTURED',
      'ENCRYPTED_SCHEMA_DUMP_ARTIFACT_NOT_CAPTURED',
    ]);
    const reordered = {
      ...inventory,
      tables: [...inventory.tables].reverse().map((table) => ({
        ...table,
        columns: [...table.columns].reverse(),
      })),
      schemaFacts: Object.fromEntries(
        Object.entries(inventory.schemaFacts).map(([key, entries]) => [
          key,
          [...entries].reverse().map((entry) =>
            'roles' in entry ? { ...entry, roles: [...entry.roles].reverse() } : entry,
          ),
        ]),
      ),
      authUsers: [...inventory.authUsers].reverse(),
    };
    expect(validateSourceInventory(reordered, uatBoundary()).inventoryHash).toBe(
      summary.inventoryHash,
    );
    const laterCapture = {
      ...inventory,
      tables: inventory.tables.map((table, index) =>
        index === 0 ? { ...table, rowCount: table.rowCount + 2 } : table,
      ),
      rowCountCapture: { ...inventory.rowCountCapture, observedDelta: 2 },
    };
    expect(validateSourceInventory(laterCapture, uatBoundary())).toMatchObject({
      totalRowCount: 44_813,
      baselineRowCount: 44_811,
      observedRowCountDelta: 2,
    });
  });

  it('rejects missing tables, user-count drift, and raw password material', () => {
    const { inventory } = syntheticInputs();
    expect(() =>
      validateSourceInventory(
        { ...inventory, tables: inventory.tables.slice(1) },
        uatBoundary(),
      ),
    ).toThrow(/70 allowlisted/);
    expect(() =>
      validateSourceInventory(
        { ...inventory, authUsers: inventory.authUsers.slice(1) },
        uatBoundary(),
      ),
    ).toThrow(/369 Auth users/);
    expect(() =>
      validateSourceInventory(
        {
          ...inventory,
          authUsers: [
            { ...inventory.authUsers[0], passwordHash: 'must-not-enter-contract' },
            ...inventory.authUsers.slice(1),
          ],
        },
        uatBoundary(),
      ),
    ).toThrow(/must not enter/);
    expect(() =>
      validateSourceInventory(
        {
          ...inventory,
          sourceUri: ['postgresql:', '//must-not-enter'].join(''),
        },
        uatBoundary(),
      ),
    ).toThrow(/secret-shaped material/);
    expect(() =>
      validateSourceInventory(
        {
          ...inventory,
          schemaFacts: {
            ...inventory.schemaFacts,
            publicPolicies: inventory.schemaFacts.publicPolicies.slice(1),
          },
        },
        uatBoundary(),
      ),
    ).toThrow(/118 live public policies/);
    expect(() =>
      validateSourceInventory(
        {
          ...inventory,
          schemaFacts: {
            ...inventory.schemaFacts,
            functions: inventory.schemaFacts.functions.slice(1),
          },
        },
        uatBoundary(),
      ),
    ).toThrow(/142 live public function signatures/);
    expect(() =>
      validateSourceInventory(
        {
          ...inventory,
          catalogCounts: { ...inventory.catalogCounts, publicTables: 71 },
        },
        uatBoundary(),
      ),
    ).toThrow(/metadata count/);
    expect(() =>
      validateSourceInventory(
        {
          ...inventory,
          rowCountCapture: { ...inventory.rowCountCapture, observedDelta: 1 },
        },
        uatBoundary(),
      ),
    ).toThrow(/44,811 baseline/);
    expect(() =>
      validateSourceInventory(
        {
          ...inventory,
          frozenLiveEvidence: {
            ...inventory.frozenLiveEvidence,
            publicPoliciesHash: canonicalHash('wrong-evidence'),
          },
        },
        uatBoundary(),
      ),
    ).toThrow(/exact frozen sanitized/);
    expect(() =>
      validateSourceInventory(
        {
          ...inventory,
          schemaFacts: {
            ...inventory.schemaFacts,
            functions: inventory.schemaFacts.functions.map((entry) =>
              entry.extensionOwned === false && entry.name === 'batch_agent_selections'
                ? { ...entry, resultType: 'text' }
                : entry,
            ),
          },
        },
        uatBoundary(),
      ),
    ).toThrow(/24-signature allowlist/);
  });

  it('rejects frozen default drift and keeps custom body evidence blocking', () => {
    const { inventory } = syntheticInputs();
    const first = validateSourceInventory(inventory, uatBoundary());
    const changed = {
      ...inventory,
      tables: inventory.tables.map((table, index) =>
        index === 0
          ? {
              ...table,
              columns: table.columns.map((column) => ({
                ...column,
                defaultExpressionHash: canonicalHash('changed-default-expression'),
              })),
            }
          : table,
      ),
    };
    expect(() => validateSourceInventory(changed, uatBoundary())).toThrow(
      /defaultExpressionHashesHash does not match/,
    );
    expect(() =>
      validateSourceInventory(
        {
          ...inventory,
          schemaFacts: {
            ...inventory.schemaFacts,
            functions: inventory.schemaFacts.functions.map((entry) =>
              entry.extensionOwned === false && entry.name === 'batch_agent_selections'
                ? { ...entry, definitionHash: null }
                : entry,
            ),
          },
        },
        uatBoundary(),
      ),
    ).toThrow(/definitions require SHA-256 hashes/);

    const reviewedSchemaArtifact = {
      ...inventory,
      schemaDumpArtifact: {
        state: 'CAPTURED_ENCRYPTED_REVIEWED',
        sha256: canonicalHash('synthetic-encrypted-schema-only-dump'),
        encryption: 'CLOUD_KMS',
        reviewed: true,
        containsData: false,
      },
    };
    expect(validateSourceInventory(reviewedSchemaArtifact, uatBoundary())).toMatchObject({
      schemaDumpArtifactReady: true,
      applyReady: false,
      blockers: [
        'PLAN_ONLY_EXECUTION',
        'CUSTOM_FUNCTION_DEFINITION_EVIDENCE_NOT_CAPTURED',
      ],
    });
    expect(first.blockers).toContain('CUSTOM_FUNCTION_DEFINITION_EVIDENCE_NOT_CAPTURED');
  });

  it('rejects exact frozen policy and function contract drift', () => {
    const { inventory } = syntheticInputs();
    expect(() =>
      validateSourceInventory(
        {
          ...inventory,
          schemaFacts: {
            ...inventory.schemaFacts,
            publicPolicies: inventory.schemaFacts.publicPolicies.map((entry, index) =>
              index === 0 ? { ...entry, usingExpression: '(false)' } : entry,
            ),
          },
        },
        uatBoundary(),
      ),
    ).toThrow(/publicPoliciesHash does not match/);
    expect(() =>
      validateSourceInventory(
        {
          ...inventory,
          schemaFacts: {
            ...inventory.schemaFacts,
            functions: inventory.schemaFacts.functions.map((entry) =>
              entry.extensionOwned === true && entry.name === 'array_to_halfvec'
                ? { ...entry, name: 'different_extension_contract' }
                : entry,
            ),
          },
        },
        uatBoundary(),
      ),
    ).toThrow(/publicFunctionSignaturesHash does not match/);
  });

  it('keeps the reviewed SQL transaction read-only and in sync with the generator', () => {
    const checkedInSql = readFileSync(
      join(root, 'migration/sql/source_inventory_read_only.sql'),
      'utf8',
    ).trim();
    const generatedSql = buildSourceInventoryReadOnlySql();
    expect(generatedSql).toBe(checkedInSql);
    expect(generatedSql).toContain('READ ONLY');
    expect(generatedSql).toContain('ROLLBACK;');
    expect(generatedSql).toContain("'foreign_keys'::text AS inventory_section");
    expect(generatedSql).toContain("'check_constraints'::text AS inventory_section");
    expect(generatedSql).toContain("'indexes'::text AS inventory_section");
    expect(generatedSql).toContain("'sequences'::text AS inventory_section");
    expect(generatedSql).toContain("'triggers'::text AS inventory_section");
    expect(generatedSql).toContain("'functions'::text AS inventory_section");
    expect(generatedSql).toContain("'public_policies'::text AS inventory_section");
    expect(generatedSql).toContain("'storage_policies'::text AS inventory_section");
    expect(generatedSql).toContain("'extensions'::text AS inventory_section");
    expect(generatedSql).toContain("'grants'::text AS inventory_section");
    expect(generatedSql).toContain("'catalog_counts'::text AS inventory_section");
    expect(generatedSql).toContain('default_expression_hash');
    expect(generatedSql).toContain('definition_hash');
    expect(generatedSql).toContain("prokind IN ('f', 'p', 'a')");
    expect(generatedSql).not.toContain('AS column_default');
    expect(generatedSql).not.toContain('AS function_definition');
    expect(generatedSql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/);
  });
});

describe('identity mapping', () => {
  it('produces the locked 165 existing / 204 new / 3 Apple / 4 password / 65 denied result', () => {
    const inputs = syntheticInputs();
    const plan = buildIdentityMappingPlan({
      ...inputs,
      boundary: uatBoundary(),
    });
    const counts = validateTerminalDispositions(plan);
    expect(counts).toEqual({
      linkedExistingFirebase: 165,
      importedFirebase: 204,
      manualRecovery: 0,
      legallyRetainedNoLogin: 0,
      intentionallyDeleted: 0,
      appleNoEmail: 3,
      emailPasswordUsers: 4,
      unclaimedLegacyPrincipals: 65,
      emailOnlyLinks: 0,
      authTerminalCount: 369,
    });

    const appleMappings = plan.authMappings.filter((mapping) => mapping.appleNoEmail);
    expect(new Set(appleMappings.map(({ firebaseUid }) => firebaseUid)).size).toBe(3);
    expect(appleMappings.every(({ mappingBasis }) => mappingBasis === 'PROVIDER_SUBJECT')).toBe(
      true,
    );

    const passwordMappings = plan.authMappings.filter(
      (mapping) => mapping.isEmailPasswordUser,
    );
    expect(passwordMappings.map(({ passwordAction }) => passwordAction).sort()).toEqual([
      'IMPORT_BCRYPT',
      'IMPORT_BCRYPT',
      'PASSWORD_SETUP_REQUIRED',
      'PASSWORD_SETUP_REQUIRED',
    ]);
    expect(plan.unclaimedMappings.every((mapping) => !mapping.accessAllowed)).toBe(true);
  });

  it('never links on a shared email and remains deterministic across replay', () => {
    const inputs = syntheticInputs();
    const first = buildIdentityMappingPlan({ ...inputs, boundary: uatBoundary() });
    const second = buildIdentityMappingPlan({ ...inputs, boundary: uatBoundary() });
    const emailOnlySource = first.authMappings[168];
    expect(emailOnlySource.status).toBe('IMPORTED_FIREBASE');
    expect(emailOnlySource.mappingBasis).toBe('LEGACY_UUID');
    expect(emailOnlySource.emailWasUsed).toBe(false);
    expect(second.mappingInputHash).toBe(first.mappingInputHash);
    expect(second.authMappings).toEqual(first.authMappings);

    const changedEmailInputs = {
      ...inputs,
      inventory: {
        ...inputs.inventory,
        authUsers: inputs.inventory.authUsers.map((user) => ({
          ...user,
          email: 'different-email-evidence@example.test',
        })),
      },
      firebaseAuthority: {
        ...inputs.firebaseAuthority,
        users: inputs.firebaseAuthority.users.map((user) => ({
          ...user,
          email: 'different-email-evidence@example.test',
        })),
      },
    };
    const emailChanged = buildIdentityMappingPlan({
      ...changedEmailInputs,
      boundary: uatBoundary(),
    });
    expect(emailChanged.mappingInputHash).toBe(first.mappingInputHash);
    expect(emailChanged.authMappings).toEqual(first.authMappings);
  });

  it('fails closed to manual recovery when one provider subject maps to two Firebase UIDs', () => {
    const inputs = syntheticInputs();
    inputs.firebaseAuthority.users.push({
      firebaseUid: 'conflicting_firebase_uid',
      providerSubjects: [
        { providerId: 'google.com', subject: 'synthetic-google-0' },
      ],
    });
    const plan = buildIdentityMappingPlan({ ...inputs, boundary: uatBoundary() });
    expect(plan.authMappings[0]).toMatchObject({
      status: 'MANUAL_RECOVERY',
      firebaseUid: null,
      accessAllowed: false,
    });
    expect(validateTerminalDispositions(plan, { enforceLockedBaseline: false })).toMatchObject({
      manualRecovery: 1,
      emailOnlyLinks: 0,
      authTerminalCount: 369,
    });
    expect(() => validateTerminalDispositions(plan)).toThrow(/frozen 165\/204\/3\/4\/65/);
  });

  it('rejects wrong Firebase authority and generated UID collisions', () => {
    const inputs = syntheticInputs();
    expect(() =>
      buildIdentityMappingPlan({
        ...inputs,
        boundary: uatBoundary(),
        firebaseAuthority: {
          ...inputs.firebaseAuthority,
          projectId: 'wrong-project',
        },
      }),
    ).toThrow(/hushh-pda authority envelope/);
    expect(() =>
      buildIdentityMappingPlan({
        ...inputs,
        boundary: uatBoundary(),
        firebaseAuthority: inputs.firebaseAuthority.users,
      }),
    ).toThrow(/hushh-pda authority envelope/);

    const initial = buildIdentityMappingPlan({ ...inputs, boundary: uatBoundary() });
    const collidingUid = initial.authMappings[165].firebaseUid;
    expect(() =>
      buildIdentityMappingPlan({
        ...inputs,
        boundary: uatBoundary(),
        firebaseAuthority: {
          ...inputs.firebaseAuthority,
          users: [
            ...inputs.firebaseAuthority.users,
            { firebaseUid: collidingUid, providerSubjects: [] },
          ],
        },
      }),
    ).toThrow(/already belongs to an existing Firebase identity/);
  });

  it('rejects exact provider-subject overlap across source Auth users', () => {
    const inputs = syntheticInputs();
    inputs.inventory.authUsers[166].providerSubjects = [
      { ...inputs.inventory.authUsers[165].providerSubjects[0] },
    ];

    expect(() =>
      buildIdentityMappingPlan({ ...inputs, boundary: uatBoundary() }),
    ).toThrow(
      expect.objectContaining({ code: 'DUPLICATE_SOURCE_PROVIDER_SUBJECT' }),
    );
  });

  it('rejects provider-subject subset overlap across source Auth users', () => {
    const inputs = syntheticInputs();
    inputs.inventory.authUsers[166].providerSubjects = [
      ...inputs.inventory.authUsers[166].providerSubjects,
      { ...inputs.inventory.authUsers[165].providerSubjects[0] },
    ];

    expect(() =>
      buildIdentityMappingPlan({ ...inputs, boundary: uatBoundary() }),
    ).toThrow(
      expect.objectContaining({ code: 'DUPLICATE_SOURCE_PROVIDER_SUBJECT' }),
    );
  });
});

describe('canonical hashes and resumable checkpoints', () => {
  it('hashes key-order variants identically and content changes differently', () => {
    const first = canonicalRowHash({
      table: 'agent_profiles',
      primaryKey: { id: 'row-1' },
      row: { id: 'row-1', nested: { b: 2, a: 1 } },
    });
    const reordered = canonicalRowHash({
      table: 'agent_profiles',
      primaryKey: { id: 'row-1' },
      row: { nested: { a: 1, b: 2 }, id: 'row-1' },
    });
    const changed = canonicalRowHash({
      table: 'agent_profiles',
      primaryKey: { id: 'row-1' },
      row: { id: 'row-1', nested: { a: 1, b: 3 } },
    });
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
    expect(() =>
      canonicalRowHash({
        table: 'not_allowlisted',
        primaryKey: { id: 1 },
        row: { id: 1 },
      }),
    ).toThrow(/outside the 70-table allowlist/);
  });

  it('builds deterministic replay keys and a tamper-evident checkpoint chain', () => {
    const sourceInventoryHash = canonicalHash({ inventory: 1 });
    const mappingInputHash = canonicalHash({ mappings: 369 });
    const run = createMigrationRunPlan({
      sourceInventoryHash,
      mappingInputHash,
      target: uatBoundary().target,
    });
    const replay = createMigrationRunPlan({
      sourceInventoryHash,
      mappingInputHash,
      target: uatBoundary().target,
    });
    expect(replay.replayKey).toBe(run.replayKey);

    const first = createCheckpoint({
      replayKey: run.replayKey,
      stream: 'public.agent_profiles',
      sequence: 0,
      cursor: { id: 'row-1' },
      rowHashes: [canonicalHash({ id: 'row-1' })],
    });
    const second = createCheckpoint({
      replayKey: run.replayKey,
      stream: 'public.agent_profiles',
      sequence: 1,
      cursor: { id: 'row-2' },
      rowHashes: [canonicalHash({ id: 'row-2' })],
      previousCheckpointHash: first.checkpointHash,
    });
    expect(assertCheckpointContinuation(first, second)).toBe(true);
    expect(() =>
      assertCheckpointContinuation(first, { ...second, previousCheckpointHash: canonicalHash('x') }),
    ).toThrow(/Checkpoint/);
  });
});

describe('CDC plan and secret-safe output', () => {
  it('blocks CDC until stable external connectivity is proven without printing addresses', () => {
    const blockedPlan = buildCdcPlan(uatBoundary());
    expect(blockedPlan.readiness).toMatchObject({
      status: 'BLOCKED_PRECONDITION',
      cdcReady: false,
      actualIpAddressesEmitted: false,
    });
    expect(blockedPlan.readiness.blockers).toContain(
      'TARGET_STABLE_OUTGOING_IP_MODE_NOT_ENABLED',
    );
    expect(blockedPlan.readiness.blockers).toContain(
      'TARGET_STABLE_OUTGOING_IP_NOT_VERIFIED',
    );
    expect(blockedPlan.target.enableAfterGovernedVerificationSql).toBeNull();
    expect(() => assertCdcReady(blockedPlan)).toThrow(/cannot attest live connectivity/);

    const plan = buildCdcPlan(uatBoundary(), {
      dryRun: true,
      sourceDirectConnectivityVerified: true,
      sourceIpv4AddonVerified: true,
      targetOutgoingIpMode: 'TEMPORARY_PUBLIC_IPV4',
      targetOutgoingIpVerified: true,
      connectivityEvidenceHash: canonicalHash({ synthetic: 'connectivity-preflight' }),
    });
    expect(() => assertCdcReady(plan)).toThrow(/cannot attest live connectivity/);
    expect(() =>
      assertCdcReady({ readiness: { cdcReady: true } }),
    ).toThrow(/cannot attest live connectivity/);
    expect(plan.readiness).toMatchObject({
      status: 'BLOCKED_PRECONDITION',
      cdcReady: false,
      actualIpAddressesEmitted: false,
    });
    expect(plan.readiness.blockers).toContain(
      'LIVE_ATTESTATION_EXECUTOR_REQUIRED',
    );
    expect(plan.readiness.preflight.claimsOnly).toBe(true);
    expect(plan.target.enableAfterGovernedVerificationSql).toBeNull();
    expect(plan.safety.sourceTableCount).toBe(70);
    expect(plan.source.publicationSql.match(/"public"\./g)).toHaveLength(70);
    expect(plan.source.slotSql).toContain("'pgoutput'");
    expect(plan.target.disabledSubscriptionSqlTemplate).toContain('copy_data = true');
    expect(plan.target.disabledSubscriptionSqlTemplate).toContain('create_slot = false');
    expect(plan.target.disabledSubscriptionSqlTemplate).toContain('enabled = false');
    expect(plan.safety.subscriberTopology).toBe('ZONAL');
    expect(plan.safety.regionalHaAllowedDuringCdc).toBe(false);
    expect(plan.lifecycle.indexOf('VERIFY_STABLE_TARGET_OUTGOING_IP')).toBeLessThan(
      plan.lifecycle.indexOf('CREATE_SCOPED_PUBLICATION'),
    );
    expect(plan.lifecycle.indexOf('DISABLE_AND_DROP_SUBSCRIPTION')).toBeLessThan(
      plan.lifecycle.indexOf('ENABLE_REGIONAL_HA'),
    );
    expect(plan.lifecycle.indexOf('REMOVE_PUBLIC_CONNECTIVITY')).toBeLessThan(
      plan.lifecycle.indexOf('ENABLE_REGIONAL_HA'),
    );
    expect(JSON.stringify(plan)).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(JSON.stringify(plan)).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(
      buildCdcPlan(uatBoundary(), {
        sourceDirectConnectivityVerified: true,
        sourceIpv4AddonVerified: true,
        targetOutgoingIpMode: 'TEMPORARY_PUBLIC_IPV4',
        targetOutgoingIpVerified: true,
        connectivityEvidenceHash: 'not-a-sha256',
      }).readiness.blockers,
    ).toContain('CONNECTIVITY_EVIDENCE_HASH_REQUIRED');
    expect(() =>
      buildCdcPlan(uatBoundary(), {
        targetOutgoingIpMode: '203.0.113.10',
      }),
    ).toThrow(/approved non-address enum/);
    const rejectedAddress = spawnSync(
      process.execPath,
      [
        'scripts/gcp/migration/plan-cutover.mjs',
        '--environment=uat',
        '--source-project-ref=ibsisfnjxeowvdtvgzff',
        '--source-database=postgres',
        '--target-project=hushh-tech-uat',
        '--target-region=us-central1',
        '--target-instance=hushh-tech-app-pg-uat',
        '--target-database=hushh_tech_app',
        '--postgres-major=17',
        '--target-outgoing-ip-mode=203.0.113.10',
        '--dry-run',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(rejectedAddress.status).toBe(1);
    expect(rejectedAddress.stdout).toBe('');
    expect(rejectedAddress.stderr).toContain('INVALID_CDC_PREFLIGHT');
    expect(rejectedAddress.stderr).not.toContain('203.0.113.10');
    expect(() =>
      buildCdcPlan({
        ...uatBoundary(),
        target: { ...uatBoundary().target, projectId: 'wrong-project' },
      }),
    ).toThrow(/targetProject/);
  });

  it('blocks secret-shaped keys and values from standard output', () => {
    expect(() => safeJsonForStdout({ password: 'not-printed' })).toThrow(
      /not allowed in standard output/,
    );
    const sourceUri = ['postgresql:', '//redacted'].join('');
    expect(() => safeJsonForStdout({ value: sourceUri })).toThrow(
      /secret-shaped material/,
    );
    expect(() => safeJsonForStdout({ value: '-----BEGIN PRIVATE KEY-----' })).toThrow(
      /secret-shaped material/,
    );
  });

  it('checks in the guarded identity, audit, checkpoint, outbox, and RLS schema', () => {
    const sql = readFileSync(
      join(root, 'migration/sql/001_identity_migration_foundation.sql'),
      'utf8',
    );
    expect(sql).toContain("current_database() <> 'hushh_tech_app'");
    expect(sql).toContain('requires PostgreSQL 17');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    expect(sql).toContain("extname = 'pgcrypto'");
    expect(sql).toMatch(/runtime role is\s+-- DML-only/);
    expect(sql).toContain('hushh_identity.identity_links');
    expect(sql).toContain('UNCLAIMED_LEGACY_PRINCIPAL');
    expect(sql).toContain('hushh_migration.identity_migration_dispositions');
    expect(sql).toContain('LINKED_EXISTING_FIREBASE');
    expect(sql).toContain('IMPORTED_FIREBASE');
    expect(sql).toContain('MANUAL_RECOVERY');
    expect(sql).toContain('LEGALLY_RETAINED_NO_LOGIN');
    expect(sql).toContain('INTENTIONALLY_DELETED');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("current_setting('app.firebase_uid', true)");
    expect(sql).toContain('hushh_migration.migration_checkpoints');
    expect(sql).toContain('hushh_migration.migration_audit_events');
    expect(sql).toContain('migration audit events are append-only');
    expect(sql).toContain('hushh_migration.migration_outbox');
    expect(sql).not.toMatch(/\b(?:email)\s*=|auth\.uid\(\)/i);
  });
});
