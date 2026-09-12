import { describe, expect, it } from 'vitest';

import {
  buildFinancialVerificationRows,
  type FinancialVerificationRowsInput,
} from '../src/pages/onboarding/financial-link/verificationRows';

const buildRows = (
  overrides: Partial<FinancialVerificationRowsInput> = {},
) => buildFinancialVerificationRows({
  assetsStatus: 'idle',
  investmentsStatus: 'idle',
  identityStatus: 'idle',
  identityInfo: null,
  investmentHoldingsCount: 0,
  investmentAccountsCount: 0,
  ...overrides,
});

const rowByTitle = (
  rows: ReturnType<typeof buildFinancialVerificationRows>,
  title: 'Assets' | 'Investments' | 'Identity',
) => rows.find((row) => row.title === title)!;

describe('financial-link verification card states', () => {
  it('keeps pre-link product cards distinct from unavailable data', () => {
    for (const title of ['Assets', 'Investments', 'Identity'] as const) {
      expect(rowByTitle(buildRows(), title)).toMatchObject({
        status: 'idle',
        subtitle: 'Waiting to connect',
      });
    }
  });

  it('uses the Assets product status rather than a balance-derived status', () => {
    const assets = rowByTitle(buildRows({ assetsStatus: 'unavailable' }), 'Assets');

    expect(assets).toMatchObject({
      status: 'unavailable',
      subtitle: 'Not Available',
    });
  });

  it('keeps the asset-report lifecycle visible', () => {
    expect(rowByTitle(buildRows({ assetsStatus: 'pending' }), 'Assets')).toMatchObject({
      status: 'pending',
      subtitle: 'Generating report',
    });
    expect(rowByTitle(buildRows({ assetsStatus: 'error' }), 'Assets')).toMatchObject({
      status: 'error',
      subtitle: 'Unable to retrieve',
    });
  });

  it('labels investments as empty only after a successful zero-result response', () => {
    const successWithNoData = rowByTitle(buildRows({
      investmentsStatus: 'success',
      investmentHoldingsCount: 0,
      investmentAccountsCount: 0,
    }), 'Investments');

    expect(successWithNoData).toMatchObject({
      status: 'success',
      subtitle: 'No Investment Holdings',
    });

    for (const status of ['idle', 'loading', 'pending', 'unavailable', 'error'] as const) {
      const investments = rowByTitle(buildRows({
        investmentsStatus: status,
        investmentHoldingsCount: 0,
        investmentAccountsCount: 0,
      }), 'Investments');

      expect(investments.status).toBe(status);
      expect(investments.subtitle).not.toBe('No Investment Holdings');
    }
  });

  it('keeps a successful investment response with accounts but no holdings distinct', () => {
    const investments = rowByTitle(buildRows({
      investmentsStatus: 'success',
      investmentHoldingsCount: 0,
      investmentAccountsCount: 2,
    }), 'Investments');

    expect(investments).toMatchObject({
      status: 'success',
      subtitle: '2 Linked Accounts · No holdings',
    });
  });

  it('distinguishes unsupported, failed, and genuinely empty Identity results', () => {
    expect(rowByTitle(buildRows({ identityStatus: 'unavailable' }), 'Identity')).toMatchObject({
      status: 'unavailable',
      subtitle: 'Not Available',
    });
    expect(rowByTitle(buildRows({ identityStatus: 'error' }), 'Identity')).toMatchObject({
      status: 'error',
      subtitle: 'Unable to retrieve',
    });
    expect(rowByTitle(buildRows({ identityStatus: 'success' }), 'Identity')).toMatchObject({
      status: 'unavailable',
      subtitle: 'No identity data returned',
    });
  });

  it('marks identity verified only when the product succeeded and returned identity data', () => {
    const identity = rowByTitle(buildRows({
      identityStatus: 'success',
      identityInfo: { names: ['Taylor Example'] },
    }), 'Identity');

    expect(identity).toMatchObject({
      status: 'success',
      subtitle: '✓ Verified — Taylor Example',
    });
  });

  it('does not let parsed identity data mask a later product failure', () => {
    const identity = rowByTitle(buildRows({
      identityStatus: 'error',
      identityInfo: { names: ['Taylor Example'] },
    }), 'Identity');

    expect(identity).toMatchObject({
      status: 'error',
      subtitle: 'Unable to retrieve',
    });
  });
});
