import type { ProductFetchStatus } from '../../../services/plaid/plaidService';

export interface FinancialLinkIdentityInfo {
  names: readonly string[];
}

export interface FinancialVerificationRow {
  icon: 'account_balance_wallet' | 'monitoring' | 'badge';
  title: 'Assets' | 'Investments' | 'Identity';
  subtitle: string;
  status: ProductFetchStatus;
}

export interface FinancialVerificationRowsInput {
  assetsStatus: ProductFetchStatus;
  investmentsStatus: ProductFetchStatus;
  identityStatus: ProductFetchStatus;
  identityInfo: FinancialLinkIdentityInfo | null;
  investmentHoldingsCount: number;
  investmentAccountsCount: number;
}

const unavailableSubtitleFor = (status: ProductFetchStatus): string => {
  switch (status) {
    case 'loading':
      return 'Fetching...';
    case 'pending':
      return 'Pending';
    case 'error':
      return 'Unable to retrieve';
    case 'idle':
      return 'Waiting to connect';
    case 'unavailable':
    case 'success':
      return 'Not Available';
  }
};

/**
 * Maps the independent Plaid product states to the three summary cards.
 *
 * An empty investment message is intentionally only emitted after Plaid
 * confirms a successful investments response with no holdings/accounts. A
 * product error or unsupported product must remain distinguishable from that
 * genuinely empty result.
 */
export const buildFinancialVerificationRows = ({
  assetsStatus,
  investmentsStatus,
  identityStatus,
  identityInfo,
  investmentHoldingsCount,
  investmentAccountsCount,
}: FinancialVerificationRowsInput): FinancialVerificationRow[] => {
  const assets: FinancialVerificationRow = {
    icon: 'account_balance_wallet',
    title: 'Assets',
    subtitle: assetsStatus === 'success'
      ? 'Report generated'
      : assetsStatus === 'pending'
        ? 'Generating report'
        : unavailableSubtitleFor(assetsStatus),
    status: assetsStatus,
  };

  const investments: FinancialVerificationRow = {
    icon: 'monitoring',
    title: 'Investments',
    subtitle: investmentsStatus !== 'success'
      ? unavailableSubtitleFor(investmentsStatus)
      : investmentHoldingsCount > 0
        ? `${investmentHoldingsCount} Holdings`
        : investmentAccountsCount > 0
          ? `${investmentAccountsCount} Linked Accounts · No holdings`
          : 'No Investment Holdings',
    status: investmentsStatus,
  };

  const identity: FinancialVerificationRow = identityStatus === 'success'
    ? identityInfo
      ? {
        icon: 'badge',
        title: 'Identity',
        subtitle: `✓ Verified — ${identityInfo.names[0] || ''}`.trimEnd(),
        status: 'success',
      }
      : {
        icon: 'badge',
        title: 'Identity',
        subtitle: 'No identity data returned',
        status: 'unavailable',
      }
    : {
      icon: 'badge',
      title: 'Identity',
      subtitle: unavailableSubtitleFor(identityStatus),
      status: identityStatus,
    };

  return [assets, investments, identity];
};
