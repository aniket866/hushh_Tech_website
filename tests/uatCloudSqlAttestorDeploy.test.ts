import { describe, expect, it } from 'vitest';

import {
  buildActivationEnv,
  buildPlan,
  parseArguments,
  TARGET,
} from '../scripts/gcp/migration/uat-cloudsql-attestor-deploy.mjs';

const digest = `sha256:${'a'.repeat(64)}`;

describe('governed UAT Cloud SQL attestor deployment', () => {
  it('builds only the exact UAT read-only attestation environment', () => {
    const env = buildActivationEnv(digest);

    expect(env.HUSHH_TECH_CLOUDSQL_ATTESTOR_EXECUTE).toBe('true');
    expect(env.HUSHH_TECH_CLOUDSQL_ATTESTOR_PROJECT).toBe(TARGET.project);
    expect(env.HUSHH_TECH_CLOUDSQL_ATTESTOR_DATABASE).toBe(TARGET.database);
    expect(env.HUSHH_TECH_CLOUDSQL_ATTESTOR_IMAGE_DIGEST).toBe(digest);
    expect(Object.keys(env)).not.toContain('DATABASE_URL');
    expect(Object.keys(env)).not.toContain('PGPASSWORD');
  });

  it('requires explicit attestation activation before an execution', () => {
    expect(parseArguments([])).toEqual({ activate: false, run: false });
    expect(parseArguments(['--activate-attestation', '--run-attestation'])).toEqual({
      activate: true,
      run: true,
    });
    expect(() => parseArguments(['--run-attestation'])).toThrow();
    expect(() => parseArguments(['--apply'])).toThrow();
  });

  it('pins private VPC networking and keeps migration apply disabled in the plan', () => {
    const plan = buildPlan({ commit: 'b'.repeat(40) });

    expect(plan.mode).toBe('READ_ONLY_ATTESTATION');
    expect(plan.apply).toBe(false);
    expect(plan.network).toMatchObject({
      type: 'DIRECT_VPC_EGRESS',
      network: 'default',
      subnet: 'default',
      egress: 'private-ranges-only',
      publicIp: false,
    });
  });
});
