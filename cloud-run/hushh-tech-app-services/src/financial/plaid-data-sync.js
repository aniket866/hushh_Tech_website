import { RuntimeError } from "../errors.js";
import {
  PLAID_BACKGROUND_PRODUCTS,
  PLAID_DATA_PRODUCTS,
  PLAID_IMMEDIATE_PRODUCTS,
  PlaidApiError,
} from "./plaid-client.js";

export {
  PLAID_BACKGROUND_PRODUCTS,
  PLAID_DATA_PRODUCTS,
  PLAID_IMMEDIATE_PRODUCTS,
};

export const PLAID_PRODUCT_SYNC_STATUSES = Object.freeze([
  "pending",
  "syncing",
  "complete",
  "partial",
  "unsupported",
  "access_required",
  "failed",
]);

function requireMethod(target, method, label = "Financial data repository") {
  if (!target || target.configured !== true || typeof target[method] !== "function") {
    throw new RuntimeError(
      "FINANCIAL_LINK_ADAPTER_UNAVAILABLE",
      "Financial service is unavailable.",
      503,
      { diagnosticCode: `${label.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${method.toUpperCase()}_MISSING` },
    );
  }
  return target[method].bind(target);
}

function isoNow(now = Date.now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Financial link clock is invalid.");
  }
  return date.toISOString();
}

export function isoDateDaysAgo(days, now = Date.now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Financial link clock is invalid.");
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function todayIsoDate(now = Date.now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Financial link clock is invalid.");
  return date.toISOString().slice(0, 10);
}

export function redactAuthNumbers(authData) {
  const ach = Array.isArray(authData?.numbers?.ach) ? authData.numbers.ach : [];
  return {
    accounts: authData?.accounts || [],
    numbers: {
      ach: ach.map((entry) => ({
        account_id: entry.account_id,
        account_mask: entry.account ? String(entry.account).slice(-4) : null,
        routing_mask: entry.routing ? String(entry.routing).slice(-4) : null,
        wire_routing_mask: entry.wire_routing
          ? String(entry.wire_routing).slice(-4)
          : null,
      })),
    },
    sensitive_redacted: true,
  };
}

export function classifyPlaidProductError(error) {
  const details = error instanceof PlaidApiError
    ? error.details
    : error?.details && typeof error.details === "object"
      ? error.details
      : {};
  const code = typeof details.error_code === "string" ? details.error_code : null;
  const message = typeof details.error_message === "string"
    ? details.error_message
    : error instanceof Error
      ? error.message
      : "Plaid product sync failed";
  const requestId = typeof details.request_id === "string" ? details.request_id : null;

  if (code === "PRODUCT_NOT_READY") {
    return { status: "pending", error: message, errorCode: code, requestId };
  }
  if ([
    "PRODUCT_NOT_SUPPORTED",
    "PRODUCTS_NOT_SUPPORTED",
    "NO_INVESTMENT_ACCOUNTS",
    "NO_LIABILITY_ACCOUNTS",
  ].includes(code)) {
    return { status: "unsupported", error: message, errorCode: code, requestId };
  }
  if ([
    "ACCESS_NOT_GRANTED",
    "ITEM_LOGIN_REQUIRED",
    "ADDITIONAL_CONSENT_REQUIRED",
    "MISSING_PRODUCT_ACCESS",
  ].includes(code)) {
    return { status: "access_required", error: message, errorCode: code, requestId };
  }
  return { status: "failed", error: message, errorCode: code, requestId };
}

function recordCount(value, field) {
  return Array.isArray(value?.[field]) ? value[field].length : 0;
}

function rawMetadataWithToken(token) {
  return token ? { asset_report_token: token } : null;
}

function patchForProduct(product, result) {
  switch (product) {
    case "accounts":
      return {};
    case "balance":
      return result.available ? { balances: result.data } : {};
    case "auth":
      return result.available ? { auth_numbers: redactAuthNumbers(result.data) } : {};
    case "identity":
      return result.available ? { identity_data: result.data } : {};
    case "identity_match":
      return result.available
        ? { identity_match: result.data, identity_match_scores: result.data }
        : {};
    case "investments":
      return result.available ? { investments: result.data } : {};
    case "investment_transactions":
      return result.available ? { investment_transactions: result.data } : {};
    case "liabilities":
      return result.available ? { liabilities_data: result.data } : {};
    case "signal":
      return { signal_prepared: result.available };
    case "transactions":
      return result.available ? { transactions_data: result.data } : {};
    case "assets":
      return {
        asset_report_status: result.status,
        ...(result.available ? { asset_report: result.data } : {}),
        ...(result.rawMetadata?.asset_report_token
          ? { asset_report_token: result.rawMetadata.asset_report_token }
          : {}),
      };
    case "statements":
      return result.available ? { statements_data: result.data } : {};
    case "income":
      return result.available ? { income_data: result.data } : {};
    default:
      return {};
  }
}

async function mergeFinancialData({ repository, userId, item, product, result, patch, now }) {
  const mergeFinancialDataProduct = requireMethod(repository, "mergeFinancialDataProduct");
  // The source helper applies a product-local patch.  Do not read/merge a
  // whole financial row in JavaScript: simultaneous background products would
  // otherwise each write an obsolete snapshot and erase one another.  The
  // repository performs the product-local JSON/state merge in one SQL
  // conflict update, so Assets, Investments, Identity, errors, and asset
  // report state retain the source helper's independent-product semantics.
  await mergeFinancialDataProduct({
    userId,
    plaidItemId: item.plaidItemId,
    institutionName: item.institutionName || null,
    institutionId: item.institutionId || null,
    product,
    available: Boolean(result.available),
    error: result.error || null,
    errorCode: result.errorCode || null,
    productStatus: result.status,
    patch: patch && typeof patch === "object" ? patch : {},
    updatedAt: isoNow(now),
  });
}

async function updateProductStatus({ repository, userId, plaidItemId, product, result, now }) {
  const update = requireMethod(repository, "upsertProductStatus");
  const terminal = ["complete", "partial", "unsupported", "access_required", "failed"].includes(
    result.status,
  );
  const timestamp = isoNow(now);
  await update({
    userId,
    plaidItemId,
    product,
    status: result.status,
    available: Boolean(result.available),
    recordsCount: result.recordsCount ?? null,
    errorCode: result.errorCode || null,
    errorMessage: result.error || null,
    requestId: result.requestId || null,
    rawMetadata: result.rawMetadata || null,
    startedAt: result.status === "syncing" ? timestamp : undefined,
    completedAt: terminal ? timestamp : null,
    attempts: result.status === "syncing" ? undefined : 1,
    updatedAt: timestamp,
  });
}

export async function ensureProductStatuses({ repository, userId, plaidItemId, now = Date.now }) {
  const ensure = requireMethod(repository, "ensureProductStatuses");
  return ensure({
    userId,
    plaidItemId,
    products: PLAID_DATA_PRODUCTS,
    updatedAt: isoNow(now),
  });
}

async function syncTransactions({ repository, plaid, userId, plaidItemId, accessToken, signal, now }) {
  const getSyncCursor = requireMethod(repository, "getSyncCursor");
  const upsertTransactions = requireMethod(repository, "upsertTransactions");
  const deleteTransactions = requireMethod(repository, "deleteTransactions");
  const upsertSyncCursor = requireMethod(repository, "upsertSyncCursor");
  const cursorRow = await getSyncCursor({ plaidItemId, product: "transactions" });
  let cursor = cursorRow?.cursor || undefined;
  let hasMore = true;
  let addedCount = 0;
  let modifiedCount = 0;
  let removedCount = 0;
  const sample = [];

  for (let page = 0; page < 8 && hasMore; page += 1) {
    const { data } = await plaid.post("/transactions/sync", {
      access_token: accessToken,
      ...(cursor ? { cursor } : {}),
      count: 500,
    }, { signal });
    const added = Array.isArray(data?.added) ? data.added : [];
    const modified = Array.isArray(data?.modified) ? data.modified : [];
    const removed = Array.isArray(data?.removed) ? data.removed : [];
    const upsertable = [...added, ...modified];
    if (upsertable.length > 0) {
      await upsertTransactions({ plaidItemId, transactions: upsertable });
      for (const transaction of upsertable) {
        if (sample.length < 25) sample.push(transaction);
      }
    }
    const removedIds = removed
      .map((transaction) => transaction?.transaction_id)
      .filter(Boolean);
    if (removedIds.length > 0) {
      await deleteTransactions({ plaidItemId, transactionIds: removedIds });
    }
    addedCount += added.length;
    modifiedCount += modified.length;
    removedCount += removed.length;
    hasMore = Boolean(data?.has_more);
    cursor = data?.next_cursor || cursor;
  }

  if (cursor) {
    await upsertSyncCursor({
      plaidItemId,
      product: "transactions",
      cursor,
      lastSyncedAt: isoNow(now),
      updatedAt: isoNow(now),
    });
  }
  return {
    product: "transactions",
    status: "complete",
    available: true,
    recordsCount: addedCount + modifiedCount,
    data: {
      sync_type: "transactions_sync",
      added_count: addedCount,
      modified_count: modifiedCount,
      removed_count: removedCount,
      sample,
      cursor_saved: Boolean(cursor),
    },
  };
}

async function syncAssetReport({ repository, plaid, userId, item, accessToken, signal, now }) {
  const getFinancialData = requireMethod(repository, "getFinancialData");
  const existing = await getFinancialData({ userId });
  let assetReportToken = existing?.asset_report_token || existing?.assetReportToken || null;
  let createdData = null;

  if (!assetReportToken) {
    const { data } = await plaid.post("/asset_report/create", {
      access_tokens: [accessToken],
      days_requested: 731,
      options: { add_ons: ["fast_assets"] },
    }, { signal });
    createdData = data;
    assetReportToken = data?.asset_report_token || null;
    if (assetReportToken) {
      await mergeFinancialData({
        repository,
        userId,
        item,
        product: "assets",
        patch: {
          asset_report_token: assetReportToken,
          asset_report_status: "pending",
          asset_report_created_at: isoNow(now),
        },
        result: { product: "assets", status: "pending", available: false },
        now,
      });
    }
  }

  if (!assetReportToken) {
    return {
      product: "assets",
      status: "failed",
      available: false,
      error: "Plaid did not return an asset_report_token",
      rawMetadata: createdData || null,
    };
  }

  try {
    const { data } = await plaid.post("/asset_report/get", {
      asset_report_token: assetReportToken,
    }, { signal });
    return {
      product: "assets",
      status: "complete",
      available: true,
      recordsCount: Array.isArray(data?.report?.items) ? data.report.items.length : null,
      data,
      rawMetadata: rawMetadataWithToken(assetReportToken),
    };
  } catch (error) {
    const classified = classifyPlaidProductError(error);
    if (classified.status === "pending") {
      return {
        product: "assets",
        status: "pending",
        available: false,
        error: classified.error,
        errorCode: classified.errorCode,
        requestId: classified.requestId,
        rawMetadata: rawMetadataWithToken(assetReportToken),
      };
    }
    throw error;
  }
}

async function syncStatements({ repository, plaid, userId, plaidItemId, accessToken, signal, now }) {
  const upsertStatementMetadata = requireMethod(repository, "upsertStatementMetadata");
  const { data } = await plaid.post("/statements/list", { access_token: accessToken }, { signal });
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
  let count = 0;
  for (const account of accounts) {
    const statements = Array.isArray(account?.statements) ? account.statements : [];
    for (const statement of statements) {
      count += 1;
      await upsertStatementMetadata({
        userId,
        plaidItemId,
        plaidAccountId: account?.account_id || null,
        statement,
        updatedAt: isoNow(now),
      });
    }
  }
  return {
    product: "statements",
    status: "complete",
    available: true,
    recordsCount: count,
    data,
  };
}

function identityMatchUser(profile) {
  if (!profile || typeof profile !== "object") return {};
  const user = {};
  if (typeof profile.legalName === "string" && profile.legalName.trim()) {
    user.legal_name = profile.legalName.trim();
  }
  if (typeof profile.emailAddress === "string" && profile.emailAddress.trim()) {
    user.email_address = profile.emailAddress.trim();
  }
  if (typeof profile.phoneNumber === "string" && profile.phoneNumber.trim()) {
    user.phone_number = profile.phoneNumber.trim();
  }
  if (profile.address && typeof profile.address === "object") {
    user.address = profile.address;
  }
  return user;
}

/**
 * Synchronise one already-authorised Plaid product.  This is used by the
 * immediate request path and by the private durable worker; it intentionally
 * does not expose an additional browser endpoint.
 */
export async function syncPlaidDataProduct({
  repository,
  plaid,
  userId,
  item,
  accessToken,
  product,
  signal,
  now = Date.now,
} = {}) {
  if (!PLAID_DATA_PRODUCTS.includes(product)) {
    throw new RuntimeError("INVALID_REQUEST", "Valid product is required", 400);
  }
  if (!item?.plaidItemId || typeof accessToken !== "string" || !accessToken) {
    throw new RuntimeError("FINANCIAL_LINK_STATE_INVALID", "Financial link is unavailable.", 409);
  }
  if (!plaid || plaid.configured !== true || typeof plaid.post !== "function") {
    throw new RuntimeError("FINANCIAL_LINK_ADAPTER_UNAVAILABLE", "Financial service is unavailable.", 503);
  }

  const plaidItemId = item.plaidItemId;
  await updateProductStatus({
    repository,
    userId,
    plaidItemId,
    product,
    result: { product, status: "syncing", available: false },
    now,
  });

  let result;
  try {
    const baseBody = { access_token: accessToken };
    const startDate = isoDateDaysAgo(731, now);
    const endDate = todayIsoDate(now);
    if (product === "accounts") {
      const { data, requestId } = await plaid.post("/accounts/get", baseBody, { signal });
      const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
      const upsertAccounts = requireMethod(repository, "upsertAccounts");
      // This financial-link adapter deliberately persists only the same
      // account data needed for profile cards.  Transfer account material is
      // outside the linked-card flow and remains outside this migration.
      await upsertAccounts({
        userId,
        plaidItemId,
        institution: { id: item.institutionId, name: item.institutionName },
        accounts,
        updatedAt: isoNow(now),
      });
      result = { product, status: "complete", available: true, recordsCount: accounts.length, data, requestId };
    } else if (product === "balance") {
      const { data, requestId } = await plaid.post("/accounts/balance/get", baseBody, { signal });
      result = { product, status: "complete", available: true, recordsCount: recordCount(data, "accounts"), data, requestId };
    } else if (product === "auth") {
      const { data, requestId } = await plaid.post("/auth/get", baseBody, { signal });
      result = { product, status: "complete", available: true, recordsCount: recordCount(data, "accounts"), data, requestId };
    } else if (product === "identity") {
      const { data, requestId } = await plaid.post("/identity/get", baseBody, { signal });
      result = { product, status: "complete", available: true, recordsCount: recordCount(data, "accounts"), data, requestId };
    } else if (product === "identity_match") {
      const getIdentityMatchUser = requireMethod(repository, "getIdentityMatchUser");
      const user = identityMatchUser(await getIdentityMatchUser({ userId }));
      if (Object.keys(user).length === 0) {
        result = {
          product,
          status: "pending",
          available: false,
          error: "User legal identity fields are not available yet",
          errorCode: "USER_IDENTITY_PENDING",
        };
      } else {
        const { data, requestId } = await plaid.post("/identity/match", { ...baseBody, user }, { signal });
        result = { product, status: "complete", available: true, recordsCount: 1, data, requestId };
      }
    } else if (product === "investments") {
      const { data, requestId } = await plaid.post("/investments/holdings/get", baseBody, { signal });
      // A successful empty holdings response remains available.  The UI uses
      // this exact distinction for the truthful "No Investment Holdings" state.
      result = { product, status: "complete", available: true, recordsCount: recordCount(data, "holdings"), data, requestId };
    } else if (product === "investment_transactions") {
      const { data, requestId } = await plaid.post("/investments/transactions/get", {
        ...baseBody,
        start_date: startDate,
        end_date: endDate,
        options: { count: 500, offset: 0 },
      }, { signal });
      result = { product, status: "complete", available: true, recordsCount: recordCount(data, "investment_transactions"), data, requestId };
    } else if (product === "liabilities") {
      const { data, requestId } = await plaid.post("/liabilities/get", baseBody, { signal });
      const liabilities = data?.liabilities || {};
      const recordsCount = Object.values(liabilities)
        .filter(Array.isArray)
        .reduce((sum, entries) => sum + entries.length, 0);
      result = { product, status: "complete", available: true, recordsCount, data, requestId };
    } else if (product === "signal") {
      const { data, requestId } = await plaid.post("/signal/prepare", baseBody, { signal });
      result = { product, status: "complete", available: true, recordsCount: 1, data, requestId };
    } else if (product === "transactions") {
      result = await syncTransactions({ repository, plaid, userId, plaidItemId, accessToken, signal, now });
    } else if (product === "assets") {
      result = await syncAssetReport({ repository, plaid, userId, item, accessToken, signal, now });
    } else if (product === "statements") {
      result = await syncStatements({ repository, plaid, userId, plaidItemId, accessToken, signal, now });
    } else if (product === "income") {
      result = {
        product,
        status: "access_required",
        available: false,
        error: "Bank Income requires the dedicated Bank Income/update-mode Link flow",
        errorCode: "BANK_INCOME_UPDATE_MODE_REQUIRED",
      };
    }

    await mergeFinancialData({
      repository,
      userId,
      item,
      product,
      result,
      patch: patchForProduct(product, result),
      now,
    });
    await updateProductStatus({ repository, userId, plaidItemId, product, result, now });
    const touchItem = requireMethod(repository, "touchPlaidItemSync");
    await touchItem({ plaidItemId, syncedAt: isoNow(now), updatedAt: isoNow(now) });
    return result;
  } catch (error) {
    const classified = classifyPlaidProductError(error);
    result = {
      product,
      status: classified.status,
      available: false,
      error: classified.error,
      errorCode: classified.errorCode,
      requestId: classified.requestId,
    };
    await mergeFinancialData({
      repository,
      userId,
      item,
      product,
      result,
      patch: patchForProduct(product, result),
      now,
    });
    await updateProductStatus({ repository, userId, plaidItemId, product, result, now });
    return result;
  }
}

export function summarizeProductResults(results) {
  const availableProducts = Object.fromEntries(
    results.map((result) => [result.product, Boolean(result.available)]),
  );
  const fetchErrors = Object.fromEntries(
    results
      .filter((result) => result.error)
      .map((result) => [result.product, {
        error: result.error,
        error_code: result.errorCode || null,
      }]),
  );
  const productsAvailable = results.filter((result) => result.available).length;
  return {
    status: productsAvailable >= 5 ? "complete" : productsAvailable > 0 ? "partial" : "failed",
    available_products: availableProducts,
    products_available: productsAvailable,
    fetch_errors: fetchErrors,
    can_proceed: Boolean(
      availableProducts.accounts &&
      availableProducts.balance &&
      availableProducts.auth,
    ),
  };
}

export function parsePlaidDataProduct(value) {
  const product = String(value || "").trim();
  return PLAID_DATA_PRODUCTS.includes(product) ? product : null;
}
