/**
 * Network Worth Score (NWS) Calculator
 * 
 * Calculates a score 0–100 from Plaid financial data.
 * Pure math — no API calls, no AI.
 * 
 * Breakdown (100 points total):
 *   Liquidity Score       (20 pts) — checking + savings balances
 *   Investment Score      (25 pts) — investment holdings value
 *   Asset Depth           (20 pts) — total assets from balances
 *   Diversification       (15 pts) — variety of account types
 *   Identity Confidence   (10 pts) — Plaid identity match scores
 *   Account Health        (10 pts) — available vs current ratio
 */

// ── Types ──

export interface NWSInput {
  balanceData: any | null;       // Plaid balance response
  investmentsData: any | null;   // Plaid investments holdings
  identityMatchData: any | null; // Plaid identity match scores
}

export interface NWSResult {
  score: number;           // 0–100 total
  breakdown: NWSBreakdown;
  grade: 'A+' | 'A' | 'B+' | 'B' | 'C+' | 'C' | 'D' | 'F';
  label: string;           // "Excellent", "Good", etc.
}

export interface NWSBreakdown {
  liquidity: number;        // 0–20
  investments: number;      // 0–25
  assetDepth: number;       // 0–20
  diversification: number;  // 0–15
  identityConfidence: number; // 0–10
  accountHealth: number;    // 0–10
}

// ── Helpers ──

/** Clamp a value between min and max */
const clamp = (val: number, min: number, max: number) =>
  Math.max(min, Math.min(max, val));

/** Safe parse number from any value */
const toNum = (val: any): number => {
  if (val === null || val === undefined) return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
};

/** Get score grade from total score */
const getGrade = (score: number): NWSResult['grade'] => {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B+';
  if (score >= 60) return 'B';
  if (score >= 50) return 'C+';
  if (score >= 40) return 'C';
  if (score >= 25) return 'D';
  return 'F';
};

/** Get human-readable label from score */
const getLabel = (score: number): string => {
  if (score >= 90) return 'Exceptional';
  if (score >= 80) return 'Excellent';
  if (score >= 70) return 'Very Good';
  if (score >= 60) return 'Good';
  if (score >= 50) return 'Fair';
  if (score >= 40) return 'Below Average';
  if (score >= 25) return 'Needs Improvement';
  return 'Insufficient Data';
};

// ── Score Calculations ──

/**
 * Liquidity Score (0–20 pts)
 * Based on total checking + savings balances.
 * 
 * Scale: $0 → 0pts, $10K → 10pts, $50K → 15pts, $200K+ → 20pts
 */
function calcLiquidityScore(balanceData: any): number {
  if (!balanceData?.accounts) return 0;

  const liquidAccounts = balanceData.accounts.filter((a: any) =>
    ['checking', 'savings', 'money market', 'hsa', 'cd'].includes(a.subtype?.toLowerCase())
  );

  const totalLiquid = liquidAccounts.reduce((sum: number, a: any) => {
    return sum + toNum(a.balances?.current || a.balances?.available || 0);
  }, 0);

  // Logarithmic scale: diminishing returns past $50K
  if (totalLiquid <= 0) return 0;
  if (totalLiquid <= 1000) return 2;
  if (totalLiquid <= 5000) return 5;
  if (totalLiquid <= 10000) return 8;
  if (totalLiquid <= 25000) return 11;
  if (totalLiquid <= 50000) return 14;
  if (totalLiquid <= 100000) return 17;
  return 20;
}

/**
 * Investment Score (0–25 pts)
 * Based on total investment holdings value.
 * 
 * Scale: $0 → 0pts, $50K → 10pts, $250K → 18pts, $1M+ → 25pts
 */
function calcInvestmentScore(investmentsData: any): number {
  if (!investmentsData) return 0;

  // Try holdings first, then accounts
  let totalValue = 0;

  if (investmentsData.holdings && Array.isArray(investmentsData.holdings)) {
    totalValue = investmentsData.holdings.reduce((sum: number, h: any) => {
      return sum + toNum(h.institution_value || h.cost_basis || 0);
    }, 0);
  }

  // Fallback: sum investment account balances
  if (totalValue === 0 && investmentsData.accounts) {
    totalValue = investmentsData.accounts
      .filter((a: any) => ['investment', 'brokerage', '401k', 'ira', 'roth'].includes(a.subtype?.toLowerCase()))
      .reduce((sum: number, a: any) => sum + toNum(a.balances?.current || 0), 0);
  }

  if (totalValue <= 0) return 0;
  if (totalValue <= 5000) return 3;
  if (totalValue <= 25000) return 7;
  if (totalValue <= 50000) return 10;
  if (totalValue <= 100000) return 14;
  if (totalValue <= 250000) return 18;
  if (totalValue <= 500000) return 21;
  if (totalValue <= 1000000) return 23;
  return 25;
}

/**
 * Asset Depth (0–20 pts)
 * Based on total across ALL account types (liquid + investments + credit limits).
 */
function calcAssetDepthScore(balanceData: any, investmentsData: any): number {
  let totalAssets = 0;

  // Sum all balance accounts
  if (balanceData?.accounts) {
    totalAssets += balanceData.accounts.reduce((sum: number, a: any) => {
      const current = toNum(a.balances?.current || 0);
      // For credit cards, available credit shows capacity (not debt)
      if (a.type === 'credit') {
        return sum + toNum(a.balances?.limit || 0);
      }
      return sum + Math.max(0, current);
    }, 0);
  }

  // Add investment value
  if (investmentsData?.holdings) {
    totalAssets += investmentsData.holdings.reduce((sum: number, h: any) =>
      sum + toNum(h.institution_value || 0), 0);
  }

  if (totalAssets <= 0) return 0;
  if (totalAssets <= 5000) return 3;
  if (totalAssets <= 25000) return 7;
  if (totalAssets <= 100000) return 11;
  if (totalAssets <= 250000) return 14;
  if (totalAssets <= 500000) return 17;
  return 20;
}

/**
 * Diversification (0–15 pts)
 * Based on variety of account types and number of institutions.
 * 
 * More types = more diversified portfolio.
 */
function calcDiversificationScore(balanceData: any, investmentsData: any): number {
  const accountTypes = new Set<string>();
  const institutions = new Set<string>();
  let totalAccounts = 0;

  if (balanceData?.accounts) {
    balanceData.accounts.forEach((a: any) => {
      if (a.subtype) accountTypes.add(a.subtype.toLowerCase());
      if (a.type) accountTypes.add(a.type.toLowerCase());
      if (a.institution_id) institutions.add(a.institution_id);
      totalAccounts++;
    });
  }

  if (investmentsData?.accounts) {
    investmentsData.accounts.forEach((a: any) => {
      if (a.subtype) accountTypes.add(a.subtype.toLowerCase());
      if (a.type) accountTypes.add(a.type.toLowerCase());
      totalAccounts++;
    });
  }

  // Score based on variety
  let score = 0;

  // Account type diversity (0–8 pts)
  score += clamp(accountTypes.size * 2, 0, 8);

  // Multiple institutions (0–4 pts)
  score += clamp(institutions.size * 2, 0, 4);

  // Total account count bonus (0–3 pts)
  if (totalAccounts >= 5) score += 3;
  else if (totalAccounts >= 3) score += 2;
  else if (totalAccounts >= 1) score += 1;

  return clamp(score, 0, 15);
}

/**
 * Identity Confidence (0–10 pts)
 * Based on Plaid identity match verification scores.
 */
function calcIdentityScore(identityMatchData: any): number {
  if (!identityMatchData) return 0;

  // Identity match returns scores for name, email, phone, address
  const scores: number[] = [];

  if (identityMatchData.legal_name?.score !== undefined) {
    scores.push(toNum(identityMatchData.legal_name.score));
  }
  if (identityMatchData.email_address?.score !== undefined) {
    scores.push(toNum(identityMatchData.email_address.score));
  }
  if (identityMatchData.phone_number?.score !== undefined) {
    scores.push(toNum(identityMatchData.phone_number.score));
  }
  if (identityMatchData.address?.score !== undefined) {
    scores.push(toNum(identityMatchData.address.score));
  }

  if (scores.length === 0) return 3; // Some credit for having linked bank at all

  // Average of match scores (Plaid returns 0–100 per field)
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  return clamp(Math.round(avgScore / 10), 0, 10);
}

/**
 * Account Health (0–10 pts)
 * Ratio of available balance to current balance.
 * Higher available = healthier financial position.
 */
function calcAccountHealthScore(balanceData: any): number {
  if (!balanceData?.accounts) return 0;

  const checkingSavings = balanceData.accounts.filter((a: any) =>
    ['checking', 'savings'].includes(a.subtype?.toLowerCase())
  );

  if (checkingSavings.length === 0) return 0;

  let totalCurrent = 0;
  let totalAvailable = 0;

  checkingSavings.forEach((a: any) => {
    totalCurrent += toNum(a.balances?.current || 0);
    totalAvailable += toNum(a.balances?.available || a.balances?.current || 0);
  });

  if (totalCurrent <= 0) return 2; // Accounts exist but empty

  // Ratio: available/current — ideally >= 0.8
  const ratio = totalAvailable / totalCurrent;

  if (ratio >= 0.95) return 10;
  if (ratio >= 0.85) return 8;
  if (ratio >= 0.70) return 6;
  if (ratio >= 0.50) return 4;
  return 2;
}

// ── Main Calculator ──

/**
 * Calculate Network Worth Score from Plaid financial data.
 * Returns score 0–100 with breakdown.
 */
export function calculateNWS(input: NWSInput): NWSResult {
  const { balanceData, investmentsData, identityMatchData } = input;

  const breakdown: NWSBreakdown = {
    liquidity: calcLiquidityScore(balanceData),
    investments: calcInvestmentScore(investmentsData),
    assetDepth: calcAssetDepthScore(balanceData, investmentsData),
    diversification: calcDiversificationScore(balanceData, investmentsData),
    identityConfidence: calcIdentityScore(identityMatchData),
    accountHealth: calcAccountHealthScore(balanceData),
  };

  const score = clamp(
    breakdown.liquidity +
    breakdown.investments +
    breakdown.assetDepth +
    breakdown.diversification +
    breakdown.identityConfidence +
    breakdown.accountHealth,
    0,
    100
  );

  return {
    score,
    breakdown,
    grade: getGrade(score),
    label: getLabel(score),
  };
}

/**
 * Calculate NWS from raw GcpBackend user_financial_data row.
 * Convenience wrapper that extracts the right fields.
 */
export function calculateNWSFromDB(financialRow: any): NWSResult {
  if (!financialRow) {
    return {
      score: 0,
      breakdown: { liquidity: 0, investments: 0, assetDepth: 0, diversification: 0, identityConfidence: 0, accountHealth: 0 },
      grade: 'F',
      label: 'No Financial Data',
    };
  }

  return calculateNWS({
    balanceData: financialRow.balances || financialRow.balance_data || null,
    investmentsData: financialRow.investments || financialRow.investments_data || null,
    identityMatchData: financialRow.identity_match || financialRow.identity_match_data || financialRow.identity_match_scores || null,
  });
}
