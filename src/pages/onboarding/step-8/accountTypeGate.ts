/**
 * Step-5 (review) account-type gate loader. Pulls the account type, signatory
 * confirmation, required account-type fields, and party completion for the current
 * user, then computes the account-type review gate. The review screen ANDs this
 * into its existing required-profile gate (existing logic untouched).
 */
import { useCallback, useEffect, useState } from 'react';
import config from '../../../resources/config/config';
import {
  getAccountTypeConfig,
  type AccountTypeFieldKey,
} from '../../../services/onboarding/accountTypeConfig';
import {
  computeAccountTypeReviewGate,
  type ReviewGateResult,
} from '../../../services/onboarding/reviewGate';
import type { UIAccountType } from '../../../types/onboarding';

const SELECT_COLUMNS = `
  account_type, authorised_signatory_confirmed_at,
  retirement_account_type, custodian_name,
  entity_type, entity_legal_name
`;

const fieldValue = (row: Record<string, unknown>, key: AccountTypeFieldKey): string =>
  String(row[key] ?? '').trim();

export interface ReviewAccountTypeGate extends ReviewGateResult {
  accountType: UIAccountType | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useReviewAccountTypeGate(): ReviewAccountTypeGate {
  const [accountType, setAccountType] = useState<UIAccountType | null>(null);
  const [result, setResult] = useState<ReviewGateResult>({ ok: true, reasons: [] });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!config.gcpBackendClient) {
      setLoading(false);
      return;
    }
    const { data: { user } } = await config.gcpBackendClient.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }
    const [{ data: row }, { data: parties }] = await Promise.all([
      config.gcpBackendClient.from('onboarding_data').select(SELECT_COLUMNS).eq('user_id', user.id).maybeSingle(),
      config.gcpBackendClient.from('onboarding_parties').select('party_role, status, is_required').eq('primary_user_id', user.id),
    ]);

    const validTypes: UIAccountType[] = ['individual', 'joint', 'retirement', 'trust'];
    const type = row && validTypes.includes(row.account_type as UIAccountType)
      ? (row.account_type as UIAccountType)
      : null;
    setAccountType(type);

    const cfg = getAccountTypeConfig(type);
    const accountTypeFieldsComplete = cfg.accountTypeFields
      .filter((f) => f.required)
      .every((f) => (row ? fieldValue(row, f.key) !== '' : false));

    const completedByRole = new Map<string, number>();
    for (const p of parties || []) {
      if (p.status === 'completed') {
        completedByRole.set(p.party_role, (completedByRole.get(p.party_role) || 0) + 1);
      }
    }
    const requiredPartiesComplete = cfg.requiredParties
      .filter((p) => p.required && p.min > 0)
      .every((p) => (completedByRole.get(p.role) || 0) >= p.min);

    setResult(
      computeAccountTypeReviewGate({
        accountType: type,
        signatoryConfirmedAt: row?.authorised_signatory_confirmed_at ?? null,
        accountTypeFieldsComplete,
        requiredPartiesComplete,
      }),
    );
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { ...result, accountType, loading, refresh };
}
