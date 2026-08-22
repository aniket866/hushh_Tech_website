/**
 * Account-type configuration — the SINGLE SOURCE OF TRUTH for how the selected
 * account type (Step 2 "Who is investing?") drives the rest of onboarding.
 *
 * Spec core rule: "Step 2 account type selection must control the rest of the
 * onboarding journey — fields, additional parties, signatory, Plaid checks,
 * review logic, and whether the investor can proceed."
 *
 * Everything downstream (Step 2 options, the Application Hub, the review gate,
 * and the edge-function validators) reads from this config instead of scattering
 * `if (accountType === 'joint')` branches across the codebase.
 *
 * This module is intentionally data-only (no React, no GcpBackend) so it can be
 * imported by UI, services, and vitest contract tests alike. The Deno edge
 * functions keep a mirrored copy (see PR5: gcpBackend/functions/_shared/
 * onboardingParties.ts) with a contract test asserting the two stay in sync.
 */
import type { UIAccountType, AccountStructure } from '../../types/onboarding';

/** Roles for additional parties an account type may require or invite. */
export type PartyRole =
  | 'joint_owner'
  | 'retirement_custodian'
  | 'retirement_administrator'
  | 'trustee'
  | 'co_trustee'
  | 'beneficial_owner'
  | 'controlling_person'
  | 'authorised_person'
  | 'authorised_signatory';

export interface PartyRequirement {
  role: PartyRole;
  label: string;
  helpText?: string;
  /** Minimum number of completed parties of this role to satisfy the gate. */
  min: number;
  /** Maximum number of parties of this role the primary may add/invite. */
  max: number;
  /** Whether this party can be invited via a secure email link. */
  invitable: boolean;
  /** Whether completion of this role gates application submission. */
  required: boolean;
}

/** Account-type-specific scalar fields collected on the Hub (individual-led). */
export type AccountTypeFieldKey =
  | 'retirement_account_type'
  | 'custodian_name'
  | 'custodian_contact_email'
  | 'custodian_contact_phone'
  | 'custodian_account_number'
  | 'custodian_approval_required'
  | 'entity_type'
  | 'entity_legal_name'
  | 'entity_tax_id_ein'
  | 'formation_state'
  | 'formation_country'
  | 'registered_address'
  | 'principal_address';

export interface AccountTypeField {
  key: AccountTypeFieldKey;
  label: string;
  required: boolean;
  /** PII — admin endpoints must expose only a `*Provided` boolean / masked value. */
  sensitive?: boolean;
}

export interface SignatoryRule {
  /** Individual accounts auto-confirm the primary investor as signatory. */
  defaultToPrimary: boolean;
  /** Non-individual accounts require an explicit signatory confirmation. */
  requiresExplicitConfirm: boolean;
}

/** Ordered tasks shown on the Application Hub for an account type. */
export type HubTaskKey =
  | 'account_type_details'
  | 'additional_parties'
  | 'authorised_signatory'
  | 'investment'
  | 'plaid'
  | 'disclosures'
  | 'review_submit';

export interface AccountTypeConfig {
  value: UIAccountType;
  label: string;
  description: string;
  /** Material Symbols icon name rendered in the Step 2 picker. */
  icon: string;
  /** The true value persisted to onboarding_data.account_structure. */
  accountStructure: AccountStructure;
  /** Full corporate KYB / beneficial-ownership verification is Phase 2. */
  kybPhase2?: boolean;
  requiredParties: PartyRequirement[];
  accountTypeFields: AccountTypeField[];
  signatory: SignatoryRule;
  hubTasks: HubTaskKey[];
}

/** Shape consumed by the Step 2 account-type picker UI. */
export interface AccountTypeOption {
  value: UIAccountType;
  label: string;
  description: string;
  icon: string;
  /**
   * Still under development — shown in the Step 2 picker but disabled with an
   * "Under development" pill. Only Individual is selectable today.
   */
  comingSoon: boolean;
}

const SIGNATORY_PRIMARY: SignatoryRule = {
  defaultToPrimary: true,
  requiresExplicitConfirm: false,
};

const SIGNATORY_EXPLICIT: SignatoryRule = {
  defaultToPrimary: false,
  requiresExplicitConfirm: true,
};

// Tasks every account type ends with, in order.
const COMMON_TAIL_TASKS: HubTaskKey[] = [
  'authorised_signatory',
  'investment',
  'plaid',
  'disclosures',
  'review_submit',
];

export const ACCOUNT_TYPE_CONFIG: Record<UIAccountType, AccountTypeConfig> = {
  individual: {
    value: 'individual',
    label: 'Individual',
    description: 'One person investing in their own name.',
    icon: 'person',
    accountStructure: 'individual',
    requiredParties: [],
    accountTypeFields: [],
    signatory: SIGNATORY_PRIMARY,
    // No account-type details or additional parties — keeps the simple case simple.
    hubTasks: ['authorised_signatory', 'investment', 'plaid', 'disclosures', 'review_submit'],
  },

  joint: {
    value: 'joint',
    label: 'Joint',
    description: 'Two owners investing together. We collect the primary investor first.',
    icon: 'group',
    accountStructure: 'joint',
    requiredParties: [
      {
        role: 'joint_owner',
        label: 'Joint owner',
        helpText: 'Each joint owner completes their own profile and bank/KYC checks.',
        min: 1,
        max: 3,
        invitable: true,
        required: true,
      },
    ],
    accountTypeFields: [],
    signatory: SIGNATORY_EXPLICIT,
    hubTasks: ['additional_parties', ...COMMON_TAIL_TASKS],
  },

  retirement: {
    value: 'retirement',
    label: 'Retirement',
    description: 'Traditional or Roth retirement account. The custodian is the subscriber.',
    icon: 'account_balance',
    accountStructure: 'retirement',
    // The custodian (e.g. Fidelity, Schwab) is the legal subscriber — the account
    // is registered "[Custodian] FBO [Investor] IRA" and the custodian counter-signs.
    // So the custodian must complete their section before the application can submit.
    requiredParties: [
      {
        role: 'retirement_custodian',
        label: 'Custodian',
        helpText: 'The custodian is the subscriber of record and counter-signs the subscription.',
        min: 1,
        max: 1,
        invitable: true,
        required: true,
      },
      {
        role: 'retirement_administrator',
        label: 'Administrator',
        min: 0,
        max: 1,
        invitable: true,
        required: false,
      },
    ],
    accountTypeFields: [
      { key: 'retirement_account_type', label: 'Retirement account type', required: true },
      { key: 'custodian_name', label: 'Custodian name', required: true },
      { key: 'custodian_contact_email', label: 'Custodian contact email', required: true },
      { key: 'custodian_contact_phone', label: 'Custodian contact phone', required: false },
      { key: 'custodian_account_number', label: 'Custodian account number', required: false, sensitive: true },
      { key: 'custodian_approval_required', label: 'Custodian approval required', required: false },
    ],
    signatory: SIGNATORY_EXPLICIT,
    hubTasks: ['account_type_details', 'additional_parties', ...COMMON_TAIL_TASKS],
  },

  trust: {
    value: 'trust',
    label: 'Trust / Entity',
    description: 'Trust, LLC, corporation, partnership, or managed ownership review.',
    icon: 'shield',
    accountStructure: 'trust',
    kybPhase2: true,
    requiredParties: [
      {
        role: 'trustee',
        label: 'Trustee',
        helpText: 'At least one trustee must complete their own KYC section.',
        min: 1,
        max: 5,
        invitable: true,
        required: true,
      },
      { role: 'co_trustee', label: 'Co-trustee', min: 0, max: 5, invitable: true, required: false },
      {
        role: 'authorised_signatory',
        label: 'Authorised signatory',
        helpText: 'The person authorised to sign on behalf of the trust / entity.',
        min: 0,
        max: 2,
        invitable: true,
        required: false,
      },
      { role: 'beneficial_owner', label: 'Beneficial owner', min: 0, max: 10, invitable: true, required: false },
      {
        role: 'controlling_person',
        label: 'Controlling person',
        helpText: 'Anyone who ultimately owns or controls the trust / entity.',
        min: 0,
        max: 10,
        invitable: true,
        required: false,
      },
    ],
    accountTypeFields: [
      { key: 'entity_type', label: 'Entity type', required: true },
      { key: 'entity_legal_name', label: 'Legal name', required: true },
      { key: 'entity_tax_id_ein', label: 'Tax ID / EIN', required: true, sensitive: true },
      { key: 'formation_state', label: 'Formation state', required: false },
      { key: 'formation_country', label: 'Formation country', required: false },
      { key: 'registered_address', label: 'Registered address', required: true },
      { key: 'principal_address', label: 'Principal address', required: true },
    ],
    signatory: SIGNATORY_EXPLICIT,
    hubTasks: ['account_type_details', 'additional_parties', ...COMMON_TAIL_TASKS],
  },
};

/** Ordered list of account types as shown in the Step 2 picker. */
export const ACCOUNT_TYPE_ORDER: UIAccountType[] = ['individual', 'joint', 'retirement', 'trust'];

/**
 * Account types still under development. They appear in the Step 2 picker but are
 * disabled with an "Under development" pill — only Individual can be selected
 * today. To launch one, remove it from this set (no other change required).
 */
export const COMING_SOON_ACCOUNT_TYPES = new Set<UIAccountType>(['joint', 'retirement', 'trust']);

/** Whether an account type can currently be selected in onboarding. */
export const isAccountTypeAvailable = (value: UIAccountType): boolean =>
  !COMING_SOON_ACCOUNT_TYPES.has(value);

/** Options consumed by the Step 2 picker, derived from the config. */
export const ACCOUNT_TYPE_OPTIONS: AccountTypeOption[] = ACCOUNT_TYPE_ORDER.map((value) => {
  const cfg = ACCOUNT_TYPE_CONFIG[value];
  return {
    value: cfg.value,
    label: cfg.label,
    description: cfg.description,
    icon: cfg.icon,
    comingSoon: COMING_SOON_ACCOUNT_TYPES.has(value),
  };
});

const VALID_ACCOUNT_TYPES = new Set<string>(ACCOUNT_TYPE_ORDER);

export const isUIAccountType = (value: unknown): value is UIAccountType =>
  typeof value === 'string' && VALID_ACCOUNT_TYPES.has(value);

/** Returns the config for an account type, defaulting to individual when unknown. */
export const getAccountTypeConfig = (value: unknown): AccountTypeConfig =>
  isUIAccountType(value) ? ACCOUNT_TYPE_CONFIG[value] : ACCOUNT_TYPE_CONFIG.individual;

/**
 * Maps a UI account type to the value persisted in onboarding_data.account_structure.
 * The DB CHECK was widened (migration 20260220110000) to allow the true structure,
 * so we persist it directly instead of the old lossy individual|other collapse.
 */
export const accountStructureFor = (value: UIAccountType): AccountStructure =>
  ACCOUNT_TYPE_CONFIG[value]?.accountStructure ?? 'other';
