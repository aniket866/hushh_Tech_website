import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GENERIC_DELETE_FUNCTIONS,
  TARGET_SCHEMA_OWNER_ROLE,
  TARGET_SCHEMA_PHASES,
  compileTargetSchema,
  runTargetSchemaCompilerCli,
  validateCompiledTargetSchema,
  writePrivateTargetSchemaPlan,
} from '../scripts/gcp/migration/target-schema-compiler.mjs';
import { canonicalHash } from '../scripts/gcp/migration/canonical-hash.mjs';
import { SOURCE_CONTRACT } from '../scripts/gcp/migration/contract.mjs';

const root = process.cwd();
const identityFoundationSql = readFileSync(
  join(root, 'migration/sql/001_identity_migration_foundation.sql'),
  'utf8',
);

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function functionParts(signature: string) {
  const argumentsStart = signature.indexOf('(');
  const argumentsEnd = signature.lastIndexOf(')');
  const resultAt = signature.lastIndexOf('->');
  return {
    name: signature.slice(0, argumentsStart),
    argumentsText: signature.slice(argumentsStart + 1, argumentsEnd),
    result: signature.slice(resultAt + 2),
  };
}

function functionIdentityTypes(signature: string) {
  const { argumentsText } = functionParts(signature);
  if (!argumentsText) return '';
  return argumentsText
    .split(',')
    .map((argument) => argument.trim().replace(/^[a-z_][a-z0-9_]*\s+/i, ''))
    .join(', ');
}

function syntheticSchemaDump() {
  const statements: string[] = [
    '-- Synthetic schema-only fixture. Never a source snapshot.',
    'SET statement_timeout = 0;',
    'CREATE SCHEMA IF NOT EXISTS public;',
  ];

  for (const table of SOURCE_CONTRACT.publicTables) {
    statements.push(
      `CREATE TABLE public.${quoteIdentifier(table)} (\n  id uuid NOT NULL\n);`,
    );
  }

  statements.push(
    'ALTER TABLE public."agent_profiles" OWNER TO postgres;',
    'GRANT ALL ON TABLE public."agent_profiles" TO authenticated;',
    'ALTER TABLE public."agent_profiles" ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE ONLY public."agent_reviews" ADD CONSTRAINT "agent_reviews_user_fkey" FOREIGN KEY (id) REFERENCES auth.users(id);',
  );

  for (const signature of SOURCE_CONTRACT.customPublicFunctionSignatures) {
    const { name, argumentsText, result } = functionParts(signature);
    const fact = SOURCE_CONTRACT.frozenSchemaFacts.functions.find(
      (entry: {
        function_name: string;
        identity_arguments: string;
        result_type: string;
      }) =>
        entry.function_name === name &&
        entry.identity_arguments === argumentsText &&
        entry.result_type === result,
    );
    const security = fact.security_definer ? '\nSECURITY DEFINER' : '';
    const volatility = fact.volatility === 'i' ? '\nIMMUTABLE' : fact.volatility === 's' ? '\nSTABLE' : '';
    statements.push(
      `CREATE FUNCTION public.${quoteIdentifier(name)}(${argumentsText})\nRETURNS ${result}\nLANGUAGE plpgsql${volatility}${security}\nAS $body_${name}$\nBEGIN\n  PERFORM auth.uid();\n  RETURN NULL;\nEND\n$body_${name}$;`,
    );
  }

  for (let index = 0; index < 24; index += 1) {
    const table = SOURCE_CONTRACT.publicTables[index];
    statements.push(
      `CREATE TRIGGER ${quoteIdentifier(`synthetic_trigger_${index}`)} BEFORE UPDATE ON public.${quoteIdentifier(table)} FOR EACH ROW EXECUTE FUNCTION public."set_current_timestamp_updated_at"();`,
    );
  }

  for (let index = 0; index < 121; index += 1) {
    const table = SOURCE_CONTRACT.publicTables[index % SOURCE_CONTRACT.publicTables.length];
    statements.push(
      `CREATE INDEX ${quoteIdentifier(`synthetic_index_${index}`)} ON public.${quoteIdentifier(table)} USING btree (id);`,
    );
  }

  for (const policy of SOURCE_CONTRACT.frozenSchemaFacts.policies.filter(
    (entry: { schemaname: string }) => entry.schemaname === 'public',
  )) {
    statements.push(
      `CREATE POLICY ${quoteIdentifier(policy.policyname)} ON public.${quoteIdentifier(policy.tablename)} USING (auth.uid() = auth.uid());`,
    );
  }

  statements.push("COMMENT ON TABLE public.\"agent_profiles\" IS E'can\\'t; stop';");
  return `${statements.join('\n\n')}\n`;
}

function evidenceFor(bytes: Buffer) {
  return {
    ...SOURCE_CONTRACT.frozenEncryptedSchemaDumpEvidence,
    dump: {
      ...SOURCE_CONTRACT.frozenEncryptedSchemaDumpEvidence.dump,
      plaintextSha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      lines: [...bytes].filter((byte) => byte === 10).length,
      tables: 70,
      functions: 24,
      policies: 118,
      triggers: 24,
      explicitIndexes: 121,
      copyOrInsertStatements: 0,
      containsData: false,
    },
  };
}

function compileSynthetic(overrides: { dump?: string; identity?: string } = {}) {
  const dump = overrides.dump ?? syntheticSchemaDump();
  const dumpBytes = Buffer.from(dump, 'utf8');
  const compiled = compileTargetSchema({
    dumpBytes,
    identityFoundationSql: overrides.identity ?? identityFoundationSql,
    dumpEvidence: evidenceFor(dumpBytes),
  });
  return {
    ...compiled,
    dumpBytes,
    identityFoundationSql: overrides.identity ?? identityFoundationSql,
  };
}

describe('offline target schema compiler', () => {
  it('normalizes the PostgreSQL 17 CREATE OR REPLACE TRIGGER dump form to fail closed', () => {
    const dump = syntheticSchemaDump().replaceAll(
      'CREATE TRIGGER',
      'CREATE OR REPLACE TRIGGER',
    );
    const result = compileSynthetic({ dump });

    expect(result.report.counts.triggers).toBe(24);
    expect(
      result.phases['30_constraints_triggers_indexes.sql.plan'].match(
        /CREATE TRIGGER/g,
      ),
    ).toHaveLength(24);
    expect(result.phases['30_constraints_triggers_indexes.sql.plan']).not.toMatch(
      /CREATE\s+OR\s+REPLACE(?:\s+CONSTRAINT)?\s+TRIGGER/i,
    );
    expect(validateCompiledTargetSchema({ phases: result.phases })).toBe(true);
  });

  it('normalizes safe quote-all-identifiers function return and language tokens', () => {
    const dump = syntheticSchemaDump()
      .replace(/RETURNS\s+([a-z_][a-z0-9_]*)\nLANGUAGE/gi, 'RETURNS "$1"\nLANGUAGE')
      .replaceAll('RETURNS "trigger"\nLANGUAGE', 'RETURNS "public"."trigger"\nLANGUAGE')
      .replaceAll('LANGUAGE plpgsql', 'LANGUAGE "plpgsql"');
    const result = compileSynthetic({ dump });

    expect(result.report.counts.sourceCustomFunctionsDispositioned).toBe(24);
    expect(validateCompiledTargetSchema({ phases: result.phases })).toBe(true);
  });

  it('rejects an uppercase quoted function language token', () => {
    const dump = syntheticSchemaDump().replace('LANGUAGE plpgsql', 'LANGUAGE "PLPGSQL"');

    expect(() => compileSynthetic({ dump })).toThrow(
      expect.objectContaining({ code: 'FUNCTION_SIGNATURE_DRIFT' }),
    );
  });

  it('preserves a single quoted identifier containing a dot as one return-type token', () => {
    const dump = syntheticSchemaDump().replace(
      'RETURNS trigger\nLANGUAGE',
      'RETURNS "public.trigger"\nLANGUAGE',
    );

    expect(() => compileSynthetic({ dump })).toThrow(
      expect.objectContaining({ code: 'FUNCTION_SIGNATURE_DRIFT' }),
    );
  });

  it('turns source IF NOT EXISTS tables into fail-closed target DDL', () => {
    const dump = syntheticSchemaDump().replaceAll(
      'CREATE TABLE public.',
      'CREATE TABLE IF NOT EXISTS "public".',
    );
    const result = compileSynthetic({ dump });
    const parity = result.phases['20_raw_parity_schema.sql.plan'];

    expect(parity.match(/CREATE TABLE public\./g)).toHaveLength(70);
    expect(parity).not.toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i);
    expect(validateCompiledTargetSchema({ phases: result.phases })).toBe(true);
  });

  it('compiles all 70 parity tables into seven guarded, Firebase-aware private phases', () => {
    const result = compileSynthetic();
    expect(Object.keys(result.phases)).toEqual(TARGET_SCHEMA_PHASES);
    expect(result.report).toMatchObject({
      state: 'COMPILED_PRIVATE_PLAN_ONLY',
      counts: {
        rawParityTables: 70,
        sourcePublicPoliciesDispositioned: 118,
        publicPoliciesTranslated: 70,
        publicPoliciesBlocked: 48,
        storagePoliciesExcludedForGcs: 10,
        sourceCustomFunctionsDispositioned: 24,
        legacyRpcsWithheld: 16,
        triggerFunctionsRetained: 8,
        genericDeleteFunctionsWithheld: 4,
        authUsersForeignKeysTranslated: 1,
      },
      identity: {
        canonicalIdentifier: 'FIREBASE_UID',
        legacyUuidProvenance: 'PRESERVED',
        requestContext: 'TRANSACTION_LOCAL_APP_FIREBASE_UID',
        unclaimedLegacyPrincipalAccess: 'DENIED',
        emailOnlyMapping: 'FORBIDDEN',
      },
      execution: {
        mode: 'PLAN_ONLY',
        applyReady: false,
        liveConnectionsAvailable: false,
      },
    });
    expect(result.report.execution.blockers).toContain('PLAN_ONLY_EXECUTION');
    expect(result.report.execution.blockers).toContain('REAL_DUMP_OFFLINE_COMPILE_REQUIRED');
    expect(result.report.execution.blockers).toContain(
      'SEALED_SCHEMA_OWNER_EXECUTOR_BINDING_REQUIRED',
    );
    expect(result.report.phases.every((phase) => phase.planGuard)).toBe(true);
    const { planSha256: _planSha256, ...reportEnvelope } = result.report;
    expect(result.report.planSha256).toBe(canonicalHash(reportEnvelope));
    expect(result.report.planSha256).not.toBe(canonicalHash(result.report.phases));

    const combined = Object.values(result.phases).join('\n');
    expect(combined).not.toMatch(/\bauth\s*\./i);
    expect(combined).not.toMatch(/\bstorage\s*\./i);
    expect(combined).not.toMatch(/\bTO\s+(?:PUBLIC|anon|authenticated|service_role)\b/i);
    expect(combined).toContain("current_setting('app.firebase_uid', true)");
    expect(combined).toContain('hushh_identity.current_legacy_user_uuid()');
    expect(combined).toContain("links.status = 'ACTIVE'");
    expect(combined.match(/FORCE ROW LEVEL SECURITY;/g)).toHaveLength(76);
    expect(result.phases['40_firebase_rls_policies.sql.plan'].match(/CREATE POLICY/g)).toHaveLength(280);
    expect(result.phases['20_raw_parity_schema.sql.plan'].match(/CREATE TABLE public\./g)).toHaveLength(70);
    expect(result.phases['20_raw_parity_schema.sql.plan']).not.toContain('OWNER TO postgres');
    expect(result.phases['20_raw_parity_schema.sql.plan']).not.toContain('TO authenticated');
    expect(result.phases['20_raw_parity_schema.sql.plan']).toContain(
      `OWNER TO ${TARGET_SCHEMA_OWNER_ROLE}`,
    );
    expect(combined).not.toContain('OWNER TO hushh_tech_migration');
    expect(result.phases['00_extension_and_role_preflight.sql.plan']).toContain(
      'sealed schema-owner role must be NOLOGIN and NOINHERIT',
    );
    expect(result.phases['10_firebase_identity_context.sql.plan']).toContain(
      `CREATE POLICY identity_links_owner_active_lookup ON hushh_identity.identity_links FOR SELECT TO ${TARGET_SCHEMA_OWNER_ROLE}`,
    );
    expect(result.phases['30_constraints_triggers_indexes.sql.plan'].match(/CREATE FUNCTION public\./g)).toHaveLength(8);
    expect(
      result.phases['30_constraints_triggers_indexes.sql.plan'].match(
        /SECURITY DEFINER\nSET search_path TO pg_catalog, public, hushh_identity, pg_temp/g,
      ),
    ).toHaveLength(3);
    expect(result.phases['10_firebase_identity_context.sql.plan']).toContain(
      'SECURITY DEFINER\nSET search_path TO pg_catalog, public, hushh_identity, pg_temp',
    );
    expect(result.phases['50_target_privileges.sql.plan']).toContain(
      'REVOKE TEMPORARY ON DATABASE hushh_tech_app FROM PUBLIC;',
    );
    expect(result.phases['30_constraints_triggers_indexes.sql.plan']).toContain(
      'REFERENCES hushh_identity.identity_links (legacy_user_uuid)',
    );
    expect(result.report.dispositions.blockedPolicyKeyHashes).toHaveLength(48);
    expect(result.report.dispositions.withheldRpcKeyHashes).toHaveLength(16);

    for (const name of GENERIC_DELETE_FUNCTIONS) {
      expect(combined).not.toMatch(new RegExp(`CREATE FUNCTION public\\.\\"?${name}\\"?`, 'i'));
      expect(combined).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.\\"?${name}\\"?`, 'i'));
    }
    expect(validateCompiledTargetSchema({ phases: result.phases })).toBe(true);
  });

  it('fails closed on exact artifact drift before parsing or compilation', () => {
    const dumpBytes = Buffer.from(syntheticSchemaDump(), 'utf8');
    const evidence = evidenceFor(dumpBytes);
    const driftedBytes = Buffer.concat([dumpBytes, Buffer.from('-- drift\n')]);
    expect(() =>
      compileTargetSchema({
        dumpBytes: driftedBytes,
        identityFoundationSql,
        dumpEvidence: evidence,
      }),
    ).toThrow(expect.objectContaining({ code: 'SCHEMA_DUMP_HASH_MISMATCH' }));
  });

  it('rejects owner, privilege, and forced-RLS gaps in a compiled plan', () => {
    const result = compileSynthetic();

    const missingForce = { ...result.phases };
    missingForce['40_firebase_rls_policies.sql.plan'] = missingForce[
      '40_firebase_rls_policies.sql.plan'
    ].replace(
      'ALTER TABLE public."agent_profiles" FORCE ROW LEVEL SECURITY;',
      '-- removed by adversary',
    );
    expect(() => validateCompiledTargetSchema({ phases: missingForce })).toThrow(
      expect.objectContaining({ code: 'RLS_GAP' }),
    );

    const elevatedRole = { ...result.phases };
    elevatedRole['00_extension_and_role_preflight.sql.plan'] = elevatedRole[
      '00_extension_and_role_preflight.sql.plan'
    ].replace(
      'ROLLBACK;',
      'ALTER ROLE hushh_tech_runtime BYPASSRLS;\nROLLBACK;',
    );
    expect(() => validateCompiledTargetSchema({ phases: elevatedRole })).toThrow(
      expect.objectContaining({ code: 'ELEVATED_RUNTIME_ROLE' }),
    );

    const guardBypass = { ...result.phases };
    guardBypass['00_extension_and_role_preflight.sql.plan'] = guardBypass[
      '00_extension_and_role_preflight.sql.plan'
    ].replace(
      'ROLLBACK;',
      'ABORT;\nROLLBACK;',
    );
    expect(() => validateCompiledTargetSchema({ phases: guardBypass })).toThrow(
      expect.objectContaining({ code: 'PLAN_GUARD_BYPASS' }),
    );

    const replaceTrigger = { ...result.phases };
    replaceTrigger['30_constraints_triggers_indexes.sql.plan'] = replaceTrigger[
      '30_constraints_triggers_indexes.sql.plan'
    ].replace('CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER');
    expect(() => validateCompiledTargetSchema({ phases: replaceTrigger })).toThrow(
      expect.objectContaining({ code: 'TRIGGER_REPLACE_NOT_ALLOWED' }),
    );
  });

  it('rejects identity mapping plans that lose UUID provenance or unclaimed denial', () => {
    const missingProvenance = identityFoundationSql.replace(
      'legacy_user_uuid uuid NOT NULL',
      'legacy_source_identifier text NOT NULL',
    );
    expect(() => compileSynthetic({ identity: missingProvenance })).toThrow(
      expect.objectContaining({ code: 'IDENTITY_FOUNDATION_GAP' }),
    );

    const missingDenial = identityFoundationSql.replaceAll(
      'UNCLAIMED_LEGACY_PRINCIPAL',
      'UNCLAIMED_RENAMED',
    );
    expect(() => compileSynthetic({ identity: missingDenial })).toThrow(
      expect.objectContaining({ code: 'IDENTITY_FOUNDATION_GAP' }),
    );
  });

  it('rejects unsafe public function drift and runtime access to generic deletion helpers', () => {
    const result = compileSynthetic();
    const runtimeDeleteGrant = { ...result.phases };
    const signature = SOURCE_CONTRACT.customPublicFunctionSignatures.find((entry: string) =>
      entry.startsWith('delete_rows_by_uuid_if_exists('),
    ) as string;
    const argumentsText = functionIdentityTypes(signature);
    runtimeDeleteGrant['50_target_privileges.sql.plan'] = runtimeDeleteGrant[
      '50_target_privileges.sql.plan'
    ].replace(
      'ROLLBACK;',
      `GRANT EXECUTE ON FUNCTION public."delete_rows_by_uuid_if_exists"(${argumentsText}) TO hushh_tech_runtime;\nROLLBACK;`,
    );
    expect(() => validateCompiledTargetSchema({ phases: runtimeDeleteGrant })).toThrow(
      expect.objectContaining({ code: 'PUBLIC_DELETE_RPC' }),
    );

    const extraFunctionDump = syntheticSchemaDump().replace(
      'COMMENT ON TABLE',
      'CREATE FUNCTION public.unreviewed_delete_everything() RETURNS void LANGUAGE sql AS $$ SELECT $$;\n\nCOMMENT ON TABLE',
    );
    const bytes = Buffer.from(extraFunctionDump, 'utf8');
    const evidence = evidenceFor(bytes);
    evidence.dump.functions = 25;
    expect(() =>
      compileTargetSchema({
        dumpBytes: bytes,
        identityFoundationSql,
        dumpEvidence: evidence,
      }),
    ).toThrow(expect.objectContaining({ code: 'FUNCTION_SIGNATURE_DRIFT' }));
  });

  it('keeps source bodies and paths out of the sanitized report and repository', () => {
    const result = compileSynthetic();
    const serializedReport = JSON.stringify(result.report);
    expect(serializedReport).not.toContain('Synthetic schema-only fixture');
    expect(serializedReport).not.toContain('PERFORM auth.uid');
    expect(serializedReport).not.toContain(process.cwd());
    expect(serializedReport).not.toMatch(/\bCREATE\s+(?:TABLE|FUNCTION|POLICY)\b/i);

    const temporaryRoot = mkdtempSync(join(tmpdir(), 'hushh-target-schema-test-'));
    const outputDirectory = join(temporaryRoot, 'compiled');
    try {
      writePrivateTargetSchemaPlan({
        outputDirectory,
        phases: result.phases,
        report: result.report,
        dumpBytes: result.dumpBytes,
        identityFoundationSql: result.identityFoundationSql,
      });
      expect(statSync(outputDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(join(outputDirectory, TARGET_SCHEMA_PHASES[0])).mode & 0o777).toBe(0o600);
      expect(statSync(join(outputDirectory, 'target-schema-plan.v1.json')).mode & 0o777).toBe(0o600);
      expect(
        readFileSync(join(outputDirectory, 'target-schema-plan.v1.json'), 'utf8'),
      ).not.toMatch(/\bCREATE\s+(?:TABLE|FUNCTION|POLICY)\b/i);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects execute/apply and dry-run disablement before reading any file', () => {
    expect(() =>
      runTargetSchemaCompilerCli([
        '--schema-dump=/private/tmp/does-not-exist.sql',
        '--output-dir=/private/tmp/does-not-exist-output',
        '--execute',
      ]),
    ).toThrow(expect.objectContaining({ code: 'EXECUTION_FORBIDDEN' }));
    expect(() =>
      runTargetSchemaCompilerCli([
        '--schema-dump=/private/tmp/does-not-exist.sql',
        '--output-dir=/private/tmp/does-not-exist-output',
        '--dry-run=false',
      ]),
    ).toThrow(expect.objectContaining({ code: 'EXECUTION_FORBIDDEN' }));
  });

  it('binds the exact 70 translated and 48 blocked policy dispositions by digest', () => {
    const inventory = JSON.parse(
      readFileSync(join(root, 'migration/contracts/source-inventory.v1.json'), 'utf8'),
    );
    const mappingBytes = readFileSync(
      join(root, 'migration/contracts/firebase-policy-mapping.v1.json'),
    );
    const mapping = JSON.parse(mappingBytes.toString('utf8'));
    expect(createHash('sha256').update(mappingBytes).digest('hex')).toBe(
      inventory.firebasePolicyMappingArtifact.sha256,
    );
    expect(mapping.expected).toEqual({
      sourcePublicPolicies: 118,
      firebaseOwnershipPolicies: 70,
      blockedPolicies: 48,
    });

    const facts = new Map(
      SOURCE_CONTRACT.frozenSchemaFacts.policies
        .filter((policy: { schemaname: string }) => policy.schemaname === 'public')
        .map((policy: { tablename: string; policyname: string; cmd: string; roles: string }) => [
          JSON.stringify([policy.tablename, policy.policyname, policy.cmd, policy.roles]),
          policy,
        ]),
    );
    for (const entry of mapping.firebaseOwnershipPolicies) {
      const policy = facts.get(JSON.stringify(entry));
      const expressions = `${policy.qual ?? ''} ${policy.with_check ?? ''}`;
      expect(expressions).toMatch(/auth\.uid\(\)/i);
      expect(expressions).not.toMatch(/auth\.jwt\(\)/i);
      expect(policy.roles).not.toMatch(/service_role/i);
      expect(policy.qual?.trim().toLowerCase()).not.toBe('true');
      expect(policy.with_check?.trim().toLowerCase()).not.toBe('true');
    }
  });

  it('retains only eight trigger functions and revokes every callable role immediately', () => {
    const result = compileSynthetic();
    const phase = result.phases['30_constraints_triggers_indexes.sql.plan'];
    const triggerNames = SOURCE_CONTRACT.customPublicFunctionSignatures
      .filter((signature: string) => signature.endsWith('->trigger'))
      .map((signature: string) => functionParts(signature).name);
    const rpcNames = SOURCE_CONTRACT.customPublicFunctionSignatures
      .filter((signature: string) => !signature.endsWith('->trigger'))
      .map((signature: string) => functionParts(signature).name);

    for (const name of triggerNames) {
      const createdAt = phase.indexOf(`CREATE FUNCTION public."${name}"`);
      const nextCreateAt = phase.indexOf('CREATE FUNCTION public.', createdAt + 1);
      const hardenedWindow = phase.slice(
        createdAt,
        nextCreateAt < 0 ? phase.length : nextCreateAt,
      );
      expect(createdAt).toBeGreaterThanOrEqual(0);
      expect(hardenedWindow).toContain(`REVOKE ALL ON FUNCTION public."${name}"() FROM PUBLIC;`);
      for (const role of [
        'hushh_tech_schema_owner',
        'hushh_tech_migration',
        'hushh_tech_runtime',
        'hushh_tech_audit',
        'hushh_tech_rollback',
      ]) {
        expect(hardenedWindow).toContain(
          `REVOKE ALL ON FUNCTION public."${name}"() FROM ${role};`,
        );
      }
    }
    for (const name of rpcNames) {
      expect(phase).not.toMatch(new RegExp(`CREATE FUNCTION public\\.\\"${name}\\"`, 'i'));
    }
  });

  it.each([
    ['ABORT;', 'TRANSACTION_CONTROL_FORBIDDEN'],
    ['END;', 'TRANSACTION_CONTROL_FORBIDDEN'],
    ['WITH doomed AS (DELETE FROM public."agent_profiles" RETURNING *) SELECT * FROM doomed;', 'SCHEMA_DUMP_CONTAINS_DATA'],
    ['ALTER TABLE public."agent_profiles" DROP COLUMN id;', 'UNSUPPORTED_SOURCE_STATEMENT'],
    [
      'ALTER TABLE public."agent_profiles" ADD COLUMN "ADD CONSTRAINT" text;',
      'UNSUPPORTED_SOURCE_STATEMENT',
    ],
    [
      `ALTER TABLE public."agent_profiles" ADD COLUMN note text DEFAULT 'ADD CONSTRAINT fake CHECK (true)';`,
      'UNSUPPORTED_SOURCE_STATEMENT',
    ],
    [
      'ALTER TABLE public."agent_profiles" RENAME COLUMN id TO "ADD CONSTRAINT";',
      'UNSUPPORTED_SOURCE_STATEMENT',
    ],
    [
      `ALTER TABLE public."agent_profiles" ALTER COLUMN id TYPE text USING 'ADD CONSTRAINT fake CHECK (true)';`,
      'UNSUPPORTED_SOURCE_STATEMENT',
    ],
    [
      'ALTER TABLE public."agent_profiles" ADD CONSTRAINT valid_name CHECK (id IS NOT NULL), DROP COLUMN id;',
      'UNSUPPORTED_SOURCE_STATEMENT',
    ],
    ['DO $$ BEGIN NULL; END $$;', 'UNSUPPORTED_SOURCE_STATEMENT'],
    ['CALL public."set_current_timestamp_updated_at"();', 'UNSUPPORTED_SOURCE_STATEMENT'],
    ['DROP TABLE public."agent_profiles";', 'UNSAFE_SOURCE_DDL'],
    ['SELECT 1;', 'UNSUPPORTED_SOURCE_STATEMENT'],
    ['CREATE EXTENSION postgis;', 'EXTENSION_DISPOSITION_REQUIRED'],
  ])('default-denies unsupported source SQL: %s', (injected, code) => {
    const dump = syntheticSchemaDump().replace(
      'COMMENT ON TABLE',
      `${injected}\n\nCOMMENT ON TABLE`,
    );
    const bytes = Buffer.from(dump, 'utf8');
    expect(() =>
      compileTargetSchema({
        dumpBytes: bytes,
        identityFoundationSql,
        dumpEvidence: evidenceFor(bytes),
      }),
    ).toThrow(expect.objectContaining({ code }));
  });

  it('rejects function signature, security, and auth.jwt contract drift', () => {
    const signatureDrift = syntheticSchemaDump().replace(
      '"batch_agent_selections"(p_user_id uuid, p_selections jsonb)',
      '"batch_agent_selections"(p_user_id uuid, p_selections text)',
    );
    const signatureBytes = Buffer.from(signatureDrift, 'utf8');
    expect(() =>
      compileTargetSchema({
        dumpBytes: signatureBytes,
        identityFoundationSql,
        dumpEvidence: evidenceFor(signatureBytes),
      }),
    ).toThrow(expect.objectContaining({ code: 'FUNCTION_SIGNATURE_DRIFT' }));

    const securityDrift = syntheticSchemaDump().replace(
      'LANGUAGE plpgsql\nSECURITY DEFINER\nAS $body_batch_agent_selections$',
      'LANGUAGE plpgsql\nAS $body_batch_agent_selections$',
    );
    const securityBytes = Buffer.from(securityDrift, 'utf8');
    expect(() =>
      compileTargetSchema({
        dumpBytes: securityBytes,
        identityFoundationSql,
        dumpEvidence: evidenceFor(securityBytes),
      }),
    ).toThrow(expect.objectContaining({ code: 'FUNCTION_SECURITY_DRIFT' }));

    const jwtDrift = syntheticSchemaDump().replace(
      '$body_generate_investor_slug$\nBEGIN\n  PERFORM auth.uid();',
      '$body_generate_investor_slug$\nBEGIN\n  PERFORM auth.jwt();',
    );
    const jwtBytes = Buffer.from(jwtDrift, 'utf8');
    expect(() =>
      compileTargetSchema({
        dumpBytes: jwtBytes,
        identityFoundationSql,
        dumpEvidence: evidenceFor(jwtBytes),
      }),
    ).toThrow(expect.objectContaining({ code: 'UNMAPPED_AUTH_DEPENDENCY' }));
  });

  it('transforms quoted auth identifiers and blocks quoted jwt or storage dependencies', () => {
    const quotedUid = syntheticSchemaDump()
      .replace('REFERENCES auth.users(id)', 'REFERENCES "auth"."users"("id")')
      .replace(
        '$body_generate_investor_slug$\nBEGIN\n  PERFORM auth.uid();',
        '$body_generate_investor_slug$\nBEGIN\n  PERFORM "auth"/* source */."uid"();',
      );
    const quotedUidResult = compileSynthetic({ dump: quotedUid });
    expect(quotedUidResult.phases['30_constraints_triggers_indexes.sql.plan']).toContain(
      'PERFORM hushh_identity.current_legacy_user_uuid();',
    );
    expect(quotedUidResult.phases['30_constraints_triggers_indexes.sql.plan']).toContain(
      'REFERENCES hushh_identity.identity_links (legacy_user_uuid)',
    );
    expect(Object.values(quotedUidResult.phases).join('\n')).not.toMatch(/"auth"\s*\./i);

    for (const dependency of [
      '"auth"."jwt"()',
      '"auth"/* source */."jwt"()',
      '"auth"/* outer /* nested */ source */."jwt"()',
      '"storage"."foldername"(name)',
      '"storage"/* source */."foldername"(name)',
    ]) {
      const drifted = syntheticSchemaDump().replace(
        '$body_generate_investor_slug$\nBEGIN\n  PERFORM auth.uid();',
        `$body_generate_investor_slug$\nBEGIN\n  PERFORM ${dependency};`,
      );
      const bytes = Buffer.from(drifted, 'utf8');
      expect(() =>
        compileTargetSchema({
          dumpBytes: bytes,
          identityFoundationSql,
          dumpEvidence: evidenceFor(bytes),
        }),
      ).toThrow(
        expect.objectContaining({
          code:
            dependency.includes('jwt')
              ? 'UNMAPPED_AUTH_DEPENDENCY'
              : 'SOURCE_SCHEMA_DEPENDENCY',
        }),
      );
    }

    const literalOnly = syntheticSchemaDump().replace(
      '$body_generate_investor_slug$\nBEGIN\n  PERFORM auth.uid();',
      `$body_generate_investor_slug$\nBEGIN\n  PERFORM '"auth"."jwt"()';\n  PERFORM auth.uid();`,
    );
    expect(() => compileSynthetic({ dump: literalOnly })).not.toThrow();
  });

  it.each([
    "EXECUTE 'SELECT 1';",
    "EXECUTE format('SELECT %I', 'id');",
    "EXECUTE 'SELECT ' || '1';",
  ])('blocks unparsed dynamic SQL in retained functions: %s', (dynamicSql) => {
    const drifted = syntheticSchemaDump().replace(
      '$body_generate_investor_slug$\nBEGIN\n  PERFORM auth.uid();',
      `$body_generate_investor_slug$\nBEGIN\n  ${dynamicSql}\n  PERFORM auth.uid();`,
    );
    const bytes = Buffer.from(drifted, 'utf8');
    expect(() =>
      compileTargetSchema({
        dumpBytes: bytes,
        identityFoundationSql,
        dumpEvidence: evidenceFor(bytes),
      }),
    ).toThrow(expect.objectContaining({ code: 'DYNAMIC_SQL_BLOCKED' }));
  });

  it('allows inert EXECUTE text and normalizes every retained SECURITY DEFINER search_path', () => {
    const hardened = syntheticSchemaDump()
      .replace(
        '$body_generate_investor_slug$\nBEGIN\n  PERFORM auth.uid();',
        `$body_generate_investor_slug$\nBEGIN\n  PERFORM 'EXECUTE format(''SELECT 1'')';\n  PERFORM auth.uid();`,
      )
      .replace(
        'SECURITY DEFINER\nAS $body_handle_new_user$',
        'SECURITY DEFINER\nSET "search_path" TO attacker, public\nAS $body_handle_new_user$',
      );
    const result = compileSynthetic({ dump: hardened });
    const functionPhase = result.phases['30_constraints_triggers_indexes.sql.plan'];
    expect(functionPhase).not.toContain('attacker');
    expect(
      functionPhase.match(
        /SECURITY DEFINER\nSET search_path TO pg_catalog, public, hushh_identity, pg_temp/g,
      ),
    ).toHaveLength(3);
    expect(functionPhase).toContain("PERFORM 'EXECUTE format(''SELECT 1'')';");

    const unreviewedConfiguration = syntheticSchemaDump().replace(
      'SECURITY DEFINER\nAS $body_handle_new_user$',
      'SECURITY DEFINER\nSET work_mem TO \'64MB\'\nAS $body_handle_new_user$',
    );
    const bytes = Buffer.from(unreviewedConfiguration, 'utf8');
    expect(() =>
      compileTargetSchema({
        dumpBytes: bytes,
        identityFoundationSql,
        dumpEvidence: evidenceFor(bytes),
      }),
    ).toThrow(expect.objectContaining({ code: 'UNSAFE_SECURITY_DEFINER' }));
  });

  it('rejects trigger privilege windows, runtime ownership, and missing catalog proofs', () => {
    const result = compileSynthetic();

    const missingImmediateRevoke = { ...result.phases };
    missingImmediateRevoke['30_constraints_triggers_indexes.sql.plan'] = missingImmediateRevoke[
      '30_constraints_triggers_indexes.sql.plan'
    ].replace(
      'REVOKE ALL ON FUNCTION public."generate_investor_slug"() FROM PUBLIC;',
      '-- removed by adversary',
    );
    expect(() => validateCompiledTargetSchema({ phases: missingImmediateRevoke })).toThrow(
      expect.objectContaining({ code: 'FUNCTION_PRIVILEGE_WINDOW' }),
    );

    const runtimeOwner = { ...result.phases };
    runtimeOwner['50_target_privileges.sql.plan'] = runtimeOwner[
      '50_target_privileges.sql.plan'
    ].replace(
      'ROLLBACK;',
      'ALTER TABLE public."agent_profiles" OWNER TO hushh_tech_runtime;\nROLLBACK;',
    );
    expect(() => validateCompiledTargetSchema({ phases: runtimeOwner })).toThrow(
      expect.objectContaining({ code: 'RUNTIME_OBJECT_OWNERSHIP' }),
    );

    const migrationOwner = { ...result.phases };
    migrationOwner['20_raw_parity_schema.sql.plan'] = migrationOwner[
      '20_raw_parity_schema.sql.plan'
    ].replace(
      `OWNER TO ${TARGET_SCHEMA_OWNER_ROLE}`,
      'OWNER TO hushh_tech_migration',
    );
    expect(() => validateCompiledTargetSchema({ phases: migrationOwner })).toThrow(
      expect.objectContaining({ code: 'OPERATIONAL_OBJECT_OWNERSHIP' }),
    );

    const inheritedRole = { ...result.phases };
    inheritedRole['50_target_privileges.sql.plan'] = inheritedRole[
      '50_target_privileges.sql.plan'
    ].replace('ROLLBACK;', 'GRANT privileged_parent TO hushh_tech_runtime;\nROLLBACK;');
    expect(() => validateCompiledTargetSchema({ phases: inheritedRole })).toThrow(
      expect.objectContaining({ code: 'INHERITED_ROLE_GRANT' }),
    );

    const ownerMembership = { ...result.phases };
    ownerMembership['50_target_privileges.sql.plan'] = ownerMembership[
      '50_target_privileges.sql.plan'
    ].replace(
      'ROLLBACK;',
      `GRANT ${TARGET_SCHEMA_OWNER_ROLE} TO hushh_tech_migration;\nROLLBACK;`,
    );
    expect(() => validateCompiledTargetSchema({ phases: ownerMembership })).toThrow(
      expect.objectContaining({ code: 'INHERITED_ROLE_GRANT' }),
    );

    const externalOwnerMembership = { ...result.phases };
    externalOwnerMembership['50_target_privileges.sql.plan'] = externalOwnerMembership[
      '50_target_privileges.sql.plan'
    ].replace(
      'ROLLBACK;',
      `GRANT ${TARGET_SCHEMA_OWNER_ROLE} TO unreviewed_executor;\nROLLBACK;`,
    );
    expect(() => validateCompiledTargetSchema({ phases: externalOwnerMembership })).toThrow(
      expect.objectContaining({ code: 'INHERITED_ROLE_GRANT' }),
    );

    const ownerRoleSwitch = { ...result.phases };
    ownerRoleSwitch['50_target_privileges.sql.plan'] = ownerRoleSwitch[
      '50_target_privileges.sql.plan'
    ].replace('ROLLBACK;', `SET ROLE ${TARGET_SCHEMA_OWNER_ROLE};\nROLLBACK;`);
    expect(() => validateCompiledTargetSchema({ phases: ownerRoleSwitch })).toThrow(
      expect.objectContaining({ code: 'TARGET_ROLE_SWITCH' }),
    );

    const missingNoLoginCheck = { ...result.phases };
    missingNoLoginCheck['00_extension_and_role_preflight.sql.plan'] = missingNoLoginCheck[
      '00_extension_and_role_preflight.sql.plan'
    ].replaceAll('role_record.rolcanlogin', 'false');
    expect(() => validateCompiledTargetSchema({ phases: missingNoLoginCheck })).toThrow(
      expect.objectContaining({ code: 'OWNER_ATTESTATION_GAP' }),
    );

    const missingOwnerMemberCheck = { ...result.phases };
    missingOwnerMemberCheck['00_extension_and_role_preflight.sql.plan'] = missingOwnerMemberCheck[
      '00_extension_and_role_preflight.sql.plan'
    ].replaceAll('pg_catalog.pg_auth_members', 'pg_catalog.disabled_members');
    expect(() => validateCompiledTargetSchema({ phases: missingOwnerMemberCheck })).toThrow(
      expect.objectContaining({ code: 'OWNER_ATTESTATION_GAP' }),
    );

    const migrationCreateGrant = { ...result.phases };
    migrationCreateGrant['50_target_privileges.sql.plan'] = migrationCreateGrant[
      '50_target_privileges.sql.plan'
    ].replace(
      'REVOKE CREATE ON SCHEMA public FROM hushh_tech_migration;',
      '-- removed by adversary',
    );
    expect(() => validateCompiledTargetSchema({ phases: migrationCreateGrant })).toThrow(
      expect.objectContaining({ code: 'OPERATIONAL_DDL_PRIVILEGE' }),
    );

    const missingPublicTemporaryRevoke = { ...result.phases };
    missingPublicTemporaryRevoke['50_target_privileges.sql.plan'] = missingPublicTemporaryRevoke[
      '50_target_privileges.sql.plan'
    ].replace(
      'REVOKE TEMPORARY ON DATABASE hushh_tech_app FROM PUBLIC;',
      '-- removed by adversary',
    );
    expect(() => validateCompiledTargetSchema({ phases: missingPublicTemporaryRevoke })).toThrow(
      expect.objectContaining({ code: 'OPERATIONAL_TEMP_PRIVILEGE' }),
    );

    const missingOperationalTemporaryRevoke = { ...result.phases };
    missingOperationalTemporaryRevoke['50_target_privileges.sql.plan'] =
      missingOperationalTemporaryRevoke['50_target_privileges.sql.plan'].replace(
        'REVOKE TEMPORARY ON DATABASE hushh_tech_app FROM hushh_tech_migration;',
        '-- removed by adversary',
      );
    expect(() =>
      validateCompiledTargetSchema({ phases: missingOperationalTemporaryRevoke }),
    ).toThrow(expect.objectContaining({ code: 'OPERATIONAL_TEMP_PRIVILEGE' }));

    const weakenedSecurityDefinerPath = { ...result.phases };
    weakenedSecurityDefinerPath['30_constraints_triggers_indexes.sql.plan'] =
      weakenedSecurityDefinerPath['30_constraints_triggers_indexes.sql.plan'].replace(
        'SET search_path TO pg_catalog, public, hushh_identity, pg_temp',
        'SET search_path TO pg_catalog, public, hushh_identity',
      );
    expect(() => validateCompiledTargetSchema({ phases: weakenedSecurityDefinerPath })).toThrow(
      expect.objectContaining({ code: 'UNSAFE_SECURITY_DEFINER' }),
    );

    const injectedDynamicSql = { ...result.phases };
    injectedDynamicSql['30_constraints_triggers_indexes.sql.plan'] = injectedDynamicSql[
      '30_constraints_triggers_indexes.sql.plan'
    ].replace('PERFORM hushh_identity.current_legacy_user_uuid();', "EXECUTE 'SELECT 1';");
    expect(() => validateCompiledTargetSchema({ phases: injectedDynamicSql })).toThrow(
      expect.objectContaining({ code: 'DYNAMIC_SQL_BLOCKED' }),
    );

    const missingSecurityDefinerCatalogProof = { ...result.phases };
    missingSecurityDefinerCatalogProof['60_catalog_validation.sql.plan'] =
      missingSecurityDefinerCatalogProof['60_catalog_validation.sql.plan'].replaceAll(
        "search_path=pg_catalog, public, hushh_identity, pg_temp",
        'search_path=pg_catalog, public, hushh_identity',
      );
    expect(() =>
      validateCompiledTargetSchema({ phases: missingSecurityDefinerCatalogProof }),
    ).toThrow(expect.objectContaining({ code: 'CATALOG_PROOF_GAP' }));

    const missingTemporaryCatalogProof = { ...result.phases };
    missingTemporaryCatalogProof['60_catalog_validation.sql.plan'] = missingTemporaryCatalogProof[
      '60_catalog_validation.sql.plan'
    ].replaceAll(
      "has_database_privilege(role_name, current_database(), 'TEMPORARY')",
      'false',
    );
    expect(() => validateCompiledTargetSchema({ phases: missingTemporaryCatalogProof })).toThrow(
      expect.objectContaining({ code: 'CATALOG_PROOF_GAP' }),
    );

    const missingCatalogProof = { ...result.phases };
    missingCatalogProof['60_catalog_validation.sql.plan'] = missingCatalogProof[
      '60_catalog_validation.sql.plan'
    ].replaceAll('pg_catalog.pg_has_role', 'pg_catalog.unreviewed_role_check');
    expect(() => validateCompiledTargetSchema({ phases: missingCatalogProof })).toThrow(
      expect.objectContaining({ code: 'CATALOG_PROOF_GAP' }),
    );
  });

  it('rejects report digest/count tampering before creating private output', () => {
    const result = compileSynthetic();
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'hushh-target-report-tamper-'));
    try {
      const badDigest = { ...result.report, planSha256: '0'.repeat(64) };
      const digestOutput = join(temporaryRoot, 'digest-output');
      expect(() =>
        writePrivateTargetSchemaPlan({
          outputDirectory: digestOutput,
          phases: result.phases,
          report: badDigest,
          dumpBytes: result.dumpBytes,
          identityFoundationSql: result.identityFoundationSql,
        }),
      ).toThrow(expect.objectContaining({ code: 'COMPILER_RUN_CAPABILITY_REQUIRED' }));
      expect(existsSync(digestOutput)).toBe(false);

      const badCounts = {
        ...result.report,
        counts: { ...result.report.counts, publicPoliciesBlocked: 47 },
      };
      const countOutput = join(temporaryRoot, 'count-output');
      expect(() =>
        writePrivateTargetSchemaPlan({
          outputDirectory: countOutput,
          phases: result.phases,
          report: badCounts,
          dumpBytes: result.dumpBytes,
          identityFoundationSql: result.identityFoundationSql,
        }),
      ).toThrow(expect.objectContaining({ code: 'COMPILER_RUN_CAPABILITY_REQUIRED' }));
      expect(existsSync(countOutput)).toBe(false);

      const wrongDumpOutput = join(temporaryRoot, 'wrong-dump-output');
      expect(() =>
        writePrivateTargetSchemaPlan({
          outputDirectory: wrongDumpOutput,
          phases: result.phases,
          report: result.report,
          dumpBytes: Buffer.concat([result.dumpBytes, Buffer.from('-- forged\n')]),
          identityFoundationSql: result.identityFoundationSql,
        }),
      ).toThrow(expect.objectContaining({ code: 'COMPILER_INPUT_MISMATCH' }));
      expect(existsSync(wrongDumpOutput)).toBe(false);

      const wrongFoundationOutput = join(temporaryRoot, 'wrong-foundation-output');
      expect(() =>
        writePrivateTargetSchemaPlan({
          outputDirectory: wrongFoundationOutput,
          phases: result.phases,
          report: result.report,
          dumpBytes: result.dumpBytes,
          identityFoundationSql: `${result.identityFoundationSql}\n-- forged`,
        }),
      ).toThrow(expect.objectContaining({ code: 'COMPILER_INPUT_MISMATCH' }));
      expect(existsSync(wrongFoundationOutput)).toBe(false);

      const forgedReport = JSON.parse(JSON.stringify(result.report));
      forgedReport.sourceEvidence.plaintextSha256 =
        SOURCE_CONTRACT.frozenEncryptedSchemaDumpEvidence.dump.plaintextSha256;
      forgedReport.execution.blockers = forgedReport.execution.blockers.filter(
        (blocker: string) => blocker !== 'REAL_DUMP_OFFLINE_COMPILE_REQUIRED',
      );
      const forgedOutput = join(temporaryRoot, 'forged-output');
      expect(() =>
        writePrivateTargetSchemaPlan({
          outputDirectory: forgedOutput,
          phases: result.phases,
          report: forgedReport,
          dumpBytes: result.dumpBytes,
          identityFoundationSql: result.identityFoundationSql,
        }),
      ).toThrow(expect.objectContaining({ code: 'COMPILER_RUN_CAPABILITY_REQUIRED' }));
      expect(existsSync(forgedOutput)).toBe(false);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects hard-linked decrypted input before reading or hashing its contents', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'hushh-target-hardlink-'));
    const source = join(temporaryRoot, 'schema.sql');
    const alias = join(temporaryRoot, 'schema-alias.sql');
    try {
      writeFileSync(source, 'SELECT 1;\n', { mode: 0o600 });
      chmodSync(source, 0o600);
      linkSync(source, alias);
      expect(() =>
        runTargetSchemaCompilerCli([
          `--schema-dump=${source}`,
          `--output-dir=${join(temporaryRoot, 'output')}`,
          '--dry-run=true',
        ]),
      ).toThrow(expect.objectContaining({ code: 'PRIVATE_FILE_LINK_COUNT' }));
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  const privateDumpPath = process.env.HUSHH_TECH_PRIVATE_DECRYPTED_SCHEMA_DUMP;
  (privateDumpPath ? it : it.skip)(
    'compiles the exact private 210,601-byte dump offline without any live source or GCP call',
    () => {
      const bytes = readFileSync(privateDumpPath as string);
      expect(bytes).toHaveLength(210_601);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        SOURCE_CONTRACT.frozenEncryptedSchemaDumpEvidence.dump.plaintextSha256,
      );
      const result = compileTargetSchema({ dumpBytes: bytes, identityFoundationSql });
      expect(result.report.counts.rawParityTables).toBe(70);
      expect(result.report.execution.blockers).not.toContain('REAL_DUMP_OFFLINE_COMPILE_REQUIRED');
      expect(validateCompiledTargetSchema({ phases: result.phases })).toBe(true);
    },
  );
});
