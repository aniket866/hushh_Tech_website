import {
  createHash,
  timingSafeEqual,
} from "node:crypto";

import { GoogleAuth } from "google-auth-library";

import { createFirebaseAdminAuth } from "../auth/firebase.js";
import { RuntimeError } from "../errors.js";
import {
  createFinancialLinkAdapter,
  FINANCIAL_LINK_KMS_ENVELOPE_PROTECTION,
} from "./financial-link-adapter.js";
import {
  createFinancialSyncTaskPublisher,
  financialSyncTaskName,
} from "./cloud-tasks-publisher.js";
import {
  createPlaidHttpClient,
  PLAID_BACKGROUND_PRODUCTS,
  readPlaidConfiguration,
} from "./plaid-client.js";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const KMS_API = "https://cloudkms.googleapis.com/v1";
const SYNC_JOB_LEASE_MS = 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ENVELOPE_PREFIX = "hushh-kms-v1.";
const MAX_KMS_PLAINTEXT_BYTES = 48_000;
const MAX_ENVELOPE_BYTES = 65_536;

function fail(code, message = "Financial service is unavailable.", statusCode = 503, diagnosticCode) {
  throw new RuntimeError(code, message, statusCode, { diagnosticCode });
}

function asRuntimeError(error, code = "FINANCIAL_LINK_ADAPTER_UNAVAILABLE") {
  if (error instanceof RuntimeError) return error;
  return new RuntimeError(code, "Financial service is unavailable.", 503, {
    cause: error,
  });
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeText(value, limit = 4_096) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= limit && !/[\u0000-\u001f\u007f]/.test(text)
    ? text
    : null;
}

function safeEmail(value) {
  const email = safeText(value, 320)?.toLowerCase() ?? null;
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function stableBytes(value) {
  return Buffer.from(stableJson(value), "utf8");
}

function equalBytes(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function jsonValue(value) {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    fail("INVALID_REQUEST", "Invalid request.", 400, "FINANCIAL_JSON_INVALID");
  }
}

function jsonObject(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function timestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    fail("FINANCIAL_LINK_ADAPTER_UNAVAILABLE", undefined, 503, "FINANCIAL_CLOCK_INVALID");
  }
  return date.toISOString();
}

function parseUuid(value, diagnosticCode = "FINANCIAL_JOB_ID_INVALID") {
  const text = String(value ?? "").trim();
  if (!UUID_PATTERN.test(text)) {
    fail("INVALID_REQUEST", "Invalid request.", 400, diagnosticCode);
  }
  return text.toLowerCase();
}

function assertConfigured(config) {
  const financial = config?.financial;
  if (
    !config ||
    config.stage !== "uat" ||
    !["financial-api", "worker"].includes(config.serviceOwner) ||
    !financial ||
    financial.enabled !== true ||
    typeof financial.plaidClientId !== "string" ||
    !financial.plaidClientId ||
    typeof financial.plaidSecret !== "string" ||
    !financial.plaidSecret ||
    !["sandbox", "production"].includes(financial.plaidEnvironment) ||
    typeof financial.plaidPrimaryProducts !== "string" ||
    !financial.plaidPrimaryProducts ||
    typeof financial.kmsKey !== "string" ||
    !financial.kmsKey ||
    typeof financial.taskQueue !== "string" ||
    !financial.taskQueue ||
    typeof financial.workerAudience !== "string" ||
    !financial.workerAudience ||
    typeof financial.taskRunnerServiceAccount !== "string" ||
    !financial.taskRunnerServiceAccount ||
    typeof financial.allowedRedirectOrigin !== "string" ||
    !financial.allowedRedirectOrigin
  ) {
    fail(
      "FINANCIAL_LINK_ADAPTER_UNAVAILABLE",
      "Financial service is unavailable.",
      503,
      "FINANCIAL_RUNTIME_CONFIG_REQUIRED",
    );
  }
  return financial;
}

function requireDatabase(database) {
  const owned = typeof database?.firebaseUid === "string" && Boolean(database.firebaseUid);
  const diagnosticsOnly =
    database?.firebaseUid === null &&
    typeof database?.diagnosticsTransaction === "function";
  if (
    !database ||
    typeof database.transaction !== "function" ||
    typeof database.serializableTransaction !== "function" ||
    (!owned && !diagnosticsOnly)
  ) {
    fail("DATABASE_UNAVAILABLE", "Database unavailable.", 503);
  }
  return database;
}

function requireOwnedDatabase(database) {
  const runtime = requireDatabase(database);
  if (typeof runtime.firebaseUid !== "string" || !runtime.firebaseUid) {
    fail("DATABASE_UNAVAILABLE", "Database unavailable.", 503);
  }
  return runtime;
}

async function runTransaction(database, work, { serializable = false } = {}) {
  try {
    const runtime = requireOwnedDatabase(database);
    return await (serializable
      ? runtime.serializableTransaction(work)
      : runtime.transaction(work));
  } catch (error) {
    throw asRuntimeError(error, "DATABASE_UNAVAILABLE");
  }
}

async function runDiagnosticsTransaction(database, work) {
  try {
    const runtime = requireDatabase(database);
    if (typeof runtime.diagnosticsTransaction !== "function") {
      fail("DATABASE_UNAVAILABLE", "Database unavailable.", 503);
    }
    return await runtime.diagnosticsTransaction(work);
  } catch (error) {
    throw asRuntimeError(error, "DATABASE_UNAVAILABLE");
  }
}

function queryOne(result) {
  const row = result?.rows?.[0] ?? null;
  return row;
}

async function defaultAccessToken() {
  const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
  const client = await auth.getClient();
  const result = await client.getAccessToken();
  const token = typeof result === "string" ? result : result?.token;
  if (typeof token !== "string" || !token) {
    throw new Error("Google service access token unavailable.");
  }
  return token;
}

function responseJson(response) {
  return response?.json?.().catch(() => ({})) ?? Promise.resolve({});
}

/**
 * KMS-only envelope storage for Plaid access tokens. The envelope persists
 * ciphertext plus a context hash; no plaintext token is written to Cloud SQL.
 */
export function createCloudKmsEnvelope({
  kmsKey,
  fetchImpl = globalThis.fetch,
  getAccessToken = defaultAccessToken,
} = {}) {
  if (
    typeof kmsKey !== "string" ||
    !/^projects\/hushh-tech-uat\/locations\/us-central1\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+$/.test(kmsKey) ||
    typeof fetchImpl !== "function" ||
    typeof getAccessToken !== "function"
  ) {
    throw new Error("A UAT Cloud KMS envelope configuration is required.");
  }

  async function request(action, body, signal) {
    let token;
    let response;
    try {
      token = await getAccessToken();
      if (typeof token !== "string" || !token) throw new Error("token unavailable");
      response = await fetchImpl(`${KMS_API}/${kmsKey}:${action}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      });
      const data = await responseJson(response);
      if (!response?.ok || !data || typeof data !== "object") throw new Error("kms unavailable");
      return data;
    } catch (error) {
      throw new RuntimeError(
        "TOKEN_ENVELOPE_UNAVAILABLE",
        "Financial service is unavailable.",
        503,
        { cause: error, diagnosticCode: "PLAID_KMS_ENVELOPE_UNAVAILABLE" },
      );
    }
  }

  async function seal({ plaintext, context, signal } = {}) {
    if (
      typeof plaintext !== "string" ||
      !plaintext ||
      Buffer.byteLength(plaintext, "utf8") > MAX_KMS_PLAINTEXT_BYTES ||
      !context ||
      typeof context !== "object" ||
      Array.isArray(context)
    ) {
      fail("TOKEN_ENVELOPE_UNAVAILABLE", undefined, 503, "PLAID_KMS_ENVELOPE_INPUT_INVALID");
    }
    const aad = stableBytes(context);
    const data = await request(
      "encrypt",
      {
        plaintext: Buffer.from(plaintext, "utf8").toString("base64"),
        additionalAuthenticatedData: aad.toString("base64"),
      },
      signal,
    );
    if (typeof data.ciphertext !== "string" || !data.ciphertext) {
      fail("TOKEN_ENVELOPE_UNAVAILABLE", undefined, 503, "PLAID_KMS_ENCRYPT_RESPONSE_INVALID");
    }
    const payload = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        ciphertext: data.ciphertext,
        contextHash: sha256(aad),
      }),
      "utf8",
    ).toString("base64url");
    const envelope = `${ENVELOPE_PREFIX}${payload}`;
    if (Buffer.byteLength(envelope, "utf8") > MAX_ENVELOPE_BYTES) {
      fail("TOKEN_ENVELOPE_UNAVAILABLE", undefined, 503, "PLAID_KMS_ENVELOPE_TOO_LARGE");
    }
    return envelope;
  }

  async function open({ envelope, context, signal } = {}) {
    if (
      typeof envelope !== "string" ||
      !envelope.startsWith(ENVELOPE_PREFIX) ||
      Buffer.byteLength(envelope, "utf8") > MAX_ENVELOPE_BYTES ||
      !context ||
      typeof context !== "object" ||
      Array.isArray(context)
    ) {
      fail("TOKEN_ENVELOPE_UNAVAILABLE", undefined, 503, "PLAID_KMS_ENVELOPE_INVALID");
    }
    let payload;
    try {
      payload = JSON.parse(
        Buffer.from(envelope.slice(ENVELOPE_PREFIX.length), "base64url").toString("utf8"),
      );
    } catch {
      fail("TOKEN_ENVELOPE_UNAVAILABLE", undefined, 503, "PLAID_KMS_ENVELOPE_INVALID");
    }
    const aad = stableBytes(context);
    if (
      payload?.schemaVersion !== 1 ||
      typeof payload.ciphertext !== "string" ||
      !HASH_PATTERN.test(String(payload.contextHash ?? "")) ||
      !equalBytes(
        Buffer.from(payload.contextHash, "utf8"),
        Buffer.from(sha256(aad), "utf8"),
      )
    ) {
      fail("TOKEN_ENVELOPE_UNAVAILABLE", undefined, 503, "PLAID_KMS_ENVELOPE_CONTEXT_MISMATCH");
    }
    const data = await request(
      "decrypt",
      {
        ciphertext: payload.ciphertext,
        additionalAuthenticatedData: aad.toString("base64"),
      },
      signal,
    );
    if (typeof data.plaintext !== "string") {
      fail("TOKEN_ENVELOPE_UNAVAILABLE", undefined, 503, "PLAID_KMS_DECRYPT_RESPONSE_INVALID");
    }
    let plaintext;
    try {
      const bytes = Buffer.from(data.plaintext, "base64");
      plaintext = bytes.toString("utf8");
      if (!Buffer.from(plaintext, "utf8").equals(bytes)) throw new Error("not utf8");
    } catch {
      fail("TOKEN_ENVELOPE_UNAVAILABLE", undefined, 503, "PLAID_KMS_PLAINTEXT_INVALID");
    }
    if (!plaintext || Buffer.byteLength(plaintext, "utf8") > MAX_KMS_PLAINTEXT_BYTES) {
      fail("TOKEN_ENVELOPE_UNAVAILABLE", undefined, 503, "PLAID_KMS_PLAINTEXT_INVALID");
    }
    return plaintext;
  }

  return Object.freeze({
    configured: true,
    protection: FINANCIAL_LINK_KMS_ENVELOPE_PROTECTION,
    seal,
    open,
  });
}

function rowItem(row) {
  if (!row) return null;
  return Object.freeze({
    userId: String(row.user_id),
    plaidItemId: String(row.plaid_item_id),
    accessTokenEnvelope: row.plaid_access_token_encrypted,
    institutionId: row.institution_id ?? null,
    institutionName: row.institution_name ?? null,
    status: row.status ?? null,
  });
}

function rowJob(row) {
  if (!row) return null;
  return Object.freeze({
    jobId: String(row.id),
    userId: String(row.user_id),
    firebaseUid: String(row.firebase_uid),
    plaidItemId: String(row.plaid_item_id),
    product: String(row.product),
    source: String(row.source),
    state: String(row.state),
    fenceToken: Number(row.fencing_token),
    leaseExpiresAt: row.lease_expires_at ?? null,
  });
}

function validDatabaseUuid(value) {
  return UUID_PATTERN.test(String(value ?? ""));
}

/**
 * Narrow repository used exclusively by the preserved financial-link adapter.
 * Every query is fixed SQL, caller-owned through RLS, and runs through the
 * request's Firebase context; it has no generic table/RPC escape hatch.
 */
export function createFinancialRepository({
  database,
  firebaseEmail = null,
  resolveFirebaseEmail = async () => null,
} = {}) {
  requireDatabase(database);
  if (typeof resolveFirebaseEmail !== "function") {
    throw new Error("A Firebase email resolver is required.");
  }

  const run = (work, options) => runTransaction(database, work, options);

  return Object.freeze({
    configured: true,
    async resolveFinancialPrincipal({ firebaseUid } = {}) {
      if (firebaseUid !== database.firebaseUid) {
        fail("ACCESS_DENIED", "Access denied.", 403, "FINANCIAL_PRINCIPAL_UID_MISMATCH");
      }
      return run(async (client) => {
        const result = await client.query(
          "SELECT hushh_identity.current_legacy_user_uuid() AS legacy_user_uuid",
        );
        const legacyUserUuid = String(queryOne(result)?.legacy_user_uuid ?? "").toLowerCase();
        if (!validDatabaseUuid(legacyUserUuid)) {
          fail(
            "FINANCIAL_PRINCIPAL_UNAVAILABLE",
            "Financial link is unavailable.",
            503,
            "LEGACY_UUID_PRINCIPAL_REQUIRED",
          );
        }
        return Object.freeze({ legacyUserUuid });
      });
    },

    async upsertPlaidItem(input = {}) {
      return run(async (client) => {
        const result = await client.query(
          `INSERT INTO public.plaid_items (
            user_id, plaid_item_id, plaid_access_token_encrypted,
            institution_id, institution_name, products_requested, webhook_url,
            status, error_code, error_message, updated_at
          ) VALUES (
            $1::text, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::timestamptz
          )
          ON CONFLICT (plaid_item_id) DO UPDATE SET
            plaid_access_token_encrypted = EXCLUDED.plaid_access_token_encrypted,
            institution_id = EXCLUDED.institution_id,
            institution_name = EXCLUDED.institution_name,
            products_requested = EXCLUDED.products_requested,
            webhook_url = EXCLUDED.webhook_url,
            status = EXCLUDED.status,
            error_code = EXCLUDED.error_code,
            error_message = EXCLUDED.error_message,
            updated_at = EXCLUDED.updated_at
          WHERE public.plaid_items.user_id = EXCLUDED.user_id
          RETURNING plaid_item_id`,
          [
            input.userId,
            input.plaidItemId,
            input.accessTokenEnvelope,
            input.institutionId,
            input.institutionName,
            jsonValue(input.productsRequested ?? []),
            input.webhookUrl,
            input.status,
            input.errorCode,
            input.errorMessage,
            input.updatedAt,
          ],
        );
        if (!queryOne(result)) {
          fail("ACCESS_DENIED", "Access denied.", 403, "PLAID_ITEM_OWNERSHIP_DENIED");
        }
      });
    },

    async setFinancialLinkStatus({ userId, status, updatedAt } = {}) {
      return run(async (client) => {
        const result = await client.query(
          `INSERT INTO public.onboarding_data (user_id, financial_link_status, updated_at)
           VALUES ($1::uuid, $2, $3::timestamptz)
           ON CONFLICT (user_id) DO UPDATE SET
             financial_link_status = EXCLUDED.financial_link_status,
             updated_at = EXCLUDED.updated_at
           RETURNING user_id`,
          [userId, status, updatedAt],
        );
        if (!queryOne(result)) {
          fail("ACCESS_DENIED", "Access denied.", 403, "FINANCIAL_LINK_OWNERSHIP_DENIED");
        }
      });
    },

    async upsertPlaidAccounts({ userId, plaidItemId, accounts, updatedAt } = {}) {
      return this.upsertAccounts({
        userId,
        plaidItemId,
        accounts,
        institution: {},
        updatedAt,
      });
    },

    async upsertAccounts({ plaidItemId, accounts, updatedAt } = {}) {
      const values = Array.isArray(accounts) ? accounts : [];
      if (values.length === 0) return;
      return run(async (client) => {
        for (const account of values) {
          const balances = account?.balances && typeof account.balances === "object"
            ? account.balances
            : {};
          await client.query(
            `INSERT INTO public.plaid_accounts (
              plaid_item_id, plaid_account_id, name, official_name, type,
              subtype, current_balance, available_balance, iso_currency_code,
              mask, last_synced_at, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $11::timestamptz
            )
            ON CONFLICT (plaid_account_id) DO UPDATE SET
              name = EXCLUDED.name,
              official_name = EXCLUDED.official_name,
              type = EXCLUDED.type,
              subtype = EXCLUDED.subtype,
              current_balance = EXCLUDED.current_balance,
              available_balance = EXCLUDED.available_balance,
              iso_currency_code = EXCLUDED.iso_currency_code,
              mask = EXCLUDED.mask,
              last_synced_at = EXCLUDED.last_synced_at,
              updated_at = EXCLUDED.updated_at`,
            [
              plaidItemId,
              account?.account_id ?? account?.id,
              account?.name ?? null,
              account?.official_name ?? null,
              account?.type ?? null,
              account?.subtype ?? null,
              balances.current ?? null,
              balances.available ?? null,
              balances.iso_currency_code ?? "USD",
              account?.mask ?? null,
              updatedAt ?? timestamp(),
            ],
          );
        }
      });
    },

    async getActivePlaidItem({ userId, plaidItemId = null } = {}) {
      return run(async (client) => {
        const result = await client.query(
          `SELECT user_id, plaid_item_id, plaid_access_token_encrypted,
                  institution_id, institution_name, status
             FROM public.plaid_items
            WHERE user_id = $1::text
              AND status = 'active'
              AND ($2::text IS NULL OR plaid_item_id = $2::text)
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1`,
          [userId, plaidItemId || null],
        );
        return rowItem(queryOne(result));
      });
    },

    async ensureProductStatuses({ userId, plaidItemId, products, updatedAt } = {}) {
      const list = [...new Set(Array.isArray(products) ? products : [])];
      if (list.length === 0) return;
      return run(async (client) => {
        await client.query(
          `INSERT INTO public.plaid_product_sync_statuses (
             user_id, plaid_item_id, product, status, available, attempts, updated_at
           )
           SELECT $1::uuid, $2, product, 'pending', false, 0, $4::timestamptz
             FROM unnest($3::text[]) AS product
           ON CONFLICT (user_id, plaid_item_id, product) DO NOTHING`,
          [userId, plaidItemId, list, updatedAt],
        );
      });
    },

    async upsertProductStatus(input = {}) {
      return run(async (client) => {
        await client.query(
          `INSERT INTO public.plaid_product_sync_statuses (
             user_id, plaid_item_id, product, status, available, records_count,
             error_code, error_message, request_id, attempts, started_at,
             completed_at, raw_metadata, updated_at
           ) VALUES (
             $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9,
             COALESCE($10::integer, 0), $11::timestamptz, $12::timestamptz,
             $13::jsonb, $14::timestamptz
           )
           ON CONFLICT (user_id, plaid_item_id, product) DO UPDATE SET
             status = EXCLUDED.status,
             available = EXCLUDED.available,
             records_count = EXCLUDED.records_count,
             error_code = EXCLUDED.error_code,
             error_message = EXCLUDED.error_message,
             request_id = EXCLUDED.request_id,
             attempts = CASE
               WHEN EXCLUDED.status = 'syncing' THEN public.plaid_product_sync_statuses.attempts + 1
               WHEN $10::integer IS NULL THEN public.plaid_product_sync_statuses.attempts
               ELSE EXCLUDED.attempts
             END,
             started_at = COALESCE(EXCLUDED.started_at, public.plaid_product_sync_statuses.started_at),
             completed_at = EXCLUDED.completed_at,
             raw_metadata = EXCLUDED.raw_metadata,
             updated_at = EXCLUDED.updated_at`,
          [
            input.userId,
            input.plaidItemId,
            input.product,
            input.status,
            Boolean(input.available),
            input.recordsCount ?? null,
            input.errorCode ?? null,
            input.errorMessage ?? null,
            input.requestId ?? null,
            input.attempts ?? null,
            input.startedAt ?? null,
            input.completedAt ?? null,
            jsonValue(input.rawMetadata),
            input.updatedAt,
          ],
        );
      });
    },

    async listProductStatuses({ userId, plaidItemId } = {}) {
      return run(async (client) => {
        const result = await client.query(
          `SELECT product, status, available, records_count, error_code,
                  error_message, request_id, attempts, started_at, completed_at,
                  raw_metadata, updated_at
             FROM public.plaid_product_sync_statuses
            WHERE user_id = $1::uuid AND plaid_item_id = $2
            ORDER BY created_at ASC`,
          [userId, plaidItemId],
        );
        return (result.rows ?? []).map((row) => ({
          product: row.product,
          status: row.status,
          available: Boolean(row.available),
          recordsCount: row.records_count ?? null,
          errorCode: row.error_code ?? null,
          error: row.error_message ?? null,
          requestId: row.request_id ?? null,
          rawMetadata: jsonObject(row.raw_metadata),
          updatedAt: row.updated_at ?? null,
        }));
      });
    },

    async getFinancialData({ userId } = {}) {
      return run(async (client) => {
        const result = await client.query(
          `SELECT user_id, plaid_item_id, institution_name, institution_id,
                  balances, asset_report, asset_report_token, investments,
                  available_products, status, fetch_errors, identity_data,
                  identity_match_scores, signal_prepared, auth_numbers,
                  identity_match, asset_report_status, asset_report_created_at,
                  income_data, investment_transactions, liabilities_data,
                  transactions_data, statements_data, plaid_sync_status,
                  plaid_sync_completed_at, data_sync_summary, updated_at
             FROM public.user_financial_data
            WHERE user_id = $1::uuid
            LIMIT 1`,
          [userId],
        );
        return queryOne(result);
      });
    },

    async mergeFinancialDataProduct(input = {}) {
      if (input.plaidAccessToken !== null && input.plaidAccessToken !== undefined) {
        fail("ACCESS_DENIED", "Access denied.", 403, "PLAID_PLAINTEXT_TOKEN_DENIED");
      }
      if (
        typeof input.userId !== "string" ||
        typeof input.plaidItemId !== "string" ||
        typeof input.product !== "string" ||
        !input.product ||
        typeof input.available !== "boolean" ||
        typeof input.productStatus !== "string" ||
        !input.productStatus ||
        (input.patch !== undefined && (
          !input.patch || typeof input.patch !== "object" || Array.isArray(input.patch)
        ))
      ) {
        fail("INVALID_REQUEST", "Invalid request.", 400, "FINANCIAL_PRODUCT_MERGE_INVALID");
      }
      const patch = input.patch ?? {};
      const patchJson = jsonValue(patch);
      const updatedAt = input.updatedAt ?? timestamp();
      return run(async (client) => {
        const result = await client.query(
          `INSERT INTO public.user_financial_data AS existing (
            user_id, plaid_item_id, institution_name, institution_id, balances,
            asset_report, asset_report_token, investments, available_products,
            status, fetch_errors, updated_at, identity_data,
            identity_match_scores, signal_prepared, auth_numbers, identity_match,
            asset_report_status, asset_report_created_at, income_data,
            investment_transactions, liabilities_data, transactions_data,
            statements_data, plaid_sync_status, plaid_sync_completed_at,
            data_sync_summary
          ) VALUES (
            $1::uuid, $2, $3, $4,
            CASE WHEN $10::jsonb ? 'balances' THEN $10::jsonb -> 'balances' ELSE NULL END,
            CASE WHEN $10::jsonb ? 'asset_report' THEN $10::jsonb -> 'asset_report' ELSE NULL END,
            CASE WHEN $10::jsonb ? 'asset_report_token' THEN $10::jsonb ->> 'asset_report_token' ELSE NULL END,
            CASE WHEN $10::jsonb ? 'investments' THEN $10::jsonb -> 'investments' ELSE NULL END,
            jsonb_build_object($5, $6::boolean),
            CASE WHEN $6::boolean THEN 'partial' ELSE 'failed' END,
            CASE
              WHEN $8::text IS NULL THEN NULL
              ELSE jsonb_build_object($5, jsonb_build_object('error', $8, 'error_code', $9))
            END,
            $11::timestamptz,
            CASE WHEN $10::jsonb ? 'identity_data' THEN $10::jsonb -> 'identity_data' ELSE NULL END,
            CASE WHEN $10::jsonb ? 'identity_match_scores' THEN $10::jsonb -> 'identity_match_scores' ELSE NULL END,
            CASE WHEN $10::jsonb ? 'signal_prepared' THEN ($10::jsonb ->> 'signal_prepared')::boolean ELSE NULL END,
            CASE WHEN $10::jsonb ? 'auth_numbers' THEN $10::jsonb -> 'auth_numbers' ELSE NULL END,
            CASE WHEN $10::jsonb ? 'identity_match' THEN $10::jsonb -> 'identity_match' ELSE NULL END,
            CASE WHEN $10::jsonb ? 'asset_report_status' THEN $10::jsonb ->> 'asset_report_status' ELSE NULL END,
            CASE WHEN $10::jsonb ? 'asset_report_created_at' THEN ($10::jsonb ->> 'asset_report_created_at')::timestamptz ELSE NULL END,
            CASE WHEN $10::jsonb ? 'income_data' THEN $10::jsonb -> 'income_data' ELSE NULL END,
            CASE WHEN $10::jsonb ? 'investment_transactions' THEN $10::jsonb -> 'investment_transactions' ELSE NULL END,
            CASE WHEN $10::jsonb ? 'liabilities_data' THEN $10::jsonb -> 'liabilities_data' ELSE NULL END,
            CASE WHEN $10::jsonb ? 'transactions_data' THEN $10::jsonb -> 'transactions_data' ELSE NULL END,
            CASE WHEN $10::jsonb ? 'statements_data' THEN $10::jsonb -> 'statements_data' ELSE NULL END,
            CASE WHEN $6::boolean THEN 'partial' ELSE 'failed' END,
            $11::timestamptz,
            jsonb_build_object(
              'products_available', CASE WHEN $6::boolean THEN 1 ELSE 0 END,
              'last_product_synced', $5,
              'last_product_status', $7
            )
          )
          ON CONFLICT (user_id) DO UPDATE SET
            plaid_item_id = EXCLUDED.plaid_item_id,
            institution_name = EXCLUDED.institution_name,
            institution_id = EXCLUDED.institution_id,
            balances = CASE WHEN $10::jsonb ? 'balances' THEN $10::jsonb -> 'balances' ELSE existing.balances END,
            asset_report = CASE WHEN $10::jsonb ? 'asset_report' THEN $10::jsonb -> 'asset_report' ELSE existing.asset_report END,
            asset_report_token = CASE WHEN $10::jsonb ? 'asset_report_token' THEN $10::jsonb ->> 'asset_report_token' ELSE existing.asset_report_token END,
            investments = CASE WHEN $10::jsonb ? 'investments' THEN $10::jsonb -> 'investments' ELSE existing.investments END,
            available_products = COALESCE(existing.available_products, '{}'::jsonb) || jsonb_build_object($5, $6::boolean),
            status = CASE
              WHEN (SELECT count(*) FROM jsonb_each_text(COALESCE(existing.available_products, '{}'::jsonb) || jsonb_build_object($5, $6::boolean)) AS available(product, value) WHERE available.value = 'true') >= 5 THEN 'complete'
              WHEN (SELECT count(*) FROM jsonb_each_text(COALESCE(existing.available_products, '{}'::jsonb) || jsonb_build_object($5, $6::boolean)) AS available(product, value) WHERE available.value = 'true') > 0 THEN 'partial'
              ELSE 'failed'
            END,
            fetch_errors = CASE
              WHEN $8::text IS NULL THEN NULLIF(COALESCE(existing.fetch_errors, '{}'::jsonb) - $5, '{}'::jsonb)
              ELSE COALESCE(existing.fetch_errors, '{}'::jsonb) || jsonb_build_object($5, jsonb_build_object('error', $8, 'error_code', $9))
            END,
            updated_at = $11::timestamptz,
            identity_data = CASE WHEN $10::jsonb ? 'identity_data' THEN $10::jsonb -> 'identity_data' ELSE existing.identity_data END,
            identity_match_scores = CASE WHEN $10::jsonb ? 'identity_match_scores' THEN $10::jsonb -> 'identity_match_scores' ELSE existing.identity_match_scores END,
            signal_prepared = CASE WHEN $10::jsonb ? 'signal_prepared' THEN ($10::jsonb ->> 'signal_prepared')::boolean ELSE existing.signal_prepared END,
            auth_numbers = CASE WHEN $10::jsonb ? 'auth_numbers' THEN $10::jsonb -> 'auth_numbers' ELSE existing.auth_numbers END,
            identity_match = CASE WHEN $10::jsonb ? 'identity_match' THEN $10::jsonb -> 'identity_match' ELSE existing.identity_match END,
            asset_report_status = CASE WHEN $10::jsonb ? 'asset_report_status' THEN $10::jsonb ->> 'asset_report_status' ELSE existing.asset_report_status END,
            asset_report_created_at = CASE WHEN $10::jsonb ? 'asset_report_created_at' THEN ($10::jsonb ->> 'asset_report_created_at')::timestamptz ELSE existing.asset_report_created_at END,
            income_data = CASE WHEN $10::jsonb ? 'income_data' THEN $10::jsonb -> 'income_data' ELSE existing.income_data END,
            investment_transactions = CASE WHEN $10::jsonb ? 'investment_transactions' THEN $10::jsonb -> 'investment_transactions' ELSE existing.investment_transactions END,
            liabilities_data = CASE WHEN $10::jsonb ? 'liabilities_data' THEN $10::jsonb -> 'liabilities_data' ELSE existing.liabilities_data END,
            transactions_data = CASE WHEN $10::jsonb ? 'transactions_data' THEN $10::jsonb -> 'transactions_data' ELSE existing.transactions_data END,
            statements_data = CASE WHEN $10::jsonb ? 'statements_data' THEN $10::jsonb -> 'statements_data' ELSE existing.statements_data END,
            plaid_sync_status = CASE
              WHEN (SELECT count(*) FROM jsonb_each_text(COALESCE(existing.available_products, '{}'::jsonb) || jsonb_build_object($5, $6::boolean)) AS available(product, value) WHERE available.value = 'true') >= 5 THEN 'complete'
              WHEN (SELECT count(*) FROM jsonb_each_text(COALESCE(existing.available_products, '{}'::jsonb) || jsonb_build_object($5, $6::boolean)) AS available(product, value) WHERE available.value = 'true') > 0 THEN 'partial'
              ELSE 'failed'
            END,
            plaid_sync_completed_at = $11::timestamptz,
            data_sync_summary = jsonb_build_object(
              'products_available', (SELECT count(*) FROM jsonb_each_text(COALESCE(existing.available_products, '{}'::jsonb) || jsonb_build_object($5, $6::boolean)) AS available(product, value) WHERE available.value = 'true'),
              'last_product_synced', $5,
              'last_product_status', $7
            )
          RETURNING available_products, fetch_errors, status, plaid_sync_status, data_sync_summary`,
          [
            input.userId,
            input.plaidItemId,
            input.institutionName ?? null,
            input.institutionId ?? null,
            input.product,
            input.available,
            input.productStatus,
            input.error ?? null,
            input.errorCode ?? null,
            patchJson,
            updatedAt,
          ],
        );
        return queryOne(result);
      }, { serializable: true });
    },

    async tryAcquireSyncLock({ plaidItemId, startedAt, cutoffAt } = {}) {
      return run(async (client) => {
        const result = await client.query(
          `UPDATE public.plaid_items
              SET last_sync_started_at = $2::timestamptz,
                  updated_at = $2::timestamptz
            WHERE plaid_item_id = $1
              AND (last_sync_started_at IS NULL OR last_sync_started_at < $3::timestamptz)
          RETURNING plaid_item_id`,
          [plaidItemId, startedAt, cutoffAt],
        );
        return Boolean(queryOne(result));
      });
    },

    async touchPlaidItemSync({ plaidItemId, syncedAt, updatedAt } = {}) {
      return run(async (client) => {
        await client.query(
          `UPDATE public.plaid_items
              SET last_data_sync_at = $2::timestamptz,
                  updated_at = $3::timestamptz
            WHERE plaid_item_id = $1`,
          [plaidItemId, syncedAt, updatedAt],
        );
      });
    },

    async getSyncCursor({ plaidItemId, product } = {}) {
      return run(async (client) => {
        const result = await client.query(
          `SELECT cursor, last_synced_at, updated_at
             FROM public.plaid_sync_cursors
            WHERE plaid_item_id = $1 AND product = $2
            LIMIT 1`,
          [plaidItemId, product],
        );
        return queryOne(result);
      });
    },

    async upsertSyncCursor({ plaidItemId, product, cursor, syncedAt, updatedAt } = {}) {
      return run(async (client) => {
        await client.query(
          `INSERT INTO public.plaid_sync_cursors (
             plaid_item_id, product, cursor, last_synced_at, updated_at
           ) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)
           ON CONFLICT (plaid_item_id, product) DO UPDATE SET
             cursor = EXCLUDED.cursor,
             last_synced_at = EXCLUDED.last_synced_at,
             updated_at = EXCLUDED.updated_at`,
          [plaidItemId, product, cursor, syncedAt, updatedAt],
        );
      });
    },

    async upsertTransactions({ transactions } = {}) {
      const rows = Array.isArray(transactions) ? transactions : [];
      if (rows.length === 0) return;
      return run(async (client) => {
        const values = [];
        const tuples = rows.map((transaction, index) => {
          const start = index * 12;
          const category = Array.isArray(transaction?.category) ? transaction.category : null;
          values.push(
            transaction?.account_id,
            transaction?.transaction_id,
            transaction?.amount,
            transaction?.iso_currency_code ?? "USD",
            transaction?.date,
            transaction?.name ?? null,
            transaction?.merchant_name ?? null,
            category,
            Boolean(transaction?.pending),
            transaction?.payment_channel ?? null,
            transaction?.transaction_type ?? null,
            jsonValue(transaction?.location ?? null),
          );
          return `($${start + 1}, $${start + 2}, $${start + 3}, $${start + 4}, $${start + 5}::date, $${start + 6}, $${start + 7}, $${start + 8}::text[], $${start + 9}, $${start + 10}, $${start + 11}, $${start + 12}::jsonb)`;
        });
        await client.query(
          `INSERT INTO public.plaid_transactions (
             plaid_account_id, plaid_transaction_id, amount, iso_currency_code,
             date, name, merchant_name, category, pending, payment_channel,
             transaction_type, location
           ) VALUES ${tuples.join(",")}
           ON CONFLICT (plaid_transaction_id) DO UPDATE SET
             plaid_account_id = EXCLUDED.plaid_account_id,
             amount = EXCLUDED.amount,
             iso_currency_code = EXCLUDED.iso_currency_code,
             date = EXCLUDED.date,
             name = EXCLUDED.name,
             merchant_name = EXCLUDED.merchant_name,
             category = EXCLUDED.category,
             pending = EXCLUDED.pending,
             payment_channel = EXCLUDED.payment_channel,
             transaction_type = EXCLUDED.transaction_type,
             location = EXCLUDED.location`,
          values,
        );
      });
    },

    async deleteTransactions({ transactionIds } = {}) {
      const ids = [...new Set(Array.isArray(transactionIds) ? transactionIds.filter(Boolean) : [])];
      if (ids.length === 0) return;
      return run(async (client) => {
        await client.query(
          "DELETE FROM public.plaid_transactions WHERE plaid_transaction_id = ANY($1::text[])",
          [ids],
        );
      });
    },

    async upsertStatementMetadata({ userId, plaidItemId, plaidAccountId, statement, updatedAt } = {}) {
      return run(async (client) => {
        await client.query(
          `INSERT INTO public.plaid_statement_metadata (
             user_id, plaid_item_id, plaid_account_id, statement_id,
             statement_date, period_start, period_end, status, metadata, updated_at
           ) VALUES (
             $1::uuid, $2, $3, $4, $5::date, $6::date, $7::date, 'available', $8::jsonb, $9::timestamptz
           )
           ON CONFLICT (user_id, statement_id) DO UPDATE SET
             plaid_item_id = EXCLUDED.plaid_item_id,
             plaid_account_id = EXCLUDED.plaid_account_id,
             statement_date = EXCLUDED.statement_date,
             period_start = EXCLUDED.period_start,
             period_end = EXCLUDED.period_end,
             status = EXCLUDED.status,
             metadata = EXCLUDED.metadata,
             updated_at = EXCLUDED.updated_at`,
          [
            userId,
            plaidItemId,
            plaidAccountId ?? null,
            statement?.statement_id,
            statement?.statement_date ?? null,
            statement?.period_start_date ?? null,
            statement?.period_end_date ?? null,
            jsonValue(statement ?? {}),
            updatedAt,
          ],
        );
      });
    },

    async getIdentityMatchUser() {
      return run(async (client) => {
        const result = await client.query(
          `SELECT legal_first_name, legal_last_name, phone_country_code,
                  phone_number, address_line_1, address_line_2, city, state,
                  zip_code, address_country
             FROM public.onboarding_data
            WHERE user_id = hushh_identity.current_legacy_user_uuid()
            LIMIT 1`,
        );
        const onboarding = queryOne(result) ?? {};
        let emailAddress = safeEmail(firebaseEmail);
        if (!emailAddress) {
          try {
            emailAddress = safeEmail(await resolveFirebaseEmail(database.firebaseUid));
          } catch {
            emailAddress = null;
          }
        }
        const legalName = [onboarding.legal_first_name, onboarding.legal_last_name]
          .map((part) => safeText(part, 256))
          .filter(Boolean)
          .join(" ")
          .trim() || null;
        const rawPhone = `${onboarding.phone_country_code ?? ""}${onboarding.phone_number ?? ""}`
          .replace(/[^\d+]/g, "");
        const phoneNumber = rawPhone.length >= 7
          ? rawPhone.startsWith("+") ? rawPhone : `+${rawPhone}`
          : null;
        const addressLine = safeText(onboarding.address_line_1, 256);
        const address = addressLine
          ? {
              street: [addressLine, safeText(onboarding.address_line_2, 256)]
                .filter(Boolean)
                .join(" "),
              ...(safeText(onboarding.city, 128) ? { city: safeText(onboarding.city, 128) } : {}),
              ...(safeText(onboarding.state, 64) ? { region: safeText(onboarding.state, 64) } : {}),
              ...(safeText(onboarding.zip_code, 32) ? { postal_code: safeText(onboarding.zip_code, 32) } : {}),
              country: safeText(onboarding.address_country, 2) || "US",
            }
          : null;
        return Object.freeze({ legalName, emailAddress, phoneNumber, address });
      });
    },

    async insertPlaidDiagnostic(input = {}) {
      const insert = async (client) => {
        await client.query(
          `INSERT INTO public.plaid_link_diagnostics (
             user_id, session_id, event_type, plaid_step, page_state,
             plaid_metadata, error_details, browser_context
           ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)`,
          [
            input.userId ?? null,
            input.sessionId ?? null,
            input.eventType,
            input.plaidStep,
            jsonValue(input.pageState ?? {}),
            jsonValue(input.plaidMetadata ?? {}),
            jsonValue(input.errorDetails ?? {}),
            jsonValue(input.browserContext ?? {}),
          ],
        );
      };
      return input.userId == null
        ? runDiagnosticsTransaction(database, insert)
        : run(insert);
    },

    async verifyQueuedProductSyncJob({ job, legacyUserUuid, plaidItemId, product } = {}) {
      const jobId = parseUuid(job?.jobId, "FINANCIAL_JOB_ID_INVALID");
      const fenceToken = Number(job?.fenceToken);
      if (!Number.isSafeInteger(fenceToken) || fenceToken < 1) return false;
      return run(async (client) => {
        const result = await client.query(
          `SELECT id
             FROM hushh_financial.sync_jobs
            WHERE id = $1::uuid
              AND user_id = $2::uuid
              AND firebase_uid = $3
              AND plaid_item_id = $4
              AND product = $5
              AND state = 'LEASED'
              AND fencing_token = $6::bigint
              AND lease_expires_at > clock_timestamp()
            LIMIT 1`,
          [jobId, legacyUserUuid, database.firebaseUid, plaidItemId, product, fenceToken],
        );
        return Boolean(queryOne(result));
      });
    },
  });
}

function taskErrorCode(error) {
  if (error instanceof RuntimeError) return error.code;
  return "CLOUD_TASKS_UNAVAILABLE";
}

/**
 * Cloud SQL outbox + Cloud Tasks publisher. The service writes each job and
 * its deterministic task intent before the external call, then the worker
 * claims the job with a fence before it ever asks KMS to decrypt an item.
 */
export function createCloudTasksSyncQueue({
  config,
  database,
  fetchImpl = globalThis.fetch,
  getAccessToken = defaultAccessToken,
  now = Date.now,
  jobLeaseMs = SYNC_JOB_LEASE_MS,
} = {}) {
  const financial = assertConfigured(config);
  requireDatabase(database);
  if (
    typeof fetchImpl !== "function" ||
    typeof getAccessToken !== "function" ||
    typeof now !== "function" ||
    !Number.isSafeInteger(jobLeaseMs) ||
    jobLeaseMs < 10_000 ||
    jobLeaseMs > 300_000
  ) {
    throw new Error("Cloud Tasks financial sync configuration is required.");
  }
  const taskPublisher = createFinancialSyncTaskPublisher({
    taskQueue: financial.taskQueue,
    workerAudience: financial.workerAudience,
    taskRunnerServiceAccount: financial.taskRunnerServiceAccount,
    fetchImpl,
    getAccessToken,
  });

  async function insertJob({ userId, firebaseUid, plaidItemId, product, source, withOutbox }) {
    return runTransaction(
      database,
      async (client) => {
        const inserted = await client.query(
          `INSERT INTO hushh_financial.sync_jobs (
             user_id, firebase_uid, plaid_item_id, product, source, state, updated_at
           ) VALUES ($1::uuid, $2, $3, $4, $5, 'PENDING', clock_timestamp())
           ON CONFLICT DO NOTHING
           RETURNING id, user_id, firebase_uid, plaid_item_id, product, source,
                     state, fencing_token, lease_expires_at`,
          [userId, firebaseUid, plaidItemId, product, source],
        );
        let job = rowJob(queryOne(inserted));
        if (!job) {
          const existing = await client.query(
            `SELECT id, user_id, firebase_uid, plaid_item_id, product, source,
                    state, fencing_token, lease_expires_at
               FROM hushh_financial.sync_jobs
              WHERE user_id = $1::uuid AND plaid_item_id = $2
                AND product = $3 AND source = $4
                AND state IN ('PENDING', 'LEASED')
              ORDER BY updated_at DESC
              LIMIT 1
              FOR UPDATE`,
            [userId, plaidItemId, product, source],
          );
          job = rowJob(queryOne(existing));
        }
        if (!job || job.firebaseUid !== firebaseUid) {
          fail("ACCESS_DENIED", "Access denied.", 403, "FINANCIAL_SYNC_JOB_OWNERSHIP_DENIED");
        }
        if (!withOutbox) return job;
        const name = financialSyncTaskName(financial.taskQueue, job.jobId);
        await client.query(
          `INSERT INTO hushh_financial.sync_outbox (job_id, task_name, state, updated_at)
           VALUES ($1::uuid, $2, 'PENDING', clock_timestamp())
           ON CONFLICT (job_id) DO NOTHING`,
          [job.jobId, name],
        );
        return Object.freeze({ ...job, taskName: name });
      },
      { serializable: true },
    );
  }

  async function pendingOutbox(jobId) {
    return runTransaction(database, async (client) => {
      const result = await client.query(
        `SELECT outbox.job_id, outbox.task_name, job.firebase_uid
           FROM hushh_financial.sync_outbox AS outbox
           INNER JOIN hushh_financial.sync_jobs AS job ON job.id = outbox.job_id
          WHERE outbox.job_id = $1::uuid AND outbox.state = 'PENDING'
          LIMIT 1`,
        [jobId],
      );
      const row = queryOne(result);
      return row
        ? Object.freeze({
            jobId: String(row.job_id),
            taskName: String(row.task_name),
            firebaseUid: String(row.firebase_uid),
          })
        : null;
    });
  }

  async function markPublished(jobId) {
    return runTransaction(database, async (client) => {
      await client.query(
        `UPDATE hushh_financial.sync_outbox
            SET state = 'PUBLISHED', attempts = attempts + 1,
                last_error_code = NULL, published_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE job_id = $1::uuid AND state = 'PENDING'`,
        [jobId],
      );
    }, { serializable: true });
  }

  async function markPublishFailure(jobId, error) {
    try {
      await runTransaction(database, async (client) => {
        await client.query(
          `UPDATE hushh_financial.sync_outbox
              SET attempts = attempts + 1, last_error_code = $2,
                  updated_at = clock_timestamp()
            WHERE job_id = $1::uuid AND state = 'PENDING'`,
          [jobId, taskErrorCode(error)],
        );
      }, { serializable: true });
    } catch {
      // Preserve the publisher error. The outbox record remains PENDING.
    }
  }

  async function dispatchJob(job, signal) {
    const outbox = await pendingOutbox(job.jobId);
    if (!outbox) return;
    try {
      await taskPublisher.publish({ ...outbox, signal });
      await markPublished(outbox.jobId);
    } catch (error) {
      await markPublishFailure(outbox.jobId, error);
      throw error;
    }
  }

  function backgroundProductPosition(product) {
    return PLAID_BACKGROUND_PRODUCTS.indexOf(product);
  }

  function firstBackgroundJob(jobs) {
    const ordered = [...(Array.isArray(jobs) ? jobs : [])]
      .filter((job) => backgroundProductPosition(job?.product) >= 0)
      .sort((left, right) => (
        backgroundProductPosition(left.product) - backgroundProductPosition(right.product)
      ));
    return ordered[0] ?? null;
  }

  async function nextBackgroundJob(job) {
    if (
      !job ||
      !["plaid-data-sync-start", "plaid-data-sync"].includes(job.source) ||
      backgroundProductPosition(job.product) < 0
    ) {
      return null;
    }
    return runTransaction(database, async (client) => {
      // The source Edge function runs this exact product list serially in its
      // background promise.  Persist every intent first, but publish only the
      // successor after this job completes so Cloud Tasks cannot run separate
      // products concurrently for one Plaid item.
      const result = await client.query(
        `SELECT id, user_id, firebase_uid, plaid_item_id, product, source,
                state, fencing_token, lease_expires_at
           FROM hushh_financial.sync_jobs
          WHERE user_id = $1::uuid
            AND firebase_uid = $2
            AND plaid_item_id = $3
            AND source = $4
            AND state = 'PENDING'
            AND array_position($5::text[], product) > array_position($5::text[], $6::text)
          ORDER BY array_position($5::text[], product), updated_at, id
          LIMIT 1
          FOR UPDATE`,
        [
          job.userId,
          job.firebaseUid,
          job.plaidItemId,
          job.source,
          PLAID_BACKGROUND_PRODUCTS,
          job.product,
        ],
      );
      return rowJob(queryOne(result));
    }, { serializable: true });
  }

  async function claimJob({ jobId, firebaseUid }) {
    const normalizedJobId = parseUuid(jobId, "FINANCIAL_JOB_ID_INVALID");
    if (firebaseUid !== database.firebaseUid) {
      fail("ACCESS_DENIED", "Access denied.", 403, "FINANCIAL_SYNC_WORKER_UID_MISMATCH");
    }
    return runTransaction(
      database,
      async (client) => {
        const claimed = await client.query(
          `UPDATE hushh_financial.sync_jobs
              SET state = 'LEASED', attempts = attempts + 1,
                  fencing_token = fencing_token + 1,
                  lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
                  last_error_code = NULL, updated_at = clock_timestamp()
            WHERE id = $1::uuid
              AND firebase_uid = $2
              AND (
                state = 'PENDING'
                OR (state = 'LEASED' AND lease_expires_at <= clock_timestamp())
              )
          RETURNING id, user_id, firebase_uid, plaid_item_id, product, source,
                    state, fencing_token, lease_expires_at`,
          [normalizedJobId, firebaseUid, jobLeaseMs],
        );
        const job = rowJob(queryOne(claimed));
        if (!job) {
          const existing = await client.query(
            `SELECT state
               FROM hushh_financial.sync_jobs
              WHERE id = $1::uuid AND firebase_uid = $2
              LIMIT 1`,
            [normalizedJobId, firebaseUid],
          );
          const state = queryOne(existing)?.state;
          if (state === "COMPLETED") return null;
          fail("FINANCIAL_SYNC_IN_PROGRESS", "Financial sync is in progress.", 409);
        }
        return job;
      },
      { serializable: true },
    );
  }

  async function completeJob({ job, error = null } = {}) {
    return runTransaction(database, async (client) => {
      const result = await client.query(
        `UPDATE hushh_financial.sync_jobs
            SET state = 'COMPLETED', lease_expires_at = NULL,
                last_error_code = $3, updated_at = clock_timestamp()
          WHERE id = $1::uuid AND state = 'LEASED'
            AND fencing_token = $2::bigint
          RETURNING id`,
        [job?.jobId, job?.fenceToken, error ? taskErrorCode(error) : null],
      );
      if (!queryOne(result)) {
        fail("FINANCIAL_SYNC_IN_PROGRESS", "Financial sync is in progress.", 409);
      }
    }, { serializable: true });
  }

  async function completeQueuedProductSyncJob({
    job,
    signal,
    advance = true,
    error = null,
  } = {}) {
    await completeJob({ job, error });
    // The source background loop stops at its first unexpected rejection.
    // A queued replacement records the terminal job but deliberately does not
    // dispatch a later product in that case; it is not an application-level
    // retry or replay mechanism.
    if (advance !== true) return;
    const next = await nextBackgroundJob(job);
    if (!next) return;
    try {
      await dispatchJob(next, signal);
    } catch {
      // The successor's durable outbox row remains PENDING.  Do not turn a
      // completed product back into a replay merely because its later
      // source-equivalent background successor could not be published now.
    }
  }

  return Object.freeze({
    configured: true,
    async enqueueProducts({ firebaseUid, userId, plaidItemId, products, source, signal } = {}) {
      if (
        firebaseUid !== database.firebaseUid ||
        !["plaid-data-sync-start", "plaid-data-sync"].includes(source)
      ) {
        fail("ACCESS_DENIED", "Access denied.", 403, "FINANCIAL_SYNC_QUEUE_OWNERSHIP_DENIED");
      }
      const jobs = [];
      for (const product of [...new Set(Array.isArray(products) ? products : [])]) {
        jobs.push(await insertJob({
          userId,
          firebaseUid,
          plaidItemId,
          product,
          source,
          withOutbox: true,
        }));
      }
      return Object.freeze(jobs);
    },
    async publishProducts({ jobs, signal } = {}) {
      const first = firstBackgroundJob(jobs);
      if (first) await dispatchJob(first, signal);
    },
    claimQueuedProductSyncJob: claimJob,
    completeQueuedProductSyncJob,
  });
}

function plaidEnvironment(config) {
  const financial = assertConfigured(config);
  return Object.freeze({
    PLAID_CLIENT_ID: financial.plaidClientId,
    PLAID_SECRET: financial.plaidSecret,
    PLAID_ENV: financial.plaidEnvironment,
    PLAID_PRIMARY_PRODUCTS: financial.plaidPrimaryProducts,
    ...(financial.plaidAdditionalConsentedProducts
      ? {
          PLAID_ADDITIONAL_CONSENTED_PRODUCTS:
            financial.plaidAdditionalConsentedProducts,
        }
      : {}),
    ...(financial.plaidRequiredIfSupportedProducts
      ? {
          PLAID_REQUIRED_IF_SUPPORTED_PRODUCTS:
            financial.plaidRequiredIfSupportedProducts,
        }
      : {}),
  });
}

function requireWorkerActor(actor) {
  if (
    actor?.kind !== "google-service" ||
    typeof actor.email !== "string" ||
    !actor.email ||
    typeof actor.subject !== "string" ||
    !actor.subject
  ) {
    fail("ACCESS_DENIED", "Access denied.", 403, "FINANCIAL_WORKER_IDENTITY_REQUIRED");
  }
  return actor;
}

/**
 * Builds the concrete GCP boundary for one authenticated financial request.
 *
 * This factory deliberately owns no public path, registry state, or deploy
 * switch. `runtime-handlers.js` may construct it only for the existing
 * financial-api/worker services after the registry's normal P&V transition.
 * The returned methods use the existing compatibility slugs and source
 * response shapes; all provider credentials remain in private service memory.
 */
export function createFinancialLinkRuntime({
  config,
  database,
  actor = null,
  fetchImpl = globalThis.fetch,
  getAccessToken = defaultAccessToken,
  firebaseAuth = null,
  now = Date.now,
} = {}) {
  const financial = assertConfigured(config);
  requireDatabase(database);
  if (typeof fetchImpl !== "function" || typeof getAccessToken !== "function") {
    throw new Error("Financial runtime network boundaries are required.");
  }

  const auth = firebaseAuth ?? createFirebaseAdminAuth(config.firebaseProjectId);
  if (typeof auth?.getUser !== "function") {
    throw new Error("Financial runtime Firebase authority is required.");
  }
  const resolveFirebaseEmail = async (firebaseUid) => {
    const account = await auth.getUser(firebaseUid);
    return safeEmail(account?.email);
  };
  const repository = createFinancialRepository({
    database,
    firebaseEmail: actor?.kind === "firebase" ? actor.email : null,
    resolveFirebaseEmail,
  });
  const tokenEnvelope = createCloudKmsEnvelope({
    kmsKey: financial.kmsKey,
    fetchImpl,
    getAccessToken,
  });
  const syncQueue = createCloudTasksSyncQueue({
    config,
    database,
    fetchImpl,
    getAccessToken,
    now,
  });
  const plaid = createPlaidHttpClient({
    config: readPlaidConfiguration(plaidEnvironment(config)),
    fetchImpl,
  });
  const financialLinkAdapter = createFinancialLinkAdapter({
    plaid,
    repository,
    tokenEnvelope,
    syncQueue,
    allowedRedirectOrigins: [financial.allowedRedirectOrigin],
    now,
  });

  async function queuedProductSync({
    actor: workerActor,
    request,
    database: requestDatabase,
    signal,
  } = {}) {
    requireWorkerActor(workerActor);
    if (requestDatabase !== undefined && requestDatabase !== database) {
      fail("ACCESS_DENIED", "Access denied.", 403, "FINANCIAL_WORKER_DATABASE_CONTEXT_MISMATCH");
    }
    const jobId = parseUuid(request?.body?.jobId, "FINANCIAL_JOB_ID_INVALID");
    const job = await syncQueue.claimQueuedProductSyncJob({
      jobId,
      firebaseUid: database.firebaseUid,
    });
    // A duplicate Cloud Tasks delivery after completion is a successful
    // acknowledgement. It never reaches KMS or Plaid again.
    if (job === null) return Object.freeze({ completed: true });
    if (
      job.firebaseUid !== database.firebaseUid ||
      !validDatabaseUuid(job.userId) ||
      typeof job.plaidItemId !== "string" ||
      !job.plaidItemId ||
      typeof job.product !== "string" ||
      !job.product
    ) {
      await syncQueue.completeQueuedProductSyncJob({
        job,
        error: new RuntimeError("ACCESS_DENIED", "Access denied.", 403),
        advance: false,
      });
      fail("ACCESS_DENIED", "Access denied.", 403, "FINANCIAL_SYNC_JOB_BINDING_INVALID");
    }
    try {
      const result = await financialLinkAdapter.syncProduct({
        legacyUserUuid: job.userId,
        itemId: job.plaidItemId,
        product: job.product,
        job,
        signal,
      });
      await syncQueue.completeQueuedProductSyncJob({ job, result, signal });
      return Object.freeze({ completed: true });
    } catch (error) {
      await syncQueue.completeQueuedProductSyncJob({
        job,
        error,
        signal,
        advance: false,
      });
      return Object.freeze({ completed: true });
    }
  }

  return Object.freeze({
    configured: true,
    financialLinkAdapter,
    queuedProductSync,
  });
}
