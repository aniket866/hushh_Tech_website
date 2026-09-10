import { Connector } from "@google-cloud/cloud-sql-connector";
import { Storage } from "@google-cloud/storage";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import pg from "pg";

const { Pool } = pg;

export const TABLE_OPERATIONS = Object.freeze({
  agent_profiles: ["select", "insert", "update", "delete"],
  agent_reviews: ["select", "insert", "update", "delete"],
  analytics_events: ["select", "insert", "delete"],
  app_config: ["select", "upsert"],
  blocked_agents: ["select", "insert", "delete"],
  ceo_meeting_payments: ["select", "insert", "update", "delete"],
  community_registrations: ["select", "insert", "update", "delete"],
  consents: ["select", "insert", "update", "delete"],
  consumer_profiles: ["select", "insert", "update", "delete"],
  conversations: ["select", "insert", "update", "delete"],
  delete_requests: ["select", "insert", "update", "delete"],
  devices: ["select", "insert", "update", "delete"],
  fund_investment_plans: ["select", "insert", "update", "delete"],
  fund_payment_notifications: ["select", "insert", "update", "delete"],
  fund_payment_reviews: ["select", "insert", "update", "delete"],
  fund_recurring_transfers: ["select", "insert", "update", "delete"],
  fund_stripe_events: ["select", "insert", "update", "delete"],
  fund_stripe_payment_requests: ["select", "insert", "update", "delete"],
  fund_stripe_payments: ["select", "insert", "update", "delete"],
  fund_stripe_subscriptions: ["select", "insert", "update", "delete"],
  fund_transfers: ["select", "insert", "update", "delete"],
  investor_profiles: ["select", "insert", "update", "upsert", "delete"],
  kyc_profiles: ["select", "insert", "update", "delete"],
  lead_events: ["select", "insert", "update", "delete"],
  lead_requests: ["select", "insert", "update", "delete"],
  messages: ["select", "insert", "update", "delete"],
  // Consent mutations must pass the explicit NDA validator, not generic DML.
  nda_signatures: ["select"],
  notifications: ["select", "insert", "update", "delete"],
  onboarding_data: ["select", "insert", "update", "upsert", "delete"],
  onboarding_invites: ["select", "insert", "update", "upsert", "delete"],
  onboarding_parties: ["select", "insert", "update", "upsert", "delete"],
  plaid_accounts: ["select", "insert", "update", "delete"],
  plaid_data_events: ["select", "insert", "update", "delete"],
  plaid_items: ["select", "insert", "update", "delete"],
  plaid_link_diagnostics: ["select", "insert", "update", "delete"],
  plaid_product_sync_statuses: ["select", "insert", "update", "upsert", "delete"],
  plaid_statement_metadata: ["select", "insert", "update", "delete"],
  plaid_sync_cursors: ["select", "insert", "update", "delete"],
  plaid_transactions: ["select", "insert", "update", "delete"],
  site_analytics_events: ["select", "insert", "delete"],
  site_analytics_sessions: ["select", "insert", "update", "delete"],
  swipe_actions: ["select", "insert", "delete"],
  transfer_email_notifications: ["select", "insert", "delete"],
  user_agent_selections: ["select", "insert", "update", "delete"],
  user_enriched_profiles: ["select", "insert", "update", "upsert", "delete"],
  user_financial_data: ["select", "insert", "update", "upsert", "delete"],
  user_product_usage: ["select", "insert", "update", "upsert", "delete"],
  users: ["select", "insert", "update", "upsert", "delete"],
});

export const RPC_NAMES = new Set([
]);

export const BLOCKED_TABLES = new Set([
  "hushh_ai_chats",
  "hushh_ai_media_limits",
  "hushh_ai_messages",
  "hushh_ai_users",
  "identity_verifications",
  "intelligence_conversations",
  "intelligence_media_limits",
  "intelligence_messages",
  "intelligence_users",
  "plaid_transfer_accounts",
]);

export const BLOCKED_RPCS = new Set([
  "check_user_nda_status",
  "sign_global_nda",
  "track_product_usage",
]);

export const STORAGE_BUCKETS = new Set([
  "community-uploads",
  "hushh-agent-profile-images",
  "hushh-gamma-pdf",
  "wa-evidence",
  "alohafundsreport-images",
  "alohafundsreport-videos",
]);

export const BLOCKED_STORAGE_BUCKETS = new Set(["assets", "hushh-ai-media"]);

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const TARGET_PROJECT = "hushh-tech-uat";
const TARGET_INSTANCE = "hushh-tech-uat:us-central1:hushh-tech-app-pg-uat";
const TARGET_DATABASE = "hushh_tech_app";
const TARGET_DATABASE_USER = "hushh-tech-web-uat@hushh-tech-uat.iam";
const TARGET_STORAGE_PREFIX = "hushh-tech-uat";
const MAX_FILTERS = 32;
const MAX_IN_VALUES = 1_000;
const MAX_MUTATION_ROWS = 100;
const MAX_MUTATION_COLUMNS = 128;
const MAX_RPC_ARGUMENTS = 64;
let connector;
let pool;

export function runtimeConfig(env = process.env) {
  if (env.GCP_DATA_RUNTIME_ENABLED !== "true") {
    throw Object.assign(new Error("GCP data runtime is not enabled."), { status: 503, code: "GCP_DATA_DISABLED" });
  }
  const declaredProjects = [env.GOOGLE_CLOUD_PROJECT, env.GCP_PROJECT]
    .map((value) => value?.trim())
    .filter(Boolean);
  if (!declaredProjects.length || declaredProjects.some((project) => project !== TARGET_PROJECT)) {
    throw Object.assign(new Error("GCP data runtime is UAT-only."), { status: 503, code: "GCP_TARGET_MISMATCH" });
  }
  const instanceConnectionName = env.CLOUD_SQL_INSTANCE_CONNECTION_NAME?.trim();
  const database = env.CLOUD_SQL_DATABASE?.trim();
  const user = env.CLOUD_SQL_IAM_USER?.trim();
  const firebaseProjectId = env.FIREBASE_PROJECT_ID?.trim();
  const storagePrefix = env.GCP_STORAGE_BUCKET_PREFIX?.trim();
  if (!instanceConnectionName || !database || !user || !firebaseProjectId || !storagePrefix) {
    throw Object.assign(new Error("GCP data runtime configuration is incomplete."), { status: 503, code: "GCP_CONFIG_INCOMPLETE" });
  }
  if (
    instanceConnectionName !== TARGET_INSTANCE ||
    database !== TARGET_DATABASE ||
    user !== TARGET_DATABASE_USER ||
    firebaseProjectId !== TARGET_PROJECT ||
    storagePrefix !== TARGET_STORAGE_PREFIX
  ) {
    throw Object.assign(new Error("GCP authority does not match the UAT project."), { status: 503, code: "GCP_AUTHORITY_MISMATCH" });
  }
  return { instanceConnectionName, database, user, firebaseProjectId, storagePrefix };
}

async function databasePool(config) {
  if (pool) return pool;
  connector = new Connector();
  const options = await connector.getOptions({ instanceConnectionName: config.instanceConnectionName, authType: "IAM", ipType: "PRIVATE" });
  pool = new Pool({ ...options, database: config.database, user: config.user, max: 8, statement_timeout: 10_000, query_timeout: 12_000 });
  return pool;
}

function identifier(value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw Object.assign(new Error("Invalid database identifier."), { status: 400, code: "INVALID_IDENTIFIER" });
  return `"${value}"`;
}

function columns(value) {
  if (value === "*" || value === undefined) return "*";
  const values = String(value).split(",").map((entry) => entry.trim());
  if (values.length === 0 || values.some((entry) => !IDENTIFIER.test(entry))) {
    throw Object.assign(new Error("Only flat manifested columns are supported."), { status: 422, code: "UNPORTED_RELATION_SELECTION" });
  }
  return values.map(identifier).join(", ");
}

function filters(input, parameters) {
  if (input !== undefined && !Array.isArray(input)) {
    throw Object.assign(new Error("Query filters are invalid."), { status: 400, code: "INVALID_FILTERS" });
  }
  if ((input?.length ?? 0) > MAX_FILTERS) {
    throw Object.assign(new Error("Too many query filters."), { status: 413, code: "FILTER_LIMIT_EXCEEDED" });
  }
  const clauses = [];
  for (const filter of Array.isArray(input) ? input : []) {
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
      throw Object.assign(new Error("Query filter is invalid."), { status: 400, code: "INVALID_FILTER" });
    }
    const column = identifier(filter.column);
    if (filter.operator === "in") {
      if (!Array.isArray(filter.value) || filter.value.length === 0) { clauses.push("FALSE"); continue; }
      if (filter.value.length > MAX_IN_VALUES) {
        throw Object.assign(new Error("Too many values in query filter."), { status: 413, code: "FILTER_VALUE_LIMIT_EXCEEDED" });
      }
      const slots = filter.value.map((value) => { parameters.push(value); return `$${parameters.length}`; });
      clauses.push(`${column} IN (${slots.join(", ")})`);
      continue;
    }
    parameters.push(filter.value);
    const slot = `$${parameters.length}`;
    const operator = { eq: "=", neq: "<>", gte: ">=", lte: "<=", contains: "@>", ilike: "ILIKE" }[filter.operator];
    if (!operator) throw Object.assign(new Error("Query filter is not manifested."), { status: 422, code: "FILTER_NOT_ALLOWED" });
    clauses.push(`${column} ${operator} ${slot}`);
  }
  return clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
}

function selectionSuffix(request, parameters) {
  let sql = filters(request.filters, parameters);
  if (request.orders !== undefined && !Array.isArray(request.orders)) {
    throw Object.assign(new Error("Query ordering is invalid."), { status: 400, code: "INVALID_ORDER" });
  }
  const orders = Array.isArray(request.orders) ? request.orders : [];
  if (orders.length > 8) {
    throw Object.assign(new Error("Too many query order clauses."), { status: 413, code: "ORDER_LIMIT_EXCEEDED" });
  }
  if (orders.length) sql += ` ORDER BY ${orders.map((order) => `${identifier(order.column)} ${order.ascending === false ? "DESC" : "ASC"}`).join(", ")}`;
  if (request.limit !== undefined) {
    if (!Number.isSafeInteger(request.limit) || request.limit < 0 || request.limit > 10_000) {
      throw Object.assign(new Error("Query limit is invalid."), { status: 400, code: "INVALID_LIMIT" });
    }
    sql += ` LIMIT ${request.limit}`;
  }
  if (request.offset !== undefined) {
    if (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 10_000_000) {
      throw Object.assign(new Error("Query offset is invalid."), { status: 400, code: "INVALID_OFFSET" });
    }
    sql += ` OFFSET ${request.offset}`;
  }
  return sql;
}

function mutationRows(values, { singleRow = false } = {}) {
  const rows = Array.isArray(values) ? values : [values];
  if (!rows.length || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw Object.assign(new Error("Mutation payload is invalid."), { status: 400, code: "INVALID_MUTATION" });
  if (rows.length > MAX_MUTATION_ROWS || (singleRow && rows.length !== 1)) {
    throw Object.assign(new Error("Mutation row count is invalid."), { status: 413, code: "MUTATION_ROW_LIMIT_EXCEEDED" });
  }
  const keys = Object.keys(rows[0]);
  if (!keys.length || keys.length > MAX_MUTATION_COLUMNS || keys.some((key) => !IDENTIFIER.test(key)) || rows.some((row) => Object.keys(row).sort().join("\0") !== [...keys].sort().join("\0"))) throw Object.assign(new Error("Mutation columns are invalid."), { status: 400, code: "INVALID_MUTATION_COLUMNS" });
  return { rows, keys };
}

export function compileTableQuery(request) {
  const allowed = TABLE_OPERATIONS[request.table];
  if (!allowed || !allowed.includes(request.operation)) throw Object.assign(new Error("Table operation is not manifested."), { status: 403, code: "TABLE_OPERATION_DENIED" });
  const table = `public.${identifier(request.table)}`;
  const parameters = [];
  const returning = columns(request.columns);
  if (request.operation === "select") return { text: `SELECT ${returning} FROM ${table}${selectionSuffix(request, parameters)}`, values: parameters };
  if (["update", "delete"].includes(request.operation) && (!Array.isArray(request.filters) || request.filters.length === 0)) {
    throw Object.assign(new Error("Mutation filters are required."), { status: 422, code: "MUTATION_FILTER_REQUIRED" });
  }
  if (request.operation === "delete") return { text: `DELETE FROM ${table}${filters(request.filters, parameters)} RETURNING ${returning}`, values: parameters };
  const { rows, keys } = mutationRows(request.values, { singleRow: request.operation === "update" });
  if (request.operation === "update") {
    const setters = keys.map((key) => { parameters.push(rows[0][key]); return `${identifier(key)} = $${parameters.length}`; });
    return { text: `UPDATE ${table} SET ${setters.join(", ")}${filters(request.filters, parameters)} RETURNING ${returning}`, values: parameters };
  }
  const tuples = rows.map((row) => `(${keys.map((key) => { parameters.push(row[key]); return `$${parameters.length}`; }).join(", ")})`);
  let text = `INSERT INTO ${table} (${keys.map(identifier).join(", ")}) VALUES ${tuples.join(", ")}`;
  if (request.operation === "upsert") {
    const conflict = String(request.options?.onConflict || "").split(",").map((value) => value.trim()).filter(Boolean);
    if (!conflict.length || conflict.some((key) => !IDENTIFIER.test(key))) throw Object.assign(new Error("Upsert conflict target is required."), { status: 422, code: "UPSERT_CONFLICT_REQUIRED" });
    const conflictSet = new Set(conflict);
    const updates = keys.filter((key) => !conflictSet.has(key));
    text += ` ON CONFLICT (${conflict.map(identifier).join(", ")}) DO ${updates.length ? `UPDATE SET ${updates.map((key) => `${identifier(key)} = EXCLUDED.${identifier(key)}`).join(", ")}` : "NOTHING"}`;
  }
  return { text: `${text} RETURNING ${returning}`, values: parameters };
}

function invalidRpcArguments(message, code = "INVALID_RPC_ARGUMENT") {
  throw Object.assign(new Error(message), { status: 400, code });
}

function exactRpcArguments(args, required, optional = []) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    invalidRpcArguments("RPC arguments are invalid.");
  }
  const actual = Object.keys(args).sort();
  if (actual.length > MAX_RPC_ARGUMENTS) {
    throw Object.assign(new Error("Too many RPC arguments."), { status: 413, code: "RPC_ARGUMENT_LIMIT_EXCEEDED" });
  }
  const requiredKeys = [...required].sort();
  const allowed = new Set([...requiredKeys, ...optional]);
  if (
    requiredKeys.some((key) => !actual.includes(key))
    || actual.some((key) => !allowed.has(key))
  ) {
    invalidRpcArguments("RPC arguments do not match the manifested contract.");
  }
}

export function compileRpcQuery(request, uid) {
  const name = request?.name;
  if (!RPC_NAMES.has(name)) {
    throw Object.assign(new Error("Data operation is not manifested."), { status: 403, code: "DATA_OPERATION_DENIED" });
  }

  const args = request.args || {};
  if (name === "check_user_nda_status") {
    exactRpcArguments(args, ["p_user_id"]);
    if (args.p_user_id !== uid) {
      throw Object.assign(new Error("RPC identity does not match the authenticated user."), { status: 403, code: "RPC_IDENTITY_MISMATCH" });
    }
    return {
      text: `SELECT COALESCE(
        (
          SELECT jsonb_build_object(
            'hasSignedNda', signed_at IS NOT NULL,
            'signedAt', signed_at,
            'ndaVersion', nda_version,
            'signerName', signer_name
          )
          FROM public.nda_signatures
          WHERE user_id = hushh_identity.current_legacy_user_uuid()
        ),
        jsonb_build_object(
          'hasSignedNda', false,
          'signedAt', NULL,
          'ndaVersion', NULL,
          'signerName', NULL
        )
      ) AS result`,
      values: [],
    };
  }

  if (name === "track_product_usage") {
    exactRpcArguments(args, ["p_product_name"], ["p_metadata"]);
    if (typeof args.p_product_name !== "string" || !args.p_product_name.trim() || args.p_product_name.length > 128) {
      invalidRpcArguments("Product name is invalid.");
    }
    if (args.p_metadata !== undefined && args.p_metadata !== null && (typeof args.p_metadata !== "object" || Array.isArray(args.p_metadata))) {
      invalidRpcArguments("Product metadata is invalid.");
    }
    return {
      text: `WITH actor AS (
        SELECT hushh_identity.current_legacy_user_uuid() AS user_id
      ), upserted AS (
        INSERT INTO public.user_product_usage (
          user_id, product_name, usage_count, last_used_at, metadata
        )
        SELECT user_id, $1, 1, NOW(), COALESCE($2::jsonb, '{}'::jsonb)
        FROM actor
        WHERE user_id IS NOT NULL
        ON CONFLICT (user_id, product_name) DO UPDATE SET
          usage_count = public.user_product_usage.usage_count + 1,
          last_used_at = NOW(),
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING 1
      )
      SELECT COALESCE(
        (SELECT jsonb_build_object('success', true) FROM upserted),
        jsonb_build_object('success', false, 'error', 'User identity is not mapped')
      ) AS result`,
      values: [args.p_product_name, args.p_metadata ?? {}],
    };
  }

  exactRpcArguments(args, ["p_signer_name"], [
    "p_consent_version",
    "p_documents_acknowledged",
    "p_nda_version",
    "p_pdf_url",
    "p_signer_ip",
  ]);
  if (typeof args.p_signer_name !== "string" || !args.p_signer_name.trim()) {
    invalidRpcArguments("Signer name is invalid.");
  }
  if (args.p_documents_acknowledged !== undefined && args.p_documents_acknowledged !== null && !Array.isArray(args.p_documents_acknowledged)) {
    invalidRpcArguments("Acknowledged documents are invalid.");
  }
  return {
    text: `WITH actor AS (
      SELECT hushh_identity.current_legacy_user_uuid() AS user_id
    ), prior AS MATERIALIZED (
      SELECT s.user_id, s.nda_version
      FROM public.nda_signatures s
      JOIN actor ON actor.user_id = s.user_id
    ), upserted AS (
      INSERT INTO public.nda_signatures (
        user_id, signer_name, signer_email, signer_ip, nda_version, pdf_url,
        documents_acknowledged, consent_version, signed_at, created_at, updated_at
      )
      SELECT
        actor.user_id,
        $1,
        (SELECT email FROM public.users WHERE id = actor.user_id),
        COALESCE($4, 'unknown'),
        COALESCE($2, 'v1.0'),
        $3,
        COALESCE($5::jsonb, '[]'::jsonb),
        $6,
        NOW(),
        NOW(),
        NOW()
      FROM actor
      WHERE actor.user_id IS NOT NULL
      ON CONFLICT (user_id) DO UPDATE SET
        signer_name = EXCLUDED.signer_name,
        signer_ip = COALESCE($4, public.nda_signatures.signer_ip),
        nda_version = COALESCE(EXCLUDED.nda_version, public.nda_signatures.nda_version),
        pdf_url = COALESCE(EXCLUDED.pdf_url, public.nda_signatures.pdf_url),
        documents_acknowledged = COALESCE(EXCLUDED.documents_acknowledged, public.nda_signatures.documents_acknowledged),
        consent_version = COALESCE(EXCLUDED.consent_version, public.nda_signatures.consent_version),
        signed_at = NOW(),
        updated_at = NOW()
      RETURNING signed_at, signer_name, nda_version
    )
    SELECT COALESCE(
      (
        SELECT jsonb_build_object(
          'success', true,
          'signedAt', signed_at,
          'signerName', signer_name,
          'ndaVersion', nda_version,
          'wasInserted', NOT EXISTS (SELECT 1 FROM prior),
          'versionChanged', EXISTS (
            SELECT 1 FROM prior
            WHERE prior.nda_version IS DISTINCT FROM nda_version
          ),
          'shouldNotify', NOT EXISTS (SELECT 1 FROM prior)
            OR EXISTS (
              SELECT 1 FROM prior
              WHERE prior.nda_version IS DISTINCT FROM nda_version
            )
        )
        FROM upserted
      ),
      jsonb_build_object('success', false, 'error', 'User identity is not mapped')
    ) AS result`,
    values: [
      args.p_signer_name,
      args.p_nda_version ?? "v1.0",
      args.p_pdf_url ?? null,
      args.p_signer_ip ?? null,
      args.p_documents_acknowledged ?? [],
      args.p_consent_version ?? null,
    ],
  };
}

function firebaseAdminAuth(projectId) {
  const appName = `hushh-tech-${projectId}`;
  const app = getApps().find((candidate) => candidate.name === appName) || initializeApp({ projectId }, appName);
  if (app.options.projectId !== projectId) {
    throw Object.assign(new Error("Firebase authority is invalid."), { status: 503, code: "FIREBASE_AUTHORITY_MISMATCH" });
  }
  return getAuth(app);
}

export async function verifyFirebaseBearer(header, config = runtimeConfig()) {
  const match = String(header || "").match(/^Bearer\s+([^\s]+)$/i);
  if (!match) throw Object.assign(new Error("Firebase bearer token is required."), { status: 401, code: "AUTH_REQUIRED" });
  const decoded = await firebaseAdminAuth(config.firebaseProjectId).verifyIdToken(match[1], true);
  if (!decoded.uid || decoded.sub !== decoded.uid || decoded.aud !== config.firebaseProjectId || decoded.iss !== `https://securetoken.google.com/${config.firebaseProjectId}`) throw Object.assign(new Error("Firebase token authority is invalid."), { status: 401, code: "AUTH_INVALID" });
  return decoded;
}

export async function resolveLegacyUserUuid(uid, dependencies = {}) {
  const config = runtimeConfig();
  if (typeof uid !== "string" || !uid || uid.length > 128) {
    throw Object.assign(new Error("Firebase user is invalid."), { status: 401, code: "AUTH_INVALID" });
  }
  const activePool = dependencies.pool || await databasePool(config);
  const client = await activePool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.firebase_uid', $1, true)", [uid]);
    const result = await client.query("SELECT hushh_identity.current_legacy_user_uuid() AS legacy_user_uuid");
    await client.query("COMMIT");
    return result.rows?.[0]?.legacy_user_uuid || null;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    try { await client.query("RESET app.firebase_uid"); } catch {}
    client.release();
  }
}

// The verified API actor is the only source of transaction identity. Callers
// must never forward browser-supplied context, principal IDs or SQL here.
export async function withFirebaseTransaction(uid, work, dependencies = {}) {
  const config = runtimeConfig();
  if (typeof uid !== "string" || !uid || uid.length > 128 || uid.includes("\u0000")) {
    throw Object.assign(new Error("Firebase user is invalid."), { status: 401, code: "AUTH_INVALID" });
  }
  const activePool = dependencies.pool || await databasePool(config);
  const client = await activePool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.firebase_uid', $1, true), set_config('app.firebase_project', $2, true)", [uid, config.firebaseProjectId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally {
    try {
      await client.query("RESET app.firebase_uid; RESET app.firebase_project");
    } catch { discard = true; }
    client.release(discard);
  }
}

export async function readVerifiedFirebaseAccount(uid) {
  return firebaseAdminAuth(runtimeConfig().firebaseProjectId).getUser(uid);
}

function resolveCardinality(request, rows) {
  if (request.cardinality === "single") {
    if (rows.length !== 1) throw Object.assign(new Error("Expected exactly one row."), { status: 406, code: "CARDINALITY_MISMATCH" });
    return rows[0];
  }
  if (request.cardinality === "maybe-single") {
    if (rows.length > 1) throw Object.assign(new Error("Expected at most one row."), { status: 406, code: "CARDINALITY_MISMATCH" });
    return rows[0] || null;
  }
  if (request.cardinality !== undefined && request.cardinality !== "many") {
    throw Object.assign(new Error("Result cardinality is invalid."), { status: 400, code: "INVALID_CARDINALITY" });
  }
  return rows;
}

export async function executeDataRequest(request, uid, dependencies = {}) {
  const config = runtimeConfig();
  if (typeof uid !== "string" || !uid || uid.length > 128) {
    throw Object.assign(new Error("Firebase user is invalid."), { status: 401, code: "AUTH_INVALID" });
  }
  if (request?.kind === "table" && BLOCKED_TABLES.has(request.table)) {
    throw Object.assign(new Error("The requested data contract is not available in UAT."), { status: 503, code: "DATA_CONTRACT_BLOCKED" });
  }
  if (request?.kind === "rpc" && BLOCKED_RPCS.has(request.name)) {
    throw Object.assign(new Error("The requested RPC is not available in UAT."), { status: 503, code: "RPC_CONTRACT_BLOCKED" });
  }
  const activePool = dependencies.pool || await databasePool(config);
  const client = await activePool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.firebase_uid', $1, true)", [uid]);
    let query;
    if (request?.kind === "table") query = compileTableQuery(request);
    else if (request?.kind === "rpc") query = compileRpcQuery(request, uid);
    else throw Object.assign(new Error("Data operation is not manifested."), { status: 403, code: "DATA_OPERATION_DENIED" });
    const result = await client.query(query);
    const data = request?.kind === "rpc" ? result.rows?.[0]?.result ?? null : resolveCardinality(request, result.rows);
    await client.query("COMMIT");
    return { data, count: result.rowCount };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    try { await client.query("RESET app.firebase_uid"); } catch {}
    client.release();
  }
}

export function storageRuntime() {
  const config = runtimeConfig();
  const storage = new Storage({ projectId: TARGET_PROJECT });
  return {
    bucket(sourceBucket) {
      if (BLOCKED_STORAGE_BUCKETS.has(sourceBucket)) throw Object.assign(new Error("Storage contract is not available in UAT."), { status: 503, code: "STORAGE_CONTRACT_BLOCKED" });
      if (!STORAGE_BUCKETS.has(sourceBucket)) throw Object.assign(new Error("Storage bucket is not manifested."), { status: 403, code: "BUCKET_DENIED" });
      return storage.bucket(`${config.storagePrefix}-${sourceBucket}`);
    },
  };
}
