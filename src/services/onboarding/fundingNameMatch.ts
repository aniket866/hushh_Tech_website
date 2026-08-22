/**
 * Funding account-holder name match (§ Trust/Entity). Compares the Plaid-reported
 * bank account holder name against the EXPECTED legal name (the entity's legal name
 * for a trust, the custodian/IRA registration for retirement). A mismatch — e.g. a
 * personal account funding an entity subscription — is surfaced as a review flag and
 * routes the application to manual review. It is a flag, never a hard submit block,
 * consistent with the codebase's review-flag philosophy (see proofOfFunds.ts).
 *
 * The Deno copy lives at gcpBackend/functions/_shared/fundingNameMatch.ts and MUST
 * stay in sync (tests/fundingNameMatchSync.test.ts asserts identical behaviour).
 */
export type FundingNameMatchStatus = 'match' | 'mismatch' | 'unavailable';

export const FUNDING_NAME_MATCH_LABELS: Record<FundingNameMatchStatus, string> = {
  match: 'Account name matches',
  mismatch: 'Account name mismatch',
  unavailable: 'Name match unavailable',
};

// Stripped so "Acme Holdings LLC" and "Acme Holdings" compare equal.
const LEGAL_SUFFIXES = new Set([
  'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd',
  'limited', 'lp', 'llp', 'plc', 'trust', 'the', 'fbo', 'foundation', 'partners',
  'partnership', 'holdings', 'holding', 'group', 'fund', 'and',
]);

const normalizeName = (raw: string | null | undefined): string =>
  String(raw ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !LEGAL_SUFFIXES.has(t))
    .join(' ')
    .trim();

/** True if every token of the shorter name appears in the longer (order-free). */
const namesMatch = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size === 0) return false;
  for (const t of small) if (!big.has(t)) return false;
  return true;
};

export const computeFundingNameMatch = (params: {
  expectedName: string | null | undefined;
  accountHolderNames: Array<string | null | undefined> | null | undefined;
}): FundingNameMatchStatus => {
  const expected = normalizeName(params.expectedName);
  const holders = (params.accountHolderNames ?? []).map(normalizeName).filter(Boolean);
  if (!expected || holders.length === 0) return 'unavailable';
  return holders.some((h) => namesMatch(h, expected)) ? 'match' : 'mismatch';
};

/** Pull account-holder names out of a Plaid /identity/get response (identity_data). */
export const extractPlaidHolderNames = (identityData: unknown): string[] => {
  const data = identityData as { accounts?: Array<{ owners?: Array<{ names?: string[] }> }> } | null;
  const out: string[] = [];
  for (const account of data?.accounts ?? []) {
    for (const owner of account.owners ?? []) {
      for (const name of owner.names ?? []) {
        if (name && String(name).trim()) out.push(String(name).trim());
      }
    }
  }
  return [...new Set(out)];
};
