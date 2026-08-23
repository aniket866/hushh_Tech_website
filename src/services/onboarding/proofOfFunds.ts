/**
 * Proof-of-funds status (§3.3, §3.4, §4) — Phase 1, "where available".
 * Compares the connected funding account's available balance against the selected
 * investment amount. Surfaced as a status on Review (§9) and in the admin console
 * (§10). It is a funding-readiness signal, never a hard submit block (consistent
 * with the codebase's review-flag philosophy).
 *
 * The Deno copy lives at gcpBackend/functions/_shared/proofOfFunds.ts (used by the
 * admin detail + onboarding-proof-of-funds edge functions).
 */
export type ProofOfFundsStatus = 'funds_sufficient' | 'funds_insufficient' | 'balance_unavailable';

export const PROOF_OF_FUNDS_LABELS: Record<ProofOfFundsStatus, string> = {
  funds_sufficient: 'Funds sufficient',
  funds_insufficient: 'Funds insufficient',
  balance_unavailable: 'Balance unavailable',
};

export const computeProofOfFundsStatus = (params: {
  balanceCents: number | null | undefined;
  investmentCents: number | null | undefined;
}): ProofOfFundsStatus => {
  const balance = Number(params.balanceCents);
  const investment = Number(params.investmentCents);
  // "Where available" — no usable bank balance or no chosen amount → unavailable.
  if (!params.balanceCents || !Number.isFinite(balance) || balance <= 0) return 'balance_unavailable';
  if (!params.investmentCents || !Number.isFinite(investment) || investment <= 0) {
    return 'balance_unavailable';
  }
  return balance >= investment ? 'funds_sufficient' : 'funds_insufficient';
};
