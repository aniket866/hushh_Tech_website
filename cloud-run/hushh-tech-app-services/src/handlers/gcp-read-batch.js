import { RuntimeError } from "../errors.js";

const PRIVATE_JSON_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
  "content-type": "application/json",
});
const LOCATION_JSON_HEADERS = Object.freeze({
  "cache-control": "public, max-age=86400",
  "content-type": "application/json",
});
const OG_IMAGE_HEADERS = Object.freeze({
  "cache-control": "public, max-age=3600, s-maxage=86400",
  "content-type": "image/svg+xml",
});
const ADMIN_TABS = new Set([
  "needs_attention",
  "completed_onboarding",
  "bank_linked",
  "payment_review",
  "manually_approved",
  "all",
]);
const PROFILE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/;
const VISITOR_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

const PROFILE_SCHEMA = Object.freeze({
  primary_goal: Object.freeze([
    "capital_preservation",
    "steady_income",
    "long_term_growth",
    "aggressive_growth",
    "speculation",
  ]),
  investment_horizon_years: Object.freeze([
    "<3_years",
    "3_5_years",
    "5_10_years",
    ">10_years",
  ]),
  risk_tolerance: Object.freeze([
    "very_low",
    "low",
    "moderate",
    "high",
    "very_high",
  ]),
  liquidity_need: Object.freeze(["low", "medium", "high"]),
  experience_level: Object.freeze(["beginner", "intermediate", "advanced"]),
  typical_ticket_size: Object.freeze([
    "micro_<1m",
    "small_1m_10m",
    "medium_10m_50m",
    "large_>50m",
  ]),
  annual_investing_capacity: Object.freeze([
    "<5m",
    "5m_20m",
    "20m_100m",
    ">100m",
  ]),
  asset_class_preference: Object.freeze([
    "public_equities",
    "mutual_funds_etfs",
    "fixed_income",
    "real_estate",
    "startups_private_equity",
    "crypto_digital_assets",
    "cash_equivalents",
  ]),
  sector_preferences: Object.freeze([
    "technology",
    "consumer_internet",
    "fintech",
    "healthcare",
    "real_estate",
    "energy_climate",
    "industrial",
    "other",
  ]),
  volatility_reaction: Object.freeze([
    "sell_to_avoid_more_loss",
    "hold_and_wait",
    "buy_more_at_lower_prices",
  ]),
  sustainability_preference: Object.freeze([
    "not_important",
    "nice_to_have",
    "important",
    "very_important",
  ]),
  engagement_style: Object.freeze([
    "very_passive_just_updates",
    "collaborative_discuss_key_decisions",
    "hands_on_active_trader",
  ]),
});
const MULTI_PROFILE_FIELDS = new Set([
  "asset_class_preference",
  "sector_preferences",
]);
const SYSTEM_PROMPT = `You pre-fill an investor profile from caller-provided data.
Return JSON only under investor_profile. Include exactly the 12 requested fields.
Each field has value, confidence from 0 to 1, and a short rationale.
Use only the supplied context. Never assert income, wealth, accreditation, or
identity facts. Prefer conservative neutral values when evidence is weak.`;

function json(status, body, headers = PRIVATE_JSON_HEADERS) {
  return { status, headers, body };
}

function publicJsonError(status, body) {
  return { status, headers: { "content-type": "application/json" }, body };
}

function text(status, body, headers) {
  return { status, headers, body: Buffer.from(body, "utf8") };
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function toCents(value) {
  return Math.round(finite(value) * 100);
}

function formatUsdCents(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(finite(value) / 100);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new RuntimeError("HANDLER_ABORTED", "Service unavailable.", 503);
}

function requireFundAdmin(actor) {
  if (
    actor?.kind !== "firebase" ||
    actor?.fundAdmin !== true ||
    typeof actor?.uid !== "string" ||
    !actor.uid
  ) {
    throw new RuntimeError("FUND_ADMIN_REQUIRED", "Access denied.", 403);
  }
  return actor;
}

function parameters(request) {
  return new URLSearchParams(request.route.search);
}

function latestByUser(rows, dateField = "created_at") {
  const output = new Map();
  for (const row of rows) {
    if (!row?.user_id) continue;
    const previous = output.get(row.user_id);
    if (
      !previous ||
      new Date(row[dateField] || 0) > new Date(previous[dateField] || 0)
    ) {
      output.set(row.user_id, row);
    }
  }
  return output;
}

function financialDataStatus({ onboarding, financial, item, products, accounts }) {
  const status = clean(financial?.status).toLowerCase();
  const sync = clean(financial?.plaid_sync_status).toLowerCase();
  const link = clean(onboarding?.financial_link_status).toLowerCase();
  if (status === "complete" || sync === "complete") return "complete";
  if (status === "partial" || sync === "partial") return "partial";
  if (
    financial?.plaid_item_id ||
    item?.plaid_item_id ||
    products.length > 0 ||
    accounts.length > 0
  ) {
    return "linked";
  }
  if (link === "skipped") return "skipped";
  if (link === "pending") return "pending";
  return "missing";
}

const STAGE_ORDER = Object.freeze({
  awaiting_manual_review: 0,
  manual_approved: 1,
  manual_rejected: 2,
  payment_started: 3,
  onboarding_complete: 4,
  bank_linked: 5,
  in_onboarding: 6,
  nda_signed: 7,
  lead: 8,
});

function stageFor({ payment, onboarding, bankLinked, ndaSigned }) {
  const status = clean(payment?.status).toLowerCase();
  if (status === "verified_investor") return "manual_approved";
  if (status === "rejected") return "manual_rejected";
  if (payment?.paid_at || status === "pending_manual_verification") {
    return "awaiting_manual_review";
  }
  if (payment) return "payment_started";
  if (onboarding?.is_completed) return "onboarding_complete";
  if (bankLinked) return "bank_linked";
  if (onboarding && (finite(onboarding.current_step) > 1 || onboarding.is_completed)) {
    return "in_onboarding";
  }
  return ndaSigned ? "nda_signed" : "lead";
}

function missingPieces({
  onboarding,
  payment,
  bankLinked,
  financialStatus,
  ndaSigned,
  kycAvailable,
  kyc,
}) {
  const output = [];
  if (bankLinked && !onboarding) output.push("missing_onboarding_row");
  if (bankLinked && onboarding?.financial_link_status !== "completed") {
    output.push("onboarding_financial_link_status_not_completed");
  }
  if (!bankLinked && financialStatus !== "skipped") output.push("bank_not_linked");
  if (!ndaSigned) output.push("nda_not_signed");
  if (onboarding?.is_completed && !payment) output.push("payment_not_started");
  if (payment && !payment.paid_at) output.push("first_payment_not_paid");
  if (
    payment?.paid_at &&
    !["verified_investor", "rejected"].includes(payment.status)
  ) {
    output.push("awaiting_manual_verification");
  }
  if (kycAvailable && !kyc) output.push("kyc_not_found");
  const gps = clean(onboarding?.gps_country).toLowerCase();
  const residence = clean(onboarding?.residence_country).toLowerCase();
  if (gps && residence && gps !== residence) {
    output.push("current_location_differs_from_residence");
  }
  return [...new Set(output)];
}

function displayName(onboarding, nda, email) {
  const legal = [onboarding?.legal_first_name, onboarding?.legal_last_name]
    .map(clean)
    .filter(Boolean)
    .join(" ");
  if (legal) return legal;
  if (clean(nda?.signer_name)) return clean(nda.signer_name);
  const local = clean(email).split("@", 1)[0].replace(/[._-]+/g, " ").trim();
  return local || "Hushh investor";
}

function computeOverview(data) {
  const paymentByUser = latestByUser(data.paymentRows);
  const ndaByUser = new Map(data.ndaRows.map((row) => [row.user_id, row]));
  const ceoByUser = latestByUser(data.ceoRows);
  const onboardingByUser = new Map(
    data.onboardingRows.map((row) => [row.user_id, row]),
  );
  const financialByUser = new Map(
    data.financialRows.map((row) => [row.user_id, row]),
  );
  const itemByUser = latestByUser(data.itemRows, "updated_at");
  const kycByUser = latestByUser(data.kycRows, "verified_at");
  const emailByUser = new Map(data.userRows.map((row) => [row.id, row.email ?? null]));
  const accountsByItem = new Map();
  for (const row of data.accountRows) {
    if (!row?.plaid_item_id) continue;
    accountsByItem.set(row.plaid_item_id, [
      ...(accountsByItem.get(row.plaid_item_id) ?? []),
      row,
    ]);
  }
  const productsByUser = new Map();
  for (const row of data.productRows) {
    if (!row?.user_id) continue;
    productsByUser.set(row.user_id, [
      ...(productsByUser.get(row.user_id) ?? []),
      row,
    ]);
  }
  const userIds = [...new Set([
    ...paymentByUser.keys(),
    ...ndaByUser.keys(),
    ...ceoByUser.keys(),
    ...onboardingByUser.keys(),
    ...financialByUser.keys(),
    ...itemByUser.keys(),
    ...kycByUser.keys(),
  ])];

  let firstPaymentPaid = 0;
  let pendingReview = 0;
  let verified = 0;
  let rejected = 0;
  let paymentLinkSent = 0;
  let committedCents = 0;
  let approvedCents = 0;
  for (const payment of paymentByUser.values()) {
    paymentLinkSent += 1;
    if (payment.paid_at) {
      firstPaymentPaid += 1;
      committedCents += toCents(payment.commitment_amount);
    }
    if (
      payment.status === "pending_manual_verification" ||
      (payment.paid_at &&
        !["verified_investor", "rejected"].includes(payment.status))
    ) {
      pendingReview += 1;
    }
    if (payment.status === "verified_investor") {
      verified += 1;
      approvedCents += toCents(payment.commitment_amount);
    }
    if (payment.status === "rejected") rejected += 1;
  }
  const collectedCents = data.paidRows.reduce(
    (total, payment) => total + toCents(payment.amount),
    0,
  );
  let bankLinked = 0;
  let financialDataReady = 0;
  let financialDataPartial = 0;
  let onboardingComplete = 0;
  let needsAttention = 0;
  const kycAvailable = !data.sourceWarnings.some(
    (warning) => warning.source === "kyc_attestations",
  );

  const investors = userIds
    .map((uid) => {
      const payment = paymentByUser.get(uid) ?? null;
      const onboarding = onboardingByUser.get(uid) ?? null;
      const nda = ndaByUser.get(uid) ?? null;
      const financial = financialByUser.get(uid) ?? null;
      const item = itemByUser.get(uid) ?? null;
      const plaidItemId = financial?.plaid_item_id || item?.plaid_item_id;
      const accounts = plaidItemId ? accountsByItem.get(plaidItemId) ?? [] : [];
      const products = productsByUser.get(uid) ?? [];
      const kyc = kycByUser.get(uid) ?? null;
      const financialStatus = financialDataStatus({
        onboarding,
        financial,
        item,
        products,
        accounts,
      });
      const linked = ["complete", "partial", "linked"].includes(financialStatus);
      const ndaSignedAt = nda?.signed_at ?? onboarding?.nda_signed_at ?? null;
      const ndaSigned = Boolean(ndaSignedAt);
      const pieces = missingPieces({
        onboarding,
        payment,
        bankLinked: linked,
        financialStatus,
        ndaSigned,
        kycAvailable,
        kyc,
      });
      if (linked) bankLinked += 1;
      if (financialStatus === "complete") financialDataReady += 1;
      if (["partial", "linked"].includes(financialStatus)) financialDataPartial += 1;
      if (onboarding?.is_completed) onboardingComplete += 1;
      if (pieces.length > 0) needsAttention += 1;
      const sources = [];
      if (payment) sources.push("fund_stripe_payment_requests");
      if (data.paidRows.some((row) => row.user_id === uid)) {
        sources.push("fund_stripe_payments");
      }
      if (nda) sources.push("nda_signatures");
      if (onboarding) sources.push("onboarding_data");
      if (ceoByUser.has(uid)) sources.push("ceo_meeting_payments");
      if (financial) sources.push("user_financial_data");
      if (item) sources.push("plaid_items");
      if (accounts.length) sources.push("plaid_accounts");
      if (products.length) sources.push("plaid_product_sync_statuses");
      if (kyc) sources.push("kyc_attestations");
      const email = emailByUser.get(uid) ?? null;
      return {
        userId: uid,
        recipientName: displayName(onboarding, nda, email),
        userEmail: email,
        stage: stageFor({ payment, onboarding, bankLinked: linked, ndaSigned }),
        requestReference: payment?.request_reference ?? null,
        selectedFund: payment?.selected_fund ?? onboarding?.selected_fund ?? null,
        commitmentLabel: payment
          ? formatUsdCents(toCents(payment.commitment_amount))
          : null,
        status: payment?.status ?? null,
        paymentRequestStatus: payment?.status ?? null,
        manualReviewStatus:
          payment?.paid_at &&
          !["verified_investor", "rejected"].includes(payment.status)
            ? "pending_manual_verification"
            : ["verified_investor", "rejected"].includes(payment?.status)
              ? payment.status
              : null,
        manualInvestorStatus: ["verified_investor", "rejected"].includes(
          payment?.status,
        )
          ? payment.status
          : "not_verified",
        paidAt: payment?.paid_at ?? null,
        firstPaymentPaid: Boolean(payment?.paid_at),
        verifiedAt: payment?.verified_at ?? null,
        rejectedAt: payment?.rejected_at ?? null,
        ndaSignedAt,
        ndaSigned,
        meetCeoDone: ceoByUser.has(uid),
        currentStep: onboarding?.current_step ?? null,
        onboardingComplete: Boolean(onboarding?.is_completed),
        financialLinkStatus: onboarding?.financial_link_status ?? null,
        bankLinked: linked,
        institutionName:
          financial?.institution_name || item?.institution_name || null,
        financialDataStatus: financialStatus,
        plaidProductCount: products.length,
        plaidAccountCount: accounts.length,
        kycStatus: kyc?.status ?? (kycAvailable ? "not_found" : "not_configured"),
        riskFlags: Array.isArray(payment?.risk_flags) ? payment.risk_flags : [],
        missingPieces: pieces,
        dataSources: sources.sort(),
      };
    })
    .sort((left, right) => {
      const stage =
        (STAGE_ORDER[left.stage] ?? 9) - (STAGE_ORDER[right.stage] ?? 9);
      if (stage !== 0) return stage;
      const leftAt = new Date(
        left.verifiedAt || left.paidAt || left.ndaSignedAt || 0,
      ).getTime();
      const rightAt = new Date(
        right.verifiedAt || right.paidAt || right.ndaSignedAt || 0,
      ).getTime();
      return rightAt - leftAt;
    });
  return {
    funnel: {
      ndaSigned: ndaByUser.size,
      bankLinked,
      financialDataReady,
      financialDataPartial,
      onboardingComplete,
      paymentLinkSent,
      meetCeoDone: ceoByUser.size,
      firstPaymentPaid,
      pendingReview,
      verified,
      rejected,
      needsAttention,
      totalInvestors: userIds.length,
      money: {
        committed: formatUsdCents(committedCents),
        approved: formatUsdCents(approvedCents),
        collected: formatUsdCents(collectedCents),
      },
    },
    investors,
  };
}

function matchesSearch(investor, query) {
  if (!query) return true;
  return [
    investor.recipientName,
    investor.userEmail,
    investor.requestReference,
    investor.institutionName,
    investor.financialDataStatus,
    investor.kycStatus,
    ...investor.dataSources,
    ...investor.missingPieces,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function matchesTab(investor, tab) {
  if (tab === "needs_attention") return investor.missingPieces.length > 0;
  if (tab === "completed_onboarding") return investor.onboardingComplete;
  if (tab === "bank_linked") return investor.bankLinked;
  if (tab === "payment_review") {
    return Boolean(
      investor.paymentRequestStatus ||
        investor.firstPaymentPaid ||
        investor.manualReviewStatus,
    );
  }
  if (tab === "manually_approved") {
    return investor.manualInvestorStatus === "verified_investor";
  }
  return true;
}

function tabCounts(rows) {
  const counts = {
    needs_attention: 0,
    completed_onboarding: 0,
    bank_linked: 0,
    payment_review: 0,
    manually_approved: 0,
    all: rows.length,
  };
  for (const investor of rows) {
    for (const tab of Object.keys(counts)) {
      if (tab !== "all" && matchesTab(investor, tab)) counts[tab] += 1;
    }
  }
  return counts;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function daysBetween(start, end) {
  return (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000;
}

function weekStart(value) {
  const date = new Date(value);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

function computeAnalytics(data) {
  const paymentByUser = latestByUser(data.paymentRows);
  const ndaByUser = new Map(data.ndaRows.map((row) => [row.user_id, row]));
  const onboardingByUser = new Map(
    data.onboardingRows.map((row) => [row.user_id, row]),
  );
  const ceoByUser = new Set(data.ceoRows.map((row) => row.user_id));
  const financialByUser = new Map(
    data.financialRows.map((row) => [row.user_id, row]),
  );
  const kycByUser = new Map(data.kycRows.map((row) => [row.user_id, row]));
  const entered = new Set([
    ...ndaByUser.keys(),
    ...onboardingByUser.keys(),
    ...paymentByUser.keys(),
  ]);
  const bankLinked = (uid) => {
    const financial = financialByUser.get(uid);
    const status = clean(
      financial?.status || financial?.plaid_sync_status,
    ).toLowerCase();
    return (
      status === "complete" ||
      status === "partial" ||
      status === "linked" ||
      Boolean(financial?.plaid_item_id)
    );
  };
  const stages = [
    { key: "entered", label: "Entered funnel", count: entered.size },
    { key: "nda_signed", label: "NDA signed", count: ndaByUser.size },
    {
      key: "onboarding_complete",
      label: "Onboarding complete",
      count: data.onboardingRows.filter((row) => row.is_completed).length,
    },
    {
      key: "bank_linked",
      label: "Bank linked",
      count: [...entered].filter(bankLinked).length,
    },
    {
      key: "first_paid",
      label: "$1 activated",
      count: [...paymentByUser.values()].filter((row) => row.paid_at).length,
    },
    {
      key: "verified",
      label: "Verified",
      count: [...paymentByUser.values()].filter(
        (row) => row.status === "verified_investor",
      ).length,
    },
  ];
  const top = stages[0].count;
  const funnel = stages.map((stage, index) => {
    const previous = index === 0 ? stage.count : stages[index - 1].count;
    return {
      ...stage,
      conversionFromPrev:
        previous > 0 ? Math.round((stage.count / previous) * 1_000) / 10 : null,
      conversionFromTop:
        top > 0 ? Math.round((stage.count / top) * 1_000) / 10 : null,
    };
  });
  const ndaToOnboarding = [];
  const onboardingToPaid = [];
  const paidToVerified = [];
  for (const uid of entered) {
    const nda = ndaByUser.get(uid);
    const onboarding = onboardingByUser.get(uid);
    const payment = paymentByUser.get(uid);
    for (const [target, start, end] of [
      [ndaToOnboarding, nda?.signed_at, onboarding?.completed_at],
      [onboardingToPaid, onboarding?.completed_at, payment?.paid_at],
      [paidToVerified, payment?.paid_at, payment?.verified_at],
    ]) {
      if (!start || !end) continue;
      const days = daysBetween(start, end);
      if (days >= 0) target.push(days);
    }
  }
  const round = (value) => (value == null ? null : Math.round(value * 10) / 10);
  const weeks = new Map();
  for (const payment of data.paidRows) {
    const timestamp = payment.paid_at || payment.created_at;
    if (!timestamp) continue;
    const key = weekStart(timestamp);
    const current = weeks.get(key) ?? { collectedCents: 0, payments: 0 };
    current.collectedCents += finite(payment.amount_cents);
    current.payments += 1;
    weeks.set(key, current);
  }
  const capitalWeekly = [...weeks.entries()]
    .map(([start, value]) => ({
      weekStart: start,
      collected: formatUsdCents(value.collectedCents),
      collectedCents: value.collectedCents,
      payments: value.payments,
    }))
    .sort((left, right) => left.weekStart.localeCompare(right.weekStart))
    .slice(-16);
  const funds = new Map();
  const shareClasses = { a: 0, b: 0, c: 0 };
  let committedCents = 0;
  let approvedCents = 0;
  for (const payment of paymentByUser.values()) {
    const fund = payment.selected_fund || "unspecified";
    const current = funds.get(fund) ?? {
      investors: 0,
      committedCents: 0,
      approvedCents: 0,
    };
    current.investors += 1;
    if (payment.paid_at) {
      const cents = toCents(payment.commitment_amount);
      current.committedCents += cents;
      committedCents += cents;
      shareClasses.a += finite(payment.class_a_units);
      shareClasses.b += finite(payment.class_b_units);
      shareClasses.c += finite(payment.class_c_units);
    }
    if (payment.status === "verified_investor") {
      const cents = toCents(payment.commitment_amount);
      current.approvedCents += cents;
      approvedCents += cents;
    }
    funds.set(fund, current);
  }
  const byFund = [...funds.entries()]
    .map(([fund, value]) => ({
      fund,
      label: fund === "hushh_fund_a" ? "Hushh Fund A" : fund.replace(/_/g, " "),
      investors: value.investors,
      committed: formatUsdCents(value.committedCents),
      approved: formatUsdCents(value.approvedCents),
      committedCents: value.committedCents,
      approvedCents: value.approvedCents,
    }))
    .sort((left, right) => right.committedCents - left.committedCents);
  let collectedCents = 0;
  let recurringCollectedCents = 0;
  for (const payment of data.paidRows) {
    collectedCents += finite(payment.amount_cents);
    if (payment.payment_kind === "recurring_invoice") {
      recurringCollectedCents += finite(payment.amount_cents);
    }
  }
  let recurringMonthlyCents = 0;
  let recurringCount = 0;
  for (const subscription of data.subscriptionRows) {
    if (clean(subscription.status).toLowerCase() === "cancelled") continue;
    const amount = toCents(subscription.recurring_amount);
    if (amount > 0) {
      recurringMonthlyCents += amount;
      recurringCount += 1;
    }
  }
  const riskBands = { LOW: 0, MEDIUM: 0, HIGH: 0, unknown: 0 };
  for (const kyc of kycByUser.values()) {
    const band = clean(kyc.risk_band).toUpperCase();
    if (["LOW", "MEDIUM", "HIGH"].includes(band)) riskBands[band] += 1;
    else riskBands.unknown += 1;
  }
  return {
    funnel,
    timeInStageDays: {
      ndaToOnboarding: round(median(ndaToOnboarding)),
      onboardingToPaid: round(median(onboardingToPaid)),
      paidToVerified: round(median(paidToVerified)),
    },
    capitalWeekly,
    byFund,
    byShareClass: shareClasses,
    totals: {
      committed: formatUsdCents(committedCents),
      approved: formatUsdCents(approvedCents),
      collected: formatUsdCents(collectedCents),
      aum: formatUsdCents(approvedCents),
      recurringMonthly: formatUsdCents(recurringMonthlyCents),
      recurringCount,
      recurringCollected: formatUsdCents(recurringCollectedCents),
    },
    kyc: {
      covered: kycByUser.size,
      coveragePct:
        entered.size > 0
          ? Math.round((kycByUser.size / entered.size) * 1_000) / 10
          : null,
      riskBands,
    },
    meetCeoDone: ceoByUser.size,
    totalInvestors: entered.size,
  };
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function label(value, fallback) {
  return clean(value || fallback)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ogImage(profile) {
  const investor = profile.investor_profile ?? {};
  const name = escapeXml(profile.name || "Anonymous");
  const age = escapeXml(profile.age || "N/A");
  const organisation = clean(profile.organisation)
    ? ` • ${escapeXml(profile.organisation)}`
    : "";
  const risk = escapeXml(label(investor.risk_tolerance?.value, "moderate"));
  const goal = escapeXml(label(investor.primary_goal?.value, "growth"));
  const experience = escapeXml(
    label(investor.experience_level?.value, "intermediate"),
  );
  const slug = escapeXml(profile.slug);
  return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#667eea"/><stop offset="100%" stop-color="#764ba2"/></linearGradient></defs>
<rect width="1200" height="630" fill="url(#bg)"/><rect x="80" y="80" width="1040" height="470" rx="20" fill="#ffffff" fill-opacity="0.12" stroke="#ffffff" stroke-opacity="0.2" stroke-width="2"/>
<text x="120" y="140" font-family="Arial,sans-serif" font-size="32" font-weight="bold" fill="#fff">Hushh</text><text x="120" y="175" font-family="Arial,sans-serif" font-size="18" fill="#fff" fill-opacity="0.8">Verified Investor Profile</text>
<text x="120" y="260" font-family="Arial,sans-serif" font-size="56" font-weight="bold" fill="#fff">${name}</text><text x="120" y="310" font-family="Arial,sans-serif" font-size="24" fill="#fff" fill-opacity="0.9">Age ${age}${organisation}</text>
<text x="120" y="405" font-family="Arial,sans-serif" font-size="18" fill="#fff">Risk: ${risk}</text><text x="380" y="405" font-family="Arial,sans-serif" font-size="18" fill="#fff">Goal: ${goal}</text><text x="680" y="405" font-family="Arial,sans-serif" font-size="18" fill="#fff">Experience: ${experience}</text>
<text x="120" y="510" font-family="Arial,sans-serif" font-size="20" fill="#fff" fill-opacity="0.7">hushhtech.com/investor/${slug}</text></svg>`;
}

function profilePrompt(input, context) {
  const schema = Object.fromEntries(
    Object.entries(PROFILE_SCHEMA).map(([field, options]) => [field, { options }]),
  );
  return JSON.stringify({
    raw_input: {
      name: input.name,
      email: input.email,
      age: input.age,
      phone_country_code: input.phone_country_code,
      phone_number: input.phone_number,
      organisation: input.organisation || null,
    },
    derived_context: context,
    profile_schema: schema,
  });
}

function profileFromVertex(text) {
  const withoutFences = String(text)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  const parsed = JSON.parse(
    start >= 0 && end > start ? withoutFences.slice(start, end + 1) : withoutFences,
  );
  const input = parsed.investor_profile ?? parsed;
  const output = {};
  for (const [field, options] of Object.entries(PROFILE_SCHEMA)) {
    const candidate = input?.[field];
    const values = MULTI_PROFILE_FIELDS.has(field)
      ? candidate?.value
      : [candidate?.value];
    if (
      !candidate ||
      !Array.isArray(values) ||
      (MULTI_PROFILE_FIELDS.has(field) &&
        (values.length < 2 || values.length > 4)) ||
      values.some((value) => !options.includes(value)) ||
      !Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1 ||
      !clean(candidate.rationale) ||
      clean(candidate.rationale).length > 500
    ) {
      throw new Error(`Invalid investor profile field: ${field}`);
    }
    output[field] = {
      value: MULTI_PROFILE_FIELDS.has(field) ? [...values] : values[0],
      confidence: candidate.confidence,
      rationale: clean(candidate.rationale),
    };
  }
  return output;
}

function internalError() {
  return json(500, { error: "Internal server error" });
}

export function createGcpReadBatchHandlers({
  dataAdapter,
  locationCatalog = null,
  vertexProfile = null,
  now = () => new Date(),
} = {}) {
  for (const method of ["chatAccess", "publicInvestorProfile", "overview", "analytics"]) {
    if (typeof dataAdapter?.[method] !== "function") {
      throw new Error(`GCP read batch data adapter is missing ${method}.`);
    }
  }
  const handlers = {
    async "get-locations"({ request, signal }) {
      if (locationCatalog?.configured !== true) {
        return publicJsonError(503, { error: "Location catalog is unavailable" });
      }
      const query = parameters(request);
      const type = query.get("type");
      const country = clean(query.get("country")).toUpperCase();
      const state = clean(query.get("state")).toUpperCase();
      try {
        let data;
        if (type === "countries") {
          data = await locationCatalog.countries(signal);
        } else if (type === "states") {
          if (!country) {
            return publicJsonError(400, {
              error: "country parameter is required for states",
            });
          }
          data = await locationCatalog.states(country, signal);
        } else if (type === "cities") {
          if (!country || !state) {
            return publicJsonError(400, {
              error: "country and state parameters are required for cities",
            });
          }
          data = await locationCatalog.cities(country, state, signal);
        } else {
          return publicJsonError(400, {
            error: "Invalid type parameter. Use: countries, states, or cities",
          });
        }
        throwIfAborted(signal);
        return json(200, { data }, LOCATION_JSON_HEADERS);
      } catch {
        return publicJsonError(503, { error: "Location catalog is unavailable" });
      }
    },

    async "chat-check-access"({ request, database, signal }) {
      const visitorId = clean(request.body?.visitorId);
      const slug = clean(request.body?.slug).toLowerCase();
      if (!VISITOR_ID_PATTERN.test(visitorId) || !PROFILE_SLUG_PATTERN.test(slug)) {
        return json(400, { error: "Missing visitorId or slug" });
      }
      try {
        const current = now();
        const token = await dataAdapter.chatAccess({
          database,
          visitorId,
          slug,
          now: current,
          signal,
        });
        if (token.access_type === "paid" && token.expires_at) {
          const expiresAt = Date.parse(token.expires_at);
          if (Number.isFinite(expiresAt) && current.getTime() > expiresAt) {
            return json(200, {
              canChat: false,
              needsPayment: true,
              accessType: "expired",
              messagesRemaining: 0,
              message:
                "Your 30-minute access has expired. Please pay again to continue.",
            });
          }
        }
        if (token.access_type === "free") {
          const remaining = finite(token.messages_limit) - finite(token.messages_sent_count);
          if (remaining <= 0) {
            return json(200, {
              canChat: false,
              needsPayment: true,
              accessType: "free",
              messagesRemaining: 0,
              message:
                "You have used all 3 free messages. Pay $1 for 30 minutes unlimited access.",
            });
          }
          return json(200, {
            canChat: true,
            needsPayment: false,
            accessType: "free",
            messagesRemaining: remaining,
          });
        }
        if (token.access_type === "paid") {
          if (finite(token.hourly_message_count) >= 50) {
            return json(200, {
              canChat: false,
              needsPayment: false,
              accessType: "paid",
              messagesRemaining: "rate_limited",
              message:
                "Rate limit reached (50 messages/hour). Please wait before sending more messages.",
            });
          }
          const expiresAt = Date.parse(token.expires_at);
          const minutes = Number.isFinite(expiresAt)
            ? Math.max(0, Math.floor((expiresAt - current.getTime()) / 60_000))
            : 0;
          return json(200, {
            canChat: true,
            needsPayment: false,
            accessType: "paid",
            messagesRemaining: "unlimited",
            timeRemaining: `${minutes} minutes`,
          });
        }
        return json(200, {
          canChat: false,
          needsPayment: true,
          accessType: "unknown",
          messagesRemaining: 0,
        });
      } catch {
        return internalError();
      }
    },

    async "investor-og-image"({ request, database, signal }) {
      const slug = clean(parameters(request).get("slug")).toLowerCase();
      if (!PROFILE_SLUG_PATTERN.test(slug)) {
        return text(400, "Missing slug parameter", {
          "content-type": "text/plain",
        });
      }
      try {
        const profile = await dataAdapter.publicInvestorProfile({
          database,
          slug,
          signal,
        });
        if (!profile) {
          return text(404, "Profile not found", {
            "content-type": "text/plain",
          });
        }
        return text(200, ogImage(profile), OG_IMAGE_HEADERS);
      } catch {
        return text(500, "Internal server error", {
          "content-type": "text/plain",
        });
      }
    },

    async "fund-payment-admin-overview"(context) {
      try {
        const actor = requireFundAdmin(context.actor);
        const data = await dataAdapter.overview({
          database: context.database,
          actor,
          signal: context.signal,
        });
        const result = computeOverview(data);
        return json(200, {
          success: true,
          funnel: result.funnel,
          sourceWarnings: data.sourceWarnings,
          investors: result.investors,
        });
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        return internalError();
      }
    },

    async "fund-payment-admin-overview-metrics"(context) {
      try {
        const actor = requireFundAdmin(context.actor);
        const data = await dataAdapter.overview({
          database: context.database,
          actor,
          signal: context.signal,
        });
        return json(200, {
          success: true,
          funnel: computeOverview(data).funnel,
          sourceWarnings: data.sourceWarnings,
        });
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        return internalError();
      }
    },

    async "fund-payment-admin-overview-list"(context) {
      try {
        const actor = requireFundAdmin(context.actor);
        const rawPage = Number(context.request.body?.page);
        const rawSize = Number(context.request.body?.pageSize);
        const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
        const pageSize = Number.isFinite(rawSize)
          ? Math.min(100, Math.max(1, Math.floor(rawSize)))
          : 25;
        const requestedTab = clean(context.request.body?.tab);
        const tab = ADMIN_TABS.has(requestedTab) ? requestedTab : "all";
        const search = clean(context.request.body?.search).toLowerCase();
        if (search.length > 200) {
          return json(400, { error: "Invalid search" });
        }
        const data = await dataAdapter.overview({
          database: context.database,
          actor,
          targetReference: `list:${tab}`,
          signal: context.signal,
        });
        const searched = computeOverview(data).investors.filter((row) =>
          matchesSearch(row, search),
        );
        const counts = tabCounts(searched);
        const tabRows = searched.filter((row) => matchesTab(row, tab));
        const offset = (page - 1) * pageSize;
        return json(200, {
          success: true,
          investors: tabRows.slice(offset, offset + pageSize),
          page,
          pageSize,
          total: tabRows.length,
          counts,
          sourceWarnings: data.sourceWarnings,
        });
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        return internalError();
      }
    },

    async "fund-payment-admin-analytics"(context) {
      try {
        const actor = requireFundAdmin(context.actor);
        const data = await dataAdapter.analytics({
          database: context.database,
          actor,
          signal: context.signal,
        });
        return json(200, { success: true, ...computeAnalytics(data) });
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        return internalError();
      }
    },

    async "generate-investor-profile"({ actor, request, signal }) {
      if (actor?.kind !== "firebase" || !actor.uid) {
        throw new RuntimeError("UNAUTHENTICATED", "Sign-in required.", 401);
      }
      if (
        !request.body?.input ||
        typeof request.body.input !== "object" ||
        Array.isArray(request.body.input) ||
        !request.body?.context ||
        typeof request.body.context !== "object" ||
        Array.isArray(request.body.context)
      ) {
        return json(400, { success: false, error: "Missing input or context" });
      }
      if (vertexProfile?.configured !== true) {
        return json(503, {
          success: false,
          error: "Investor profile intelligence is unavailable",
        });
      }
      try {
        const generated = await vertexProfile.generate({
          systemInstruction: SYSTEM_PROMPT,
          prompt: profilePrompt(request.body.input, request.body.context),
          signal,
        });
        throwIfAborted(signal);
        return json(200, {
          success: true,
          profile: profileFromVertex(generated),
        });
      } catch {
        return json(502, {
          success: false,
          error: "Investor profile intelligence is temporarily unavailable",
        });
      }
    },
  };
  return Object.freeze(handlers);
}

export const GCP_READ_BATCH_SLUGS = Object.freeze([
  "chat-check-access",
  "fund-payment-admin-analytics",
  "fund-payment-admin-overview",
  "fund-payment-admin-overview-list",
  "fund-payment-admin-overview-metrics",
  "generate-investor-profile",
  "get-locations",
  "investor-og-image",
]);

export const GCP_READ_BATCH_PROFILE_SCHEMA = PROFILE_SCHEMA;
