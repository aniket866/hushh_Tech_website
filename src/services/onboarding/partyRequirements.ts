/**
 * Per-role required fields an INVITED party must complete on their tokenized
 * onboarding page (§5/§6/§7). This is the client copy; an identical copy lives at
 * gcpBackend/functions/_shared/onboardingParties.ts for server-side validation, and
 * a contract test (tests/partyRequirementsSync.test.ts) asserts the two never drift.
 *
 * Joint owners complete FULL KYC parity with the primary investor (identity,
 * residence, tax id, contact) plus their own bank connection — their invite is the
 * second owner doing real KYC, not just leaving contact details. Other roles stay
 * identity-level for now (trust/retirement parity lands in later slices).
 *
 * Sensitive fields (tax id) are never stored in the party `profile` jsonb: the edge
 * functions move them to a dedicated column and leave a `<key>_provided` marker so
 * the completeness gate and reloads still see the field as satisfied.
 */
import type { PartyRole } from './accountTypeConfig';

/** Input affordance the invitee page renders for a field. Defaults to 'text'. */
export type PartyFieldType = 'text' | 'email' | 'tel' | 'date' | 'country' | 'ssn' | 'select';

export interface PartyFieldDef {
  key: string;
  label: string;
  required: boolean;
  /** Input type rendered on the invitee page. Omitted = 'text'. */
  type?: PartyFieldType;
  /** Groups fields into the invitee page's sub-steps. Omitted = 'Your details'. */
  section?: string;
  /** PII — stored in a dedicated column, never echoed back; admin sees only `<key>_provided`. */
  sensitive?: boolean;
  /** Options for 'select' fields (small fixed enums only — keep both copies identical). */
  options?: { value: string; label: string }[];
}

const BASE_PARTY_FIELDS: PartyFieldDef[] = [
  { key: 'full_name', label: 'Full legal name', required: true },
  { key: 'email', label: 'Email', required: true, type: 'email' },
  { key: 'phone', label: 'Phone', required: false, type: 'tel' },
];

/**
 * Full-KYC field set mirroring the primary investor's Step-3. Used by a joint
 * owner and by trust/entity parties (trustee, signatory, beneficial owner,
 * controlling person) — anyone the fund must KYC, not just leave contact details.
 */
const FULL_KYC_FIELDS: PartyFieldDef[] = [
  { key: 'full_name', label: 'Full legal name', required: true, section: 'Identity' },
  { key: 'date_of_birth', label: 'Date of birth', required: true, type: 'date', section: 'Identity' },
  { key: 'citizenship_country', label: 'Citizenship', required: true, type: 'country', section: 'Residence' },
  { key: 'residence_country', label: 'Country of residence', required: true, type: 'country', section: 'Residence' },
  { key: 'address_line_1', label: 'Address line 1', required: true, section: 'Residence' },
  { key: 'address_line_2', label: 'Address line 2', required: false, section: 'Residence' },
  { key: 'city', label: 'City', required: true, section: 'Residence' },
  { key: 'state', label: 'State / region', required: false, section: 'Residence' },
  { key: 'zip_code', label: 'ZIP / postal code', required: true, section: 'Residence' },
  { key: 'tax_id', label: 'SSN / Tax ID', required: true, type: 'ssn', sensitive: true, section: 'Tax' },
  { key: 'email', label: 'Email', required: true, type: 'email', section: 'Contact' },
  { key: 'phone', label: 'Phone', required: false, type: 'tel', section: 'Contact' },
];

const ROLE_TITLE_FIELD: PartyFieldDef = { key: 'role_title', label: 'Role / title', required: false, section: 'Role' };

/** Role → fields the invited party fills in. Keep in sync with the Deno copy. */
export const PARTY_FIELD_DEFS: Record<PartyRole, PartyFieldDef[]> = {
  joint_owner: FULL_KYC_FIELDS,
  retirement_custodian: [
    { key: 'full_name', label: 'Contact name', required: true },
    { key: 'email', label: 'Email', required: true, type: 'email' },
    { key: 'phone', label: 'Phone', required: false, type: 'tel' },
    { key: 'institution', label: 'Institution', required: false },
  ],
  retirement_administrator: [
    { key: 'full_name', label: 'Contact name', required: true },
    { key: 'email', label: 'Email', required: true, type: 'email' },
    { key: 'phone', label: 'Phone', required: false, type: 'tel' },
    { key: 'institution', label: 'Institution', required: false },
  ],
  trustee: [...FULL_KYC_FIELDS, ROLE_TITLE_FIELD],
  co_trustee: [...FULL_KYC_FIELDS, ROLE_TITLE_FIELD],
  beneficial_owner: [
    ...FULL_KYC_FIELDS,
    { key: 'ownership_percent', label: 'Ownership %', required: false, section: 'Role' },
  ],
  controlling_person: [...FULL_KYC_FIELDS, ROLE_TITLE_FIELD],
  authorised_person: [
    ...BASE_PARTY_FIELDS,
    { key: 'relationship', label: 'Relationship to investor', required: true },
  ],
  authorised_signatory: [
    ...FULL_KYC_FIELDS,
    { key: 'title', label: 'Title', required: false, section: 'Role' },
  ],
};

/** Maps a sensitive field key to the dedicated column the edge functions write it to. */
export const SENSITIVE_FIELD_COLUMNS: Record<string, string> = {
  tax_id: 'tax_id_encrypted',
};

export const getPartyFieldDefs = (role: string): PartyFieldDef[] =>
  PARTY_FIELD_DEFS[role as PartyRole] ?? BASE_PARTY_FIELDS;

const isProvided = (value: unknown): boolean =>
  value === true || String(value ?? '').trim().toLowerCase() === 'true';

/** Returns the required field keys missing from a party's profile. */
export const missingPartyFields = (
  role: string,
  profile: Record<string, unknown> | null | undefined,
): string[] => {
  const data = profile ?? {};
  return getPartyFieldDefs(role)
    .filter((f) => f.required)
    .filter((f) => {
      // Sensitive fields are stored out of the jsonb; a `<key>_provided` marker
      // (or the raw value, before it's split off) satisfies the gate.
      if (f.sensitive && isProvided(data[`${f.key}_provided`])) return false;
      const v = data[f.key];
      return v === undefined || v === null || String(v).trim() === '';
    })
    .map((f) => f.key);
};

/**
 * Whitelist an incoming profile to only the known fields for the role. Sensitive
 * raw values are NEVER kept in the profile jsonb — only their `<key>_provided`
 * marker survives (the raw value goes to a dedicated column via the edge function).
 */
export const sanitizePartyProfile = (
  role: string,
  profile: Record<string, unknown> | null | undefined,
): Record<string, string> => {
  const data = profile ?? {};
  const out: Record<string, string> = {};
  for (const f of getPartyFieldDefs(role)) {
    if (f.sensitive) {
      if (isProvided(data[`${f.key}_provided`]) || (data[f.key] != null && String(data[f.key]).trim() !== '')) {
        out[`${f.key}_provided`] = 'true';
      }
      continue;
    }
    const v = data[f.key];
    if (v !== undefined && v !== null) out[f.key] = String(v).slice(0, 500);
  }
  return out;
};

/** Extracts raw sensitive values present in an incoming profile (for column writes). */
export const extractSensitivePartyFields = (
  role: string,
  profile: Record<string, unknown> | null | undefined,
): Record<string, string> => {
  const data = profile ?? {};
  const out: Record<string, string> = {};
  for (const f of getPartyFieldDefs(role)) {
    if (!f.sensitive) continue;
    const v = data[f.key];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      out[f.key] = String(v).trim().slice(0, 500);
    }
  }
  return out;
};

export const isPartyProfileComplete = (
  role: string,
  profile: Record<string, unknown> | null | undefined,
): boolean => missingPartyFields(role, profile).length === 0;
