import { DerivedContext, InvestorProfileInput } from "../../types/investorProfile";
import { parsePhoneNumber } from "libphonenumber-js";
import config from "../../resources/config/config";
import { calculateNWSFromDB } from "../networkScore/calculateNWS";

// Static country → currency mapping
const COUNTRY_CURRENCY_MAP: Record<string, string> = {
  US: "USD", CA: "CAD", GB: "GBP", IN: "INR", AE: "AED",
  SG: "SGD", AU: "AUD", NZ: "NZD", JP: "JPY", CN: "CNY",
  FR: "EUR", DE: "EUR", IT: "EUR", ES: "EUR", NL: "EUR",
  CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", BR: "BRL",
  MX: "MXN", AR: "ARS", ZA: "ZAR", KR: "KRW", TW: "TWD",
  HK: "HKD", MY: "MYR", TH: "THB", PH: "PHP", ID: "IDR",
};

// Life stage buckets based on age
function getLifeStage(age: number): string {
  if (age < 25) return "early_career";
  if (age < 35) return "young_professional";
  if (age < 50) return "mid_career";
  if (age < 60) return "late_career";
  return "retired_or_near_retirement";
}

// Email domain analysis
function analyzeEmail(email: string): {
  type: "personal" | "corporate";
  domain?: string;
} {
  const domain = email.split("@")[1]?.toLowerCase();
  
  if (!domain) {
    return { type: "personal" };
  }
  
  const personalDomains = [
    "gmail.com", "yahoo.com", "outlook.com", "hotmail.com",
    "icloud.com", "protonmail.com", "mail.com", "aol.com",
    "live.com", "msn.com", "yandex.com", "zoho.com"
  ];
  
  if (personalDomains.includes(domain)) {
    return { type: "personal" };
  }
  
  return { type: "corporate", domain };
}

// Infer company info from known domains (simple heuristic)
function inferCompanyInfo(domain?: string): {
  industry?: string;
  size_bucket?: string;
} {
  if (!domain) return {};
  
  const domainLower = domain.toLowerCase();
  
  // Known tech companies
  const bigTechDomains = ["google.com", "meta.com", "facebook.com", "amazon.com", "apple.com", "microsoft.com", "netflix.com"];
  const fintechDomains = ["stripe.com", "paypal.com", "square.com", "coinbase.com", "robinhood.com", "plaid.com"];
  const consultingDomains = ["mckinsey.com", "bcg.com", "bain.com", "deloitte.com", "ey.com", "pwc.com", "kpmg.com"];
  
  if (bigTechDomains.some(d => domainLower.includes(d))) {
    return { industry: "bigtech", size_bucket: "enterprise_250_plus" };
  }
  
  if (fintechDomains.some(d => domainLower.includes(d))) {
    return { industry: "fintech_payments", size_bucket: "enterprise_250_plus" };
  }
  
  if (consultingDomains.some(d => domainLower.includes(d))) {
    return { industry: "consulting", size_bucket: "enterprise_250_plus" };
  }
  
  // Default for corporate emails
  return { industry: "corporate", size_bucket: "unknown" };
}

// Infer org type from organisation name
function inferOrgType(organisation?: string, emailType?: "personal" | "corporate"): string | undefined {
  if (!organisation) {
    return emailType === "corporate" ? "corporate" : undefined;
  }
  
  const orgLower = organisation.toLowerCase();
  
  if (orgLower.includes("university") || orgLower.includes("college") || orgLower.includes("student")) {
    return "student";
  }
  
  if (orgLower.includes("startup")) {
    return "startup_employee";
  }
  
  const bigTechKeywords = ["google", "meta", "facebook", "amazon", "apple", "microsoft", "stripe", "paypal"];
  if (bigTechKeywords.some(keyword => orgLower.includes(keyword))) {
    return "bigtech_finance";
  }
  
  if (orgLower.includes("government") || orgLower.includes("public sector")) {
    return "public_sector";
  }
  
  if (orgLower.includes("founder") || orgLower.includes("ceo") || orgLower.includes("co-founder")) {
    return "founder";
  }
  
  return "corporate";
}

/**
 * Enriches user input with derived context
 * - Phone number → Country, Region, Currency
 * - Email → Personal/Corporate, Company domain
 * - Age → Life stage bucket
 * - Organisation → Org type inference
 */
export async function enrichContext(
  input: InvestorProfileInput
): Promise<DerivedContext> {
  // Default values
  let country = "US";
  let region = "NA";
  let currency = "USD";
  
  // Parse phone number to get country
  try {
    const fullPhone = input.phone_country_code.startsWith("+")
      ? `${input.phone_country_code}${input.phone_number}`
      : `+${input.phone_country_code}${input.phone_number}`;
    
    const phoneNumber = parsePhoneNumber(fullPhone);
    
    if (phoneNumber && phoneNumber.country) {
      country = phoneNumber.country;
      currency = COUNTRY_CURRENCY_MAP[country] || "USD";
      
      // Map country to region
      if (["US", "CA"].includes(country)) {
        region = "NA";
      } else if (["GB", "FR", "DE", "IT", "ES", "NL", "CH", "SE", "NO", "DK"].includes(country)) {
        region = "EU";
      } else if (["IN", "CN", "JP", "SG", "AU", "NZ", "KR", "TW", "HK", "MY", "TH", "PH", "ID"].includes(country)) {
        region = "APAC";
      } else if (["AE", "SA"].includes(country)) {
        region = "MENA";
      } else if (["BR", "MX", "AR"].includes(country)) {
        region = "LATAM";
      } else if (["ZA"].includes(country)) {
        region = "AFRICA";
      } else {
        region = "OTHER";
      }
    }
  } catch (error) {
    console.warn("Phone parsing failed, using defaults:", error);
  }
  
  // Analyze email
  const emailInfo = analyzeEmail(input.email);
  
  // Get company info if corporate email
  const companyInfo = emailInfo.type === "corporate" 
    ? inferCompanyInfo(emailInfo.domain) 
    : {};
  
  // Life stage from age
  const life_stage = getLifeStage(input.age);
  
  // Org type inference
  const org_type = inferOrgType(input.organisation, emailInfo.type);
  
  // Build complete derived context
  const context: DerivedContext = {
    country,
    region,
    currency,
    email_type: emailInfo.type,
    life_stage,
  };
  
  // Add optional fields if available
  if (emailInfo.domain) {
    context.company_domain = emailInfo.domain;
  }
  
  if (companyInfo.industry) {
    context.company_industry = companyInfo.industry;
  }
  
  if (companyInfo.size_bucket) {
    context.company_size_bucket = companyInfo.size_bucket;
  }
  
  if (org_type) {
    context.org_type = org_type;
  }
  
  return context;
}

/** Plaid financial context for AI profile intelligence */
export interface PlaidFinancialContext {
  nws_score: number;
  nws_tier: string;
  total_cash_balance: number;
  total_investment_value: number;
  num_accounts: number;
  account_types: string[];
  primary_institution: string | null;
  address_city: string | null;
  address_state: string | null;
  address_country: string | null;
  identity_verification_score: number | null;
}

/**
 * Fetches Plaid financial data + calculates NWS score.
 * Returns null if user has no Plaid data linked.
 */
export async function enrichWithPlaidData(userId: string): Promise<PlaidFinancialContext | null> {
  if (!config.gcpBackendClient) return null;

  try {
    const { data: fin } = await config.gcpBackendClient
      .from("user_financial_data")
      .select("balances, investments, identity_data, identity_match, identity_match_scores, institution_name")
      .eq("user_id", userId)
      .maybeSingle();

    if (!fin || !fin.balances) return null;

    // Calculate NWS score from Plaid data
    const nwsResult = calculateNWSFromDB(fin);

    // Extract balances summary
    const accounts = fin.balances?.accounts || [];
    let totalCash = 0;
    const accountTypes: string[] = [];

    for (const acct of accounts) {
      const bal = acct?.balances?.current || acct?.balances?.available || 0;
      totalCash += bal;
      if (acct?.subtype && !accountTypes.includes(acct.subtype)) {
        accountTypes.push(acct.subtype);
      }
    }

    // Extract investment value
    const holdings = fin.investments?.holdings || [];
    let totalInvest = 0;
    for (const h of holdings) {
      totalInvest += h?.institution_value || 0;
    }

    // Extract address from identity data
    const addresses = fin.identity_data?.accounts?.[0]?.owners?.[0]?.addresses || [];
    const primaryAddr = addresses[0]?.data || {};

    // Identity verification score
    const idMatch = fin.identity_match || fin.identity_match_scores;
    const idScore = idMatch
      ? Math.round(((idMatch.legal_name?.score || 0) + (idMatch.email_address?.score || 0) + (idMatch.phone_number?.score || 0) + (idMatch.address?.score || 0)) / 4)
      : null;

    // NWS tier
    const score = nwsResult.score;
    const tier = score >= 80 ? "Elite" : score >= 60 ? "Strong" : score >= 40 ? "Moderate" : "Building";

    return {
      nws_score: score,
      nws_tier: tier,
      total_cash_balance: Math.round(totalCash),
      total_investment_value: Math.round(totalInvest),
      num_accounts: accounts.length,
      account_types: accountTypes,
      primary_institution: fin.institution_name || null,
      address_city: primaryAddr.city || null,
      address_state: primaryAddr.region || null,
      address_country: primaryAddr.country || null,
      identity_verification_score: idScore,
    };
  } catch (err) {
    console.error("enrichWithPlaidData failed:", err);
    return null;
  }
}
