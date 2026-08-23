/**
 * Step-3 account-type sections — additive logic.
 *
 * The spec core rule (§1, §13): "Step 2 account type must control the rest of the
 * onboarding journey." This module adds the account-type-specific collection that
 * renders INSIDE the existing Step-3 (Confirm details) without touching the
 * existing `useCombinedLocationLogic` hook:
 *   - Authorised Signatory (§3.2) — all account types.
 *   - Retirement details (§6) — custodian fields.
 *   - Trust / Entity details (§7) — entity legal name, EIN, formation, addresses.
 *
 * Pure helpers (`isAccountTypeSectionComplete`, `buildAccountTypeSavePayload`) are
 * exported and unit-tested, mirroring the `buildStep3SavePayload` pattern in
 * ../logic.ts. The hook persists via the shared `upsertOnboardingData` (the same
 * missing-column retry path used everywhere else in onboarding).
 */
import { useEffect, useState } from 'react';
import config from '../../../../resources/config/config';
import { upsertOnboardingData } from '../../../../services/onboarding/upsertOnboardingData';
import { CONSENT_VERSION } from '../../../../services/consent/consentConfig';
import {
  getAccountTypeConfig,
  type AccountTypeFieldKey,
} from '../../../../services/onboarding/accountTypeConfig';
import type { UIAccountType } from '../../../../types/onboarding';

export interface SelectOption {
  value: string;
  label: string;
}

// Must stay in sync with the CHECK constraints in
// gcpBackend/migrations/20260617120000_add_onboarding_account_type_columns.sql
export const RETIREMENT_ACCOUNT_TYPES: SelectOption[] = [
  { value: 'traditional_ira', label: 'Traditional IRA' },
  { value: 'roth_ira', label: 'Roth IRA' },
  { value: 'sep_ira', label: 'SEP IRA' },
  { value: 'simple_ira', label: 'SIMPLE IRA' },
  { value: '401k', label: '401(k)' },
  { value: 'pension', label: 'Pension' },
  { value: 'other', label: 'Other' },
];

export const ENTITY_TYPES: SelectOption[] = [
  { value: 'revocable_trust', label: 'Revocable Trust' },
  { value: 'irrevocable_trust', label: 'Irrevocable Trust' },
  { value: 'llc', label: 'LLC' },
  { value: 'c_corp', label: 'C Corporation' },
  { value: 's_corp', label: 'S Corporation' },
  { value: 'lp', label: 'Limited Partnership (LP)' },
  { value: 'llp', label: 'Limited Liability Partnership (LLP)' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'family_office', label: 'Family Office' },
  { value: 'holding_company', label: 'Holding Company' },
  { value: 'other', label: 'Other' },
];

/** Account-type field values keyed by the onboarding_data column name. */
export type AccountTypeFieldValues = Partial<Record<AccountTypeFieldKey, string | boolean>>;

export interface AccountTypeSectionState {
  /** Non-individual accounts require an explicit signatory confirmation (§3.2). */
  signatoryConfirmed: boolean;
  fields: AccountTypeFieldValues;
}

const BOOLEAN_FIELD_KEYS: AccountTypeFieldKey[] = ['custodian_approval_required'];
const JSONB_ADDRESS_FIELD_KEYS: AccountTypeFieldKey[] = ['registered_address', 'principal_address'];

const isBlank = (value: string | boolean | undefined): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * True when the account type's required account-type fields are filled AND (for
 * non-individual accounts) the authorised signatory has been confirmed. Individual
 * accounts auto-confirm the primary investor as signatory, so they are always
 * complete here.
 */
/** True when every REQUIRED account-type field is filled (ignores signatory). */
export const areAccountTypeFieldsComplete = (
  accountType: UIAccountType | null | undefined,
  fields: AccountTypeFieldValues,
): boolean => {
  for (const field of getAccountTypeConfig(accountType).accountTypeFields) {
    if (field.required && isBlank(fields[field.key])) return false;
  }
  return true;
};

export const isAccountTypeSectionComplete = (
  accountType: UIAccountType | null | undefined,
  state: AccountTypeSectionState,
): boolean => {
  const cfg = getAccountTypeConfig(accountType);
  if (cfg.signatory.requiresExplicitConfirm && !state.signatoryConfirmed) {
    return false;
  }
  return areAccountTypeFieldsComplete(accountType, state.fields);
};

/**
 * Builds the onboarding_data column payload for the account-type sections.
 * `upsertOnboardingData` drops any column the environment's schema cache doesn't
 * know yet, so this is safe to call before the migration reaches an environment.
 */
export const buildAccountTypeSavePayload = (
  accountType: UIAccountType | null | undefined,
  state: AccountTypeSectionState,
  nowIso: string = new Date().toISOString(),
): Record<string, unknown> => {
  const cfg = getAccountTypeConfig(accountType);
  const payload: Record<string, unknown> = {};

  // Authorised signatory (§3.2). Individual auto-confirms the primary investor;
  // other types require the explicit confirmation captured in `signatoryConfirmed`.
  const signatoryConfirmed = cfg.signatory.defaultToPrimary || state.signatoryConfirmed;
  payload.authorised_signatory_is_primary = true;
  payload.authorised_signatory_confirmed_at = signatoryConfirmed ? nowIso : null;
  payload.signatory_consent_version = signatoryConfirmed ? CONSENT_VERSION : null;

  for (const field of cfg.accountTypeFields) {
    const value = state.fields[field.key];
    if (BOOLEAN_FIELD_KEYS.includes(field.key)) {
      payload[field.key] = Boolean(value);
      continue;
    }
    if (JSONB_ADDRESS_FIELD_KEYS.includes(field.key)) {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      payload[field.key] = trimmed ? { formatted: trimmed } : null;
      continue;
    }
    const trimmed = typeof value === 'string' ? value.trim() : '';
    payload[field.key] = trimmed || null;
  }

  return payload;
};

const ACCOUNT_TYPE_COLUMN_SELECT = `
  account_type,
  authorised_signatory_is_primary, authorised_signatory_confirmed_at,
  retirement_account_type, custodian_name, custodian_contact_email,
  custodian_contact_phone, custodian_account_number, custodian_approval_required,
  entity_type, entity_legal_name, entity_tax_id_ein, formation_state,
  formation_country, registered_address, principal_address
`;

const extractAddress = (value: unknown): string => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'formatted' in value) {
    return String((value as { formatted?: unknown }).formatted ?? '');
  }
  return '';
};

export interface UseStep3AccountTypeSections {
  accountType: UIAccountType | null;
  signatoryConfirmed: boolean;
  setSignatoryConfirmed: (checked: boolean) => void;
  fields: AccountTypeFieldValues;
  setField: (key: AccountTypeFieldKey, value: string | boolean) => void;
  showErrors: boolean;
  isComplete: boolean;
  /** Required account-type fields complete (ignores signatory) — gates the wizard's details sub-step. */
  fieldsComplete: boolean;
  persist: () => Promise<{ error: { message: string } | null }>;
}

export function useStep3AccountTypeSections(
  /**
   * The account type the caller already knows (e.g. step-2 just picked it before
   * it is reloaded from the DB). Wins over the persisted value and re-runs the
   * load so the sections reflect the selection immediately.
   */
  accountTypeOverride?: UIAccountType | null,
): UseStep3AccountTypeSections {
  const [userId, setUserId] = useState<string | null>(null);
  const [accountType, setAccountType] = useState<UIAccountType | null>(accountTypeOverride ?? null);
  const [signatoryConfirmed, setSignatoryConfirmedState] = useState(false);
  const [fields, setFields] = useState<AccountTypeFieldValues>({});
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (accountTypeOverride) setAccountType(accountTypeOverride);
    const load = async () => {
      if (!config.gcpBackendClient) return;
      const { data: { user } } = await config.gcpBackendClient.auth.getUser();
      if (!user) return;
      setUserId(user.id);
      const { data } = await config.gcpBackendClient
        .from('onboarding_data')
        .select(ACCOUNT_TYPE_COLUMN_SELECT)
        .eq('user_id', user.id)
        .maybeSingle();
      if (!data) return;

      const validTypes: UIAccountType[] = ['individual', 'joint', 'retirement', 'trust'];
      const type = validTypes.includes(data.account_type as UIAccountType)
        ? (data.account_type as UIAccountType)
        : null;
      setAccountType(accountTypeOverride ?? type);

      // A returning investor who already confirmed keeps the confirmation.
      if (data.authorised_signatory_confirmed_at) setSignatoryConfirmedState(true);

      setFields({
        retirement_account_type: data.retirement_account_type ?? '',
        custodian_name: data.custodian_name ?? '',
        custodian_contact_email: data.custodian_contact_email ?? '',
        custodian_contact_phone: data.custodian_contact_phone ?? '',
        custodian_account_number: data.custodian_account_number ?? '',
        custodian_approval_required: Boolean(data.custodian_approval_required),
        entity_type: data.entity_type ?? '',
        entity_legal_name: data.entity_legal_name ?? '',
        entity_tax_id_ein: data.entity_tax_id_ein ?? '',
        formation_state: data.formation_state ?? '',
        formation_country: data.formation_country ?? '',
        registered_address: extractAddress(data.registered_address),
        principal_address: extractAddress(data.principal_address),
      });
    };
    load();
  }, [accountTypeOverride]);

  const state: AccountTypeSectionState = { signatoryConfirmed, fields };
  const isComplete = isAccountTypeSectionComplete(accountType, state);
  const fieldsComplete = areAccountTypeFieldsComplete(accountType, fields);

  const setSignatoryConfirmed = (checked: boolean) => {
    setSignatoryConfirmedState(checked);
    if (checked) setShowErrors(false);
  };

  const setField = (key: AccountTypeFieldKey, value: string | boolean) => {
    setFields((prev) => ({ ...prev, [key]: value }));
    setShowErrors(false);
  };

  const persist = async (): Promise<{ error: { message: string } | null }> => {
    if (!isComplete) {
      setShowErrors(true);
      return { error: { message: 'Account-type section incomplete' } };
    }
    if (!userId || !config.gcpBackendClient) {
      // Dev preview / unauthenticated: nothing to persist, let the flow continue.
      return { error: null };
    }
    return upsertOnboardingData(userId, buildAccountTypeSavePayload(accountType, state));
  };

  return {
    accountType,
    signatoryConfirmed,
    setSignatoryConfirmed,
    fields,
    setField,
    showErrors,
    isComplete,
    fieldsComplete,
    persist,
  };
}
