import { createHash } from "node:crypto";

import { RuntimeError } from "../errors.js";

const GCS_DOWNLOAD_ORIGIN = "https://storage.googleapis.com";
const VERTEX_LOCATION = "us-central1";
const VERTEX_MODEL = "gemini-2.5-flash";
const ALLOWED_PROJECTS = new Set(["hushh-tech-uat", "hushh-tech-prod"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const GCS_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const LOCATION_CODE_PATTERN = /^[A-Z0-9-]{1,8}$/;
const MAX_CATALOG_BYTES = 25 * 1024 * 1024;
const ADMIN_LIST_TABS = new Set([
  "needs_attention",
  "completed_onboarding",
  "bank_linked",
  "payment_review",
  "manually_approved",
  "all",
]);

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new RuntimeError("HANDLER_ABORTED", "Service unavailable.", 503);
}

async function readBoundedResponseBody(response, signal) {
  const reader = response?.body?.getReader?.();
  if (!reader) throw new Error("Location catalog response body is unavailable.");
  let cancelled = false;
  let complete = false;
  const cancel = async (reason) => {
    if (cancelled || complete) return;
    cancelled = true;
    try {
      await reader.cancel(reason);
    } catch {
      // Preserve the original integrity/abort failure.
    }
  };
  try {
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CATALOG_BYTES) {
      await cancel("catalog exceeds byte limit");
      throw new Error("Location catalog integrity check failed.");
    }
    const chunks = [];
    let total = 0;
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new Error("Location catalog response body is invalid.");
      }
      if (value.byteLength > MAX_CATALOG_BYTES - total) {
        await cancel("catalog exceeds byte limit");
        throw new Error("Location catalog integrity check failed.");
      }
      total += value.byteLength;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await cancel(error);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled stream may already have released its lock.
    }
  }
}

function requireDatabase(database) {
  if (!database || typeof database.transaction !== "function") {
    throw new RuntimeError("DATABASE_UNAVAILABLE", "Database unavailable.", 503);
  }
  return database;
}

function requireFundAdminActor(actor) {
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

async function rows(client, text, values = []) {
  const result = await client.query(text, values);
  if (!result || !Array.isArray(result.rows)) {
    throw new RuntimeError("DATABASE_UNAVAILABLE", "Database unavailable.", 503);
  }
  return result.rows;
}

async function optionalRows(client, savepoint, table, text, warnings) {
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await rows(client, text);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    warnings.push({
      source: table,
      code: "SOURCE_UNAVAILABLE",
      message: "Optional source is unavailable",
    });
    return [];
  }
}

async function bestEffortAdminAudit(client, actor, targetReference) {
  await client.query("SAVEPOINT admin_audit_write");
  try {
    await client.query(
      `INSERT INTO public.fund_admin_access_log
         (actor_user_id, actor_email, action, target_reference, metadata,
          ip_address, user_agent)
       VALUES ($1, $2, 'view_overview', $3, '{}'::jsonb, NULL, NULL)`,
      [actor.uid, actor.email ?? null, targetReference ?? null],
    );
    await client.query("RELEASE SAVEPOINT admin_audit_write");
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT admin_audit_write");
    await client.query("RELEASE SAVEPOINT admin_audit_write");
  }
}

function adminListQuery(includeKyc) {
  const kycCandidate = includeKyc
    ? "UNION SELECT user_id FROM public.kyc_attestations WHERE user_id IS NOT NULL"
    : "";
  const kycCte = includeKyc
    ? `, latest_kyc AS (
         SELECT DISTINCT ON (user_id) user_id, status, risk_band, verified_at
           FROM public.kyc_attestations
          WHERE user_id IS NOT NULL
          ORDER BY user_id, verified_at DESC NULLS LAST
       )`
    : "";
  const kycJoin = includeKyc
    ? "LEFT JOIN latest_kyc kyc ON kyc.user_id = candidates.user_id"
    : "";
  const kycStatus = includeKyc
    ? "COALESCE(kyc.status, 'not_found')"
    : "'not_configured'";
  const kycMissingPiece = includeKyc
    ? "CASE WHEN NOT has_kyc_row THEN 'kyc_not_found' END"
    : "NULL";
  const kycSource = includeKyc
    ? "CASE WHEN has_kyc_row THEN 'kyc_attestations' END"
    : "NULL";

  return `WITH candidate_users AS (
      SELECT user_id FROM public.fund_stripe_payment_requests WHERE user_id IS NOT NULL
      UNION SELECT user_id FROM public.nda_signatures WHERE user_id IS NOT NULL
      UNION SELECT user_id FROM public.ceo_meeting_payments WHERE user_id IS NOT NULL
      UNION SELECT user_id FROM public.onboarding_data WHERE user_id IS NOT NULL
      UNION SELECT user_id FROM public.user_financial_data WHERE user_id IS NOT NULL
      UNION SELECT user_id FROM public.plaid_items WHERE user_id IS NOT NULL
      ${kycCandidate}
    ), latest_payment AS (
      SELECT DISTINCT ON (user_id) user_id, request_reference, selected_fund,
             status, commitment_amount, risk_flags, paid_at, verified_at,
             rejected_at, created_at
        FROM public.fund_stripe_payment_requests
       WHERE user_id IS NOT NULL
       ORDER BY user_id, created_at DESC NULLS LAST
    ), latest_nda AS (
      SELECT DISTINCT ON (user_id) user_id, signer_name, signed_at
        FROM public.nda_signatures
       WHERE user_id IS NOT NULL AND signed_at IS NOT NULL
       ORDER BY user_id, signed_at DESC
    ), latest_ceo AS (
      SELECT DISTINCT ON (user_id) user_id, created_at
        FROM public.ceo_meeting_payments
       WHERE user_id IS NOT NULL AND payment_status = 'completed'
       ORDER BY user_id, created_at DESC NULLS LAST
    ), latest_onboarding AS (
      SELECT DISTINCT ON (user_id) user_id, legal_first_name, legal_last_name,
             current_step, is_completed, financial_link_status, nda_signed_at,
             selected_fund, updated_at
        FROM public.onboarding_data
       WHERE user_id IS NOT NULL
       ORDER BY user_id, updated_at DESC NULLS LAST
    ), latest_financial AS (
      SELECT DISTINCT ON (user_id) user_id, institution_name, status,
             plaid_sync_status, plaid_item_id, updated_at
        FROM public.user_financial_data
       WHERE user_id IS NOT NULL
       ORDER BY user_id, updated_at DESC NULLS LAST
    ), latest_item AS (
      SELECT DISTINCT ON (user_id) user_id, plaid_item_id, institution_name,
             status, updated_at
        FROM public.plaid_items
       WHERE user_id IS NOT NULL
       ORDER BY user_id, updated_at DESC NULLS LAST
    ), paid_users AS (
      SELECT user_id FROM public.fund_stripe_payments
       WHERE user_id IS NOT NULL AND status = 'succeeded'
       GROUP BY user_id
    ), product_counts AS (
      SELECT user_id, count(*)::integer AS product_count
        FROM public.plaid_product_sync_statuses
       WHERE user_id IS NOT NULL
       GROUP BY user_id
    )${kycCte}, base AS (
      SELECT candidates.user_id,
             users.email,
             payment.request_reference,
             COALESCE(payment.selected_fund, onboarding.selected_fund) AS selected_fund,
             payment.status AS payment_status,
             payment.commitment_amount,
             payment.risk_flags,
             payment.paid_at,
             payment.verified_at,
             payment.rejected_at,
             nda.signer_name,
             COALESCE(nda.signed_at, onboarding.nda_signed_at) AS nda_signed_at,
             (ceo.user_id IS NOT NULL) AS meet_ceo_done,
             onboarding.legal_first_name,
             onboarding.legal_last_name,
             onboarding.current_step,
             COALESCE(onboarding.is_completed, false) AS onboarding_complete,
             onboarding.financial_link_status,
             COALESCE(financial.institution_name, item.institution_name) AS institution_name,
             CASE
               WHEN lower(COALESCE(financial.status, '')) = 'complete'
                 OR lower(COALESCE(financial.plaid_sync_status, '')) = 'complete' THEN 'complete'
               WHEN lower(COALESCE(financial.status, '')) = 'partial'
                 OR lower(COALESCE(financial.plaid_sync_status, '')) = 'partial' THEN 'partial'
               WHEN financial.plaid_item_id IS NOT NULL OR item.plaid_item_id IS NOT NULL
                 OR COALESCE(products.product_count, 0) > 0
                 OR COALESCE(accounts.account_count, 0) > 0 THEN 'linked'
               WHEN lower(COALESCE(onboarding.financial_link_status, '')) = 'skipped' THEN 'skipped'
               WHEN lower(COALESCE(onboarding.financial_link_status, '')) = 'pending' THEN 'pending'
               ELSE 'missing'
             END AS financial_data_status,
             COALESCE(products.product_count, 0) AS plaid_product_count,
             COALESCE(accounts.account_count, 0) AS plaid_account_count,
             ${kycStatus} AS kyc_status,
             (payment.user_id IS NOT NULL) AS has_payment_request,
             (paid.user_id IS NOT NULL) AS has_succeeded_payment,
             (nda.user_id IS NOT NULL) AS has_nda_row,
             (onboarding.user_id IS NOT NULL) AS has_onboarding_row,
             (financial.user_id IS NOT NULL) AS has_financial_row,
             (item.user_id IS NOT NULL) AS has_item_row,
             (COALESCE(accounts.account_count, 0) > 0) AS has_account_rows,
             (COALESCE(products.product_count, 0) > 0) AS has_product_rows,
             ${includeKyc ? "(kyc.user_id IS NOT NULL)" : "false"} AS has_kyc_row
        FROM candidate_users candidates
        LEFT JOIN latest_payment payment ON payment.user_id = candidates.user_id
        LEFT JOIN latest_nda nda ON nda.user_id = candidates.user_id
        LEFT JOIN latest_ceo ceo ON ceo.user_id = candidates.user_id
        LEFT JOIN latest_onboarding onboarding ON onboarding.user_id = candidates.user_id
        LEFT JOIN latest_financial financial ON financial.user_id = candidates.user_id
        LEFT JOIN latest_item item ON item.user_id = candidates.user_id
        LEFT JOIN paid_users paid ON paid.user_id = candidates.user_id
        LEFT JOIN product_counts products ON products.user_id = candidates.user_id
        LEFT JOIN LATERAL (
          SELECT count(*)::integer AS account_count
            FROM public.plaid_accounts account
           WHERE account.plaid_item_id = COALESCE(financial.plaid_item_id, item.plaid_item_id)
        ) accounts ON true
        LEFT JOIN public.users users ON users.id = candidates.user_id
        ${kycJoin}
    ), derived AS (
      SELECT user_id, email, request_reference, selected_fund, payment_status,
             commitment_amount, risk_flags, paid_at, verified_at, rejected_at,
             nda_signed_at, meet_ceo_done, current_step, onboarding_complete,
             financial_link_status, institution_name, financial_data_status,
             plaid_product_count, plaid_account_count, kyc_status,
             has_payment_request,
             (financial_data_status IN ('complete', 'partial', 'linked')) AS bank_linked,
             COALESCE(
               NULLIF(trim(concat_ws(' ', legal_first_name, legal_last_name)), ''),
               NULLIF(trim(signer_name), ''),
               NULLIF(trim(regexp_replace(split_part(COALESCE(email, ''), '@', 1), '[._-]+', ' ', 'g')), ''),
               'Hushh investor'
             ) AS recipient_name,
             array_remove(ARRAY[
               CASE WHEN financial_data_status IN ('complete', 'partial', 'linked') AND NOT has_onboarding_row THEN 'missing_onboarding_row' END,
               CASE WHEN financial_data_status IN ('complete', 'partial', 'linked') AND financial_link_status IS DISTINCT FROM 'completed' THEN 'onboarding_financial_link_status_not_completed' END,
               CASE WHEN financial_data_status NOT IN ('complete', 'partial', 'linked', 'skipped') THEN 'bank_not_linked' END,
               CASE WHEN nda_signed_at IS NULL THEN 'nda_not_signed' END,
               CASE WHEN onboarding_complete AND NOT has_payment_request THEN 'payment_not_started' END,
               CASE WHEN has_payment_request AND paid_at IS NULL THEN 'first_payment_not_paid' END,
               CASE WHEN paid_at IS NOT NULL AND payment_status NOT IN ('verified_investor', 'rejected') THEN 'awaiting_manual_verification' END,
               ${kycMissingPiece}
             ], NULL)::text[] AS missing_pieces,
             array_remove(ARRAY[
               CASE WHEN meet_ceo_done THEN 'ceo_meeting_payments' END,
               CASE WHEN has_payment_request THEN 'fund_stripe_payment_requests' END,
               CASE WHEN has_succeeded_payment THEN 'fund_stripe_payments' END,
               ${kycSource},
               CASE WHEN has_nda_row THEN 'nda_signatures' END,
               CASE WHEN has_onboarding_row THEN 'onboarding_data' END,
               CASE WHEN has_account_rows THEN 'plaid_accounts' END,
               CASE WHEN has_item_row THEN 'plaid_items' END,
               CASE WHEN has_product_rows THEN 'plaid_product_sync_statuses' END,
               CASE WHEN has_financial_row THEN 'user_financial_data' END
             ], NULL)::text[] AS data_sources
        FROM base
    ), projected AS (
      SELECT user_id, email, request_reference, selected_fund, payment_status,
             commitment_amount, risk_flags, paid_at, verified_at, rejected_at,
             nda_signed_at, meet_ceo_done, current_step, onboarding_complete,
             financial_link_status, institution_name, financial_data_status,
             plaid_product_count, plaid_account_count, kyc_status,
             has_payment_request, recipient_name, missing_pieces, data_sources,
             bank_linked,
             CASE
               WHEN payment_status = 'verified_investor' THEN 'manual_approved'
               WHEN payment_status = 'rejected' THEN 'manual_rejected'
               WHEN paid_at IS NOT NULL OR payment_status = 'pending_manual_verification' THEN 'awaiting_manual_review'
               WHEN has_payment_request THEN 'payment_started'
               WHEN onboarding_complete THEN 'onboarding_complete'
               WHEN bank_linked THEN 'bank_linked'
               WHEN has_onboarding_row AND (COALESCE(current_step, 0) > 1 OR onboarding_complete) THEN 'in_onboarding'
               WHEN nda_signed_at IS NOT NULL THEN 'nda_signed'
               ELSE 'lead'
             END AS stage,
             CASE
               WHEN payment_status = 'verified_investor' THEN 1
               WHEN payment_status = 'rejected' THEN 2
               WHEN paid_at IS NOT NULL OR payment_status = 'pending_manual_verification' THEN 0
               WHEN has_payment_request THEN 3
               WHEN onboarding_complete THEN 4
               WHEN bank_linked THEN 5
               WHEN has_onboarding_row AND (COALESCE(current_step, 0) > 1 OR onboarding_complete) THEN 6
               WHEN nda_signed_at IS NOT NULL THEN 7
               ELSE 8
             END AS stage_order,
             concat_ws(' ', recipient_name, email, request_reference,
               institution_name, financial_data_status, kyc_status,
               array_to_string(data_sources, ' '), array_to_string(missing_pieces, ' ')
             ) AS search_text
        FROM derived
    ), searched AS (
      SELECT user_id, email, request_reference, selected_fund, payment_status,
             commitment_amount, risk_flags, paid_at, verified_at, rejected_at,
             nda_signed_at, meet_ceo_done, current_step, onboarding_complete,
             financial_link_status, institution_name, financial_data_status,
             plaid_product_count, plaid_account_count, kyc_status,
             has_payment_request, recipient_name, missing_pieces, data_sources,
             bank_linked, stage, stage_order
        FROM projected
       WHERE $1 = '' OR position(lower($1) in lower(search_text)) > 0
    ), counts AS (
      SELECT count(*)::integer AS count_all,
             count(*) FILTER (WHERE cardinality(missing_pieces) > 0)::integer AS count_needs_attention,
             count(*) FILTER (WHERE onboarding_complete)::integer AS count_completed_onboarding,
             count(*) FILTER (WHERE bank_linked)::integer AS count_bank_linked,
             count(*) FILTER (WHERE has_payment_request OR paid_at IS NOT NULL)::integer AS count_payment_review,
             count(*) FILTER (WHERE payment_status = 'verified_investor')::integer AS count_manually_approved
        FROM searched
    ), page_rows AS (
      SELECT user_id, email, request_reference, selected_fund, payment_status,
             commitment_amount, risk_flags, paid_at, verified_at, rejected_at,
             nda_signed_at, meet_ceo_done, current_step, onboarding_complete,
             financial_link_status, institution_name, financial_data_status,
             plaid_product_count, plaid_account_count, kyc_status,
             recipient_name, missing_pieces, data_sources, bank_linked, stage
        FROM searched
       WHERE CASE $2
         WHEN 'needs_attention' THEN cardinality(missing_pieces) > 0
         WHEN 'completed_onboarding' THEN onboarding_complete
         WHEN 'bank_linked' THEN bank_linked
         WHEN 'payment_review' THEN has_payment_request OR paid_at IS NOT NULL
         WHEN 'manually_approved' THEN payment_status = 'verified_investor'
         ELSE true
       END
       ORDER BY stage_order, COALESCE(verified_at, paid_at, nda_signed_at, to_timestamp(0)) DESC, user_id
       LIMIT $3 OFFSET $4
    )
    SELECT page_rows.user_id, page_rows.email, page_rows.request_reference,
           page_rows.selected_fund, page_rows.payment_status,
           page_rows.commitment_amount, page_rows.risk_flags,
           page_rows.paid_at, page_rows.verified_at, page_rows.rejected_at,
           page_rows.nda_signed_at, page_rows.meet_ceo_done,
           page_rows.current_step, page_rows.onboarding_complete,
           page_rows.financial_link_status, page_rows.institution_name,
           page_rows.financial_data_status, page_rows.plaid_product_count,
           page_rows.plaid_account_count, page_rows.kyc_status,
           page_rows.recipient_name, page_rows.missing_pieces,
           page_rows.data_sources, page_rows.bank_linked, page_rows.stage,
           counts.count_all, counts.count_needs_attention,
           counts.count_completed_onboarding, counts.count_bank_linked,
           counts.count_payment_review, counts.count_manually_approved
      FROM counts
      LEFT JOIN page_rows ON true`;
}

function missingOptionalKyc(error) {
  return error?.code === "42P01" && /kyc_attestations/i.test(String(error?.message ?? ""));
}

function safeCount(value) {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RuntimeError("DATABASE_UNAVAILABLE", "Database unavailable.", 503);
  }
  return count;
}

function investorListResult(resultRows, pageSize, tab, sourceWarnings) {
  if (!Array.isArray(resultRows) || resultRows.length > pageSize) {
    throw new RuntimeError("DATABASE_UNAVAILABLE", "Database unavailable.", 503);
  }
  const first = resultRows[0] ?? {};
  const counts = {
    needs_attention: safeCount(first.count_needs_attention),
    completed_onboarding: safeCount(first.count_completed_onboarding),
    bank_linked: safeCount(first.count_bank_linked),
    payment_review: safeCount(first.count_payment_review),
    manually_approved: safeCount(first.count_manually_approved),
    all: safeCount(first.count_all),
  };
  const investors = resultRows
    .filter((row) => typeof row?.user_id === "string" && row.user_id)
    .map((row) => ({
      userId: row.user_id,
      recipientName: clean(row.recipient_name) || "Hushh investor",
      userEmail: clean(row.email) || null,
      stage: clean(row.stage) || "lead",
      requestReference: row.request_reference ?? null,
      selectedFund: row.selected_fund ?? null,
      commitmentLabel: row.commitment_amount == null
        ? null
        : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 })
          .format(Number(row.commitment_amount) || 0),
      status: row.payment_status ?? null,
      paymentRequestStatus: row.payment_status ?? null,
      manualReviewStatus:
        row.paid_at && !["verified_investor", "rejected"].includes(row.payment_status)
          ? "pending_manual_verification"
          : ["verified_investor", "rejected"].includes(row.payment_status)
            ? row.payment_status
            : null,
      manualInvestorStatus: ["verified_investor", "rejected"].includes(row.payment_status)
        ? row.payment_status
        : "not_verified",
      paidAt: row.paid_at ?? null,
      firstPaymentPaid: Boolean(row.paid_at),
      verifiedAt: row.verified_at ?? null,
      rejectedAt: row.rejected_at ?? null,
      ndaSignedAt: row.nda_signed_at ?? null,
      ndaSigned: Boolean(row.nda_signed_at),
      meetCeoDone: row.meet_ceo_done === true,
      currentStep: row.current_step ?? null,
      onboardingComplete: row.onboarding_complete === true,
      financialLinkStatus: row.financial_link_status ?? null,
      bankLinked: row.bank_linked === true,
      institutionName: row.institution_name ?? null,
      financialDataStatus: row.financial_data_status ?? "missing",
      plaidProductCount: safeCount(row.plaid_product_count),
      plaidAccountCount: safeCount(row.plaid_account_count),
      kycStatus: row.kyc_status ?? "not_configured",
      riskFlags: Array.isArray(row.risk_flags) ? row.risk_flags : [],
      missingPieces: Array.isArray(row.missing_pieces) ? row.missing_pieces : [],
      dataSources: Array.isArray(row.data_sources) ? row.data_sources : [],
    }));
  return {
    investors,
    total: counts[tab] ?? counts.all,
    counts,
    sourceWarnings,
  };
}

export function createCloudSqlReadBatchAdapter() {
  return Object.freeze({
    async chatAccess({ database, visitorId, slug, now, signal }) {
      return requireDatabase(database).transaction(async (client) => {
        throwIfAborted(signal);
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1 || chr(0) || $2, 0))",
          [visitorId, slug],
        );
        let matches = await rows(
          client,
          `SELECT id, access_type, expires_at, messages_limit,
                  messages_sent_count, hourly_message_count, hourly_reset_at
             FROM public.chat_access_tokens
            WHERE visitor_id = $1 AND profile_slug = $2
            ORDER BY id
            LIMIT 2
            FOR UPDATE`,
          [visitorId, slug],
        );
        if (matches.length > 1) {
          throw new RuntimeError(
            "DATA_INTEGRITY_ERROR",
            "Service unavailable.",
            503,
          );
        }
        if (matches.length === 0) {
          matches = await rows(
            client,
            `INSERT INTO public.chat_access_tokens
               (visitor_id, profile_slug, payment_status, access_type,
                messages_limit, messages_sent_count, ip_address, user_agent)
             VALUES ($1, $2, 'free_tier', 'free', 3, 0, NULL, NULL)
             RETURNING id, access_type, expires_at, messages_limit,
                       messages_sent_count, hourly_message_count,
                       hourly_reset_at`,
            [visitorId, slug],
          );
        }
        const token = matches[0];
        if (token?.access_type === "paid") {
          const resetAt = Date.parse(token.hourly_reset_at ?? now.toISOString());
          if (Number.isFinite(resetAt) && now.getTime() > resetAt) {
            await client.query(
              `UPDATE public.chat_access_tokens
                  SET hourly_message_count = 0,
                      hourly_reset_at = $2
                WHERE id = $1`,
              [token.id, new Date(now.getTime() + 3_600_000).toISOString()],
            );
            token.hourly_message_count = 0;
          }
        }
        throwIfAborted(signal);
        return token;
      });
    },

    async publicInvestorProfile({ database, slug, signal }) {
      return requireDatabase(database).transaction(async (client) => {
        throwIfAborted(signal);
        const matches = await rows(
          client,
          `SELECT name, age, organisation, investor_profile, slug
             FROM public.investor_profiles
            WHERE slug = $1
              AND is_public IS TRUE
              AND user_confirmed IS TRUE
            LIMIT 2`,
          [slug],
        );
        return matches.length === 1 ? matches[0] : null;
      });
    },

    async overview({
      database,
      actor,
      targetReference = null,
      includeUsers = true,
      signal,
    }) {
      requireFundAdminActor(actor);
      if (typeof includeUsers !== "boolean") {
        throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
      }
      return requireDatabase(database).transaction(async (client) => {
        throwIfAborted(signal);
        await bestEffortAdminAudit(client, actor, targetReference);
        const sourceWarnings = [];
        const output = {
          paymentRows: await rows(client, `SELECT id, user_id, request_reference,
            selected_fund, status, commitment_amount, first_payment_amount,
            class_a_units, class_b_units, class_c_units, risk_flags, paid_at,
            verified_at, rejected_at, reviewer_user_id, created_at
            FROM public.fund_stripe_payment_requests`),
          ndaRows: await rows(client, `SELECT user_id, signer_name, signed_at
            FROM public.nda_signatures WHERE signed_at IS NOT NULL`),
          ceoRows: await rows(client, `SELECT user_id, payment_status,
            calendly_booked, created_at FROM public.ceo_meeting_payments
            WHERE payment_status = 'completed'`),
          onboardingRows: await rows(client, `SELECT user_id, legal_first_name,
            legal_last_name, current_step, is_completed, completed_at,
            fund_payment_status, fund_investor_verification_status,
            financial_link_status, nda_signed_at, initial_investment_amount,
            selected_fund, class_a_units, class_b_units, class_c_units,
            updated_at
            FROM public.onboarding_data`),
          paidRows: await rows(client, `SELECT user_id, amount, status
            FROM public.fund_stripe_payments WHERE status = 'succeeded'`),
          financialRows: await rows(client, `SELECT user_id, institution_name,
            status, plaid_sync_status, plaid_item_id,
            plaid_sync_completed_at, updated_at
            FROM public.user_financial_data`),
          itemRows: await rows(client, `SELECT user_id, plaid_item_id,
            institution_name, status, updated_at FROM public.plaid_items`),
          accountRows: await rows(client, `SELECT plaid_item_id,
            plaid_account_id, name, official_name, type, subtype, mask,
            current_balance FROM public.plaid_accounts`),
          productRows: await rows(client, `SELECT user_id, plaid_item_id,
            product, status, available, records_count, updated_at, completed_at
            FROM public.plaid_product_sync_statuses`),
          userRows: includeUsers
            ? await rows(client, "SELECT id, email FROM public.users")
            : [],
        };
        output.kycRows = await optionalRows(
          client,
          "optional_kyc_overview",
          "kyc_attestations",
          `SELECT user_id, status, risk_band, risk_score, verified_at,
                  provider_name FROM public.kyc_attestations
            ORDER BY verified_at DESC`,
          sourceWarnings,
        );
        output.sourceWarnings = sourceWarnings;
        throwIfAborted(signal);
        return output;
      });
    },

    async overviewList({
      database,
      actor,
      page,
      pageSize,
      tab,
      search,
      signal,
    }) {
      requireFundAdminActor(actor);
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100 ||
        !ADMIN_LIST_TABS.has(tab) ||
        typeof search !== "string" ||
        search.length > 200
      ) {
        throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
      }
      const offset = (page - 1) * pageSize;
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new RuntimeError("INVALID_REQUEST", "Invalid request.", 400);
      }
      return requireDatabase(database).transaction(async (client) => {
        throwIfAborted(signal);
        await bestEffortAdminAudit(client, actor, `list:${tab}`);
        const values = [search, tab, pageSize, offset];
        const sourceWarnings = [];
        await client.query("SAVEPOINT optional_kyc_admin_list");
        let resultRows;
        try {
          resultRows = await rows(client, adminListQuery(true), values);
          await client.query("RELEASE SAVEPOINT optional_kyc_admin_list");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT optional_kyc_admin_list");
          await client.query("RELEASE SAVEPOINT optional_kyc_admin_list");
          if (!missingOptionalKyc(error)) throw error;
          sourceWarnings.push({
            source: "kyc_attestations",
            code: "SOURCE_UNAVAILABLE",
            message: "Optional source is unavailable",
          });
          resultRows = await rows(client, adminListQuery(false), values);
        }
        throwIfAborted(signal);
        return investorListResult(resultRows, pageSize, tab, sourceWarnings);
      });
    },

    async analytics({ database, actor, signal }) {
      requireFundAdminActor(actor);
      return requireDatabase(database).transaction(async (client) => {
        throwIfAborted(signal);
        const sourceWarnings = [];
        const output = {
          paymentRows: await rows(client, `SELECT user_id, selected_fund,
            status, commitment_amount, first_payment_amount, class_a_units,
            class_b_units, class_c_units, recurring_selected,
            recurring_amount, paid_at, verified_at, rejected_at, created_at
            FROM public.fund_stripe_payment_requests`),
          ndaRows: await rows(client, `SELECT user_id, signed_at
            FROM public.nda_signatures WHERE signed_at IS NOT NULL`),
          onboardingRows: await rows(client, `SELECT user_id, is_completed,
            completed_at, financial_link_status, selected_fund
            FROM public.onboarding_data`),
          paidRows: await rows(client, `SELECT user_id, amount_cents, status,
            payment_kind, paid_at, created_at FROM public.fund_stripe_payments
            WHERE status = 'succeeded'`),
          financialRows: await rows(client, `SELECT user_id, status,
            plaid_sync_status, plaid_item_id FROM public.user_financial_data`),
          ceoRows: await rows(client, `SELECT user_id, payment_status
            FROM public.ceo_meeting_payments
            WHERE payment_status = 'completed'`),
          subscriptionRows: await rows(client, `SELECT user_id, status,
            recurring_amount, recurring_frequency
            FROM public.fund_stripe_subscriptions`),
        };
        output.kycRows = await optionalRows(
          client,
          "optional_kyc_analytics",
          "kyc_attestations",
          "SELECT user_id, status, risk_band FROM public.kyc_attestations",
          sourceWarnings,
        );
        output.sourceWarnings = sourceWarnings;
        throwIfAborted(signal);
        return output;
      });
    },
  });
}

function validateLocationCatalog(value) {
  if (!value || !Array.isArray(value.countries) || value.countries.length < 1) {
    throw new Error("Location catalog is invalid.");
  }
  const countries = [];
  const seenCountries = new Set();
  for (const country of value.countries) {
    const isoCode = clean(country?.isoCode).toUpperCase();
    const name = clean(country?.name);
    if (
      !LOCATION_CODE_PATTERN.test(isoCode) ||
      !name ||
      name.length > 128 ||
      seenCountries.has(isoCode) ||
      !Array.isArray(country?.states)
    ) {
      throw new Error("Location catalog is invalid.");
    }
    seenCountries.add(isoCode);
    const states = [];
    const seenStates = new Set();
    for (const state of country.states) {
      const stateCode = clean(state?.isoCode).toUpperCase();
      const stateName = clean(state?.name);
      if (
        !LOCATION_CODE_PATTERN.test(stateCode) ||
        !stateName ||
        stateName.length > 128 ||
        seenStates.has(stateCode) ||
        !Array.isArray(state?.cities)
      ) {
        throw new Error("Location catalog is invalid.");
      }
      seenStates.add(stateCode);
      const cities = state.cities.map((city) => clean(city));
      if (
        cities.some((city) => !city || city.length > 160) ||
        new Set(cities).size !== cities.length
      ) {
        throw new Error("Location catalog is invalid.");
      }
      states.push(Object.freeze({
        isoCode: stateCode,
        name: stateName,
        cities: Object.freeze(cities),
      }));
    }
    countries.push(Object.freeze({
      isoCode,
      name,
      states: Object.freeze(states),
    }));
  }
  return Object.freeze(countries);
}

export function createStaticLocationCatalogAdapter(catalog) {
  const countries = validateLocationCatalog(catalog);
  const byCountry = new Map(countries.map((country) => [country.isoCode, country]));
  return Object.freeze({
    configured: true,
    countries() {
      return countries.map(({ isoCode, name }) => ({ isoCode, name }));
    },
    states(countryCode) {
      return (byCountry.get(countryCode)?.states ?? []).map(({ isoCode, name }) => ({
        isoCode,
        name,
      }));
    },
    cities(countryCode, stateCode) {
      const state = byCountry
        .get(countryCode)
        ?.states.find((candidate) => candidate.isoCode === stateCode);
      return (state?.cities ?? []).map((name) => ({ name }));
    },
  });
}

export function createGcsLocationCatalogAdapter({
  fetchImpl = globalThis.fetch,
  getAccessToken,
  bucket,
  object,
  generation,
  sha256,
} = {}) {
  if (
    typeof fetchImpl !== "function" ||
    typeof getAccessToken !== "function" ||
    !GCS_NAME_PATTERN.test(clean(bucket)) ||
    !clean(object) ||
    clean(object).length > 1_024 ||
    !/^[1-9][0-9]{0,30}$/.test(clean(generation)) ||
    !HASH_PATTERN.test(clean(sha256))
  ) {
    throw new Error("Pinned GCS location catalog configuration is required.");
  }
  let loaded = null;
  async function load(signal) {
    if (loaded) return loaded;
    const token = clean(await getAccessToken());
    if (!token) throw new Error("GCS identity token is unavailable.");
    const url = new URL(
      `/download/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`,
      GCS_DOWNLOAD_ORIGIN,
    );
    url.searchParams.set("alt", "media");
    url.searchParams.set("generation", generation);
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error("Location catalog is unavailable.");
    const bytes = await readBoundedResponseBody(response, signal);
    if (
      createHash("sha256").update(bytes).digest("hex") !== sha256
    ) {
      throw new Error("Location catalog integrity check failed.");
    }
    loaded = createStaticLocationCatalogAdapter(JSON.parse(bytes.toString("utf8")));
    return loaded;
  }
  return Object.freeze({
    configured: true,
    async countries(signal) {
      return (await load(signal)).countries();
    },
    async states(countryCode, signal) {
      return (await load(signal)).states(countryCode);
    },
    async cities(countryCode, stateCode, signal) {
      return (await load(signal)).cities(countryCode, stateCode);
    },
  });
}

export function createVertexInvestorProfileAdapter({
  fetchImpl = globalThis.fetch,
  getAccessToken,
  projectId,
  location = VERTEX_LOCATION,
  model = VERTEX_MODEL,
} = {}) {
  if (
    typeof fetchImpl !== "function" ||
    typeof getAccessToken !== "function" ||
    !ALLOWED_PROJECTS.has(projectId) ||
    location !== VERTEX_LOCATION ||
    model !== VERTEX_MODEL
  ) {
    throw new Error("Pinned Vertex AI configuration is required.");
  }
  const endpoint = new URL(
    `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`,
  );
  return Object.freeze({
    configured: true,
    async generate({ systemInstruction, prompt, signal }) {
      const token = clean(await getAccessToken());
      if (!token) throw new Error("Vertex AI identity token is unavailable.");
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 4_096,
            responseMimeType: "application/json",
          },
        }),
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error("Vertex AI request failed.");
      const payload = await response.json();
      const text = payload?.candidates?.[0]?.content?.parts
        ?.map((part) => clean(part?.text))
        .filter(Boolean)
        .join("");
      if (!text) throw new Error("Vertex AI response was empty.");
      return text;
    },
  });
}

export const GCP_READ_BATCH_ADAPTER_LIMITS = Object.freeze({
  maxCatalogBytes: MAX_CATALOG_BYTES,
  vertexLocation: VERTEX_LOCATION,
  vertexModel: VERTEX_MODEL,
});
