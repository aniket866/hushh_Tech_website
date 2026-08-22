import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '../scripts/gcp/migration/canonical-hash.mjs';
import {
  PINNED_EXPECTED_SHA256,
  assessEngagementNdaBoundary,
  validateExpected,
} from '../cloud-run/hushh-tech-schema-data-verifier-uat/index.mjs';

const expectedPath = new URL('../cloud-run/hushh-tech-schema-data-verifier-uat/expected-manifest.v1.json', import.meta.url);

function expectedInput() {
  return JSON.parse(readFileSync(expectedPath, 'utf8'));
}

function rehashSourceAndEnvelope(expected: Record<string, any>) {
  const sourcePayload = structuredClone(expected.sourceManifest);
  delete sourcePayload.manifestSha256;
  expected.sourceManifest.manifestSha256 = canonicalHash(sourcePayload);
  const expectedPayload = structuredClone(expected);
  delete expectedPayload.expectedSha256;
  expected.expectedSha256 = canonicalHash(expectedPayload);
  return expected;
}

function exactEngagementObservation() {
  return {
    role: {
      exists: true,
      login: true,
      superuser: false,
      createRole: false,
      createDatabase: false,
      replication: false,
      bypassRls: false,
      databaseCreate: false,
      databaseTemporary: false,
      publicSchemaUsage: true,
      publicSchemaCreate: false,
    },
    selectColumns: ['id', 'user_id', 'signed_at', 'nda_version', 'pdf_url']
      .map((column) => ['public', 'nda_signatures', column]),
    tableWideSelect: false,
    publicDml: false,
    forbiddenMemberships: [],
    policy: [{
      name: 'nda_signatures_engagement_api_select',
      command: 'r',
      permissive: true,
      roles: ['hushh-tech-engagement-api-uat@hushh-tech-uat.iam'],
      qual: "(current_setting('app.firebase_fund_admin'::text, true) = 'true'::text)",
      withCheck: null,
    }],
  };
}

describe('reproducible UAT schema/data verifier input', () => {
  it('accepts the checked-in exact governed input', () => {
    const expected = expectedInput();
    expect(expected.expectedSha256).toBe(PINNED_EXPECTED_SHA256);
    expect(validateExpected(expected)).toBe(expected);
  });

  it('rejects a same-count table-hash substitution even when both envelopes are rehashed', () => {
    const expected = expectedInput();
    expected.sourceManifest.tables[0].rowSha256 = canonicalHash({ substituted: true });
    expected.sourceManifest.tables[0].artifact.memberSha256 = canonicalHash([{ substituted: true }]);
    expect(() => validateExpected(rehashSourceAndEnvelope(expected))).toThrow('EXPECTED_MANIFEST_INVALID');
  });

  it('rejects a self-consistent table swap with the same table and row counts', () => {
    const expected = expectedInput();
    [expected.sourceManifest.tables[0], expected.sourceManifest.tables[1]] = [expected.sourceManifest.tables[1], expected.sourceManifest.tables[0]];
    expected.sourceManifest.tables[0].artifact.member = `01-${expected.sourceManifest.tables[0].name}.rows.json`;
    expected.sourceManifest.tables[1].artifact.member = `02-${expected.sourceManifest.tables[1].name}.rows.json`;
    expect(() => validateExpected(rehashSourceAndEnvelope(expected))).toThrow('EXPECTED_MANIFEST_INVALID');
  });

  it('rejects a refreshed identity mapping digest after outer rehash', () => {
    const expected = expectedInput();
    expected.identity.mappingSha256 = canonicalHash({ refreshed: true });
    const payload = structuredClone(expected);
    delete payload.expectedSha256;
    expected.expectedSha256 = canonicalHash(payload);
    expect(() => validateExpected(expected)).toThrow('EXPECTED_MANIFEST_INVALID');
  });

  it('rejects same-count per-table key hash substitution after envelope rehash', () => {
    const expected = expectedInput();
    [expected.sourceKeys.tables[0].keySha256, expected.sourceKeys.tables[1].keySha256] =
      [expected.sourceKeys.tables[1].keySha256, expected.sourceKeys.tables[0].keySha256];
    const keyPayload = structuredClone(expected.sourceKeys);
    delete keyPayload.manifestSha256;
    expected.sourceKeys.manifestSha256 = canonicalHash(keyPayload);
    const payload = structuredClone(expected);
    delete payload.expectedSha256;
    expected.expectedSha256 = canonicalHash(payload);
    expect(() => validateExpected(expected)).toThrow('EXPECTED_MANIFEST_INVALID');
  });

  it('builds the image from a declared checked-in manifest', () => {
    const dockerfile = readFileSync(new URL('../cloud-run/hushh-tech-schema-data-verifier-uat/Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain('COPY --chown=node:node index.mjs expected-manifest.v1.json ./');
    expect(dockerfile).not.toContain('expected.json');
  });

  it('accepts only the exact NDA column and RLS boundary', () => {
    const expected = expectedInput().expectedAccess.engagementNdaAdminFetch;
    expect(assessEngagementNdaBoundary(exactEngagementObservation(), expected)).toEqual({
      ready: true,
      roleExists: true,
      selectColumns: [
        'public.nda_signatures.id',
        'public.nda_signatures.nda_version',
        'public.nda_signatures.pdf_url',
        'public.nda_signatures.signed_at',
        'public.nda_signatures.user_id',
      ],
      tableWideSelect: false,
      publicDml: false,
      elevatedPrivileges: false,
      rlsPolicyExact: true,
      rlsPolicy: {
        name: 'nda_signatures_engagement_api_select',
        command: 'SELECT',
        permissive: true,
        roles: ['hushh-tech-engagement-api-uat@hushh-tech-uat.iam'],
        qual: "current_setting('app.firebase_fund_admin',true)='true'",
        withCheck: null,
      },
      missing: [],
    });
  });

  it('captures an absent NDA role as not ready without inventing access', () => {
    const expected = expectedInput().expectedAccess.engagementNdaAdminFetch;
    const observed = exactEngagementObservation();
    observed.role.exists = false;
    observed.role.login = false;
    observed.role.publicSchemaUsage = false;
    observed.selectColumns = [];
    observed.policy = [];
    expect(assessEngagementNdaBoundary(observed, expected)).toMatchObject({
      ready: false,
      roleExists: false,
      missing: ['ROLE_ABSENT', 'EXACT_COLUMN_SELECT_ABSENT', 'EXACT_RLS_POLICY_ABSENT'],
    });
  });

  it.each([
    ['table-wide SELECT', (observed: Record<string, any>) => { observed.tableWideSelect = true; }],
    ['public DML', (observed: Record<string, any>) => { observed.publicDml = true; }],
    ['database TEMP', (observed: Record<string, any>) => { observed.role.databaseTemporary = true; }],
    ['forbidden membership', (observed: Record<string, any>) => { observed.forbiddenMemberships = ['hushh_tech_runtime']; }],
  ])('rejects NDA boundary escalation through %s', (_label, mutate) => {
    const expected = expectedInput().expectedAccess.engagementNdaAdminFetch;
    const observed = exactEngagementObservation();
    mutate(observed);
    expect(() => assessEngagementNdaBoundary(observed, expected)).toThrow('ENGAGEMENT_BOUNDARY_OVERPRIVILEGED');
  });

  it('rejects a broader or altered NDA policy as not ready', () => {
    const expected = expectedInput().expectedAccess.engagementNdaAdminFetch;
    const observed = exactEngagementObservation();
    observed.policy[0].qual = "current_setting('app.firebase_fund_admin', true)='true' OR true";
    expect(assessEngagementNdaBoundary(observed, expected)).toMatchObject({
      ready: false,
      rlsPolicyExact: false,
      missing: ['EXACT_RLS_POLICY_ABSENT'],
    });
  });
});
