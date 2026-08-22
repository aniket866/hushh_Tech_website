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
  hushh_ai_chats: ["select", "insert", "update", "delete"],
  hushh_ai_media_limits: ["select", "insert", "update", "delete"],
  hushh_ai_messages: ["select", "insert", "update", "delete"],
  hushh_ai_users: ["select", "insert", "update", "delete"],
  identity_verifications: ["select", "insert", "update", "delete"],
  intelligence_conversations: ["select", "insert", "update", "delete"],
  intelligence_media_limits: ["select", "insert", "update", "delete"],
  intelligence_messages: ["select", "insert", "update", "delete"],
  intelligence_users: ["select", "insert", "update", "delete"],
  investor_profiles: ["select", "insert", "update", "upsert", "delete"],
  kyc_profiles: ["select", "insert", "update", "delete"],
  lead_events: ["select", "insert", "update", "delete"],
  lead_requests: ["select", "insert", "update", "delete"],
  messages: ["select", "insert", "update", "delete"],
  nda_signatures: ["select", "insert", "update", "delete"],
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
  plaid_transfer_accounts: ["select", "insert", "update", "upsert", "delete"],
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
  "check_user_nda_status",
  "get_public_investor_profile",
  "increment_hushh_ai_uploads",
  "increment_intelligence_uploads",
  "sign_global_nda",
  "track_product_usage",
]);

export const STORAGE_BUCKETS = new Set([
  "assets",
  "community-uploads",
  "hushh-agent-profile-images",
  "hushh-ai-media",
  "hushh-gamma-pdf",
  "wa-evidence",
  "alohafundsreport-images",
  "alohafundsreport-videos",
]);

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const TARGET_PROJECT = "hushh-tech-uat";
let connector;
let pool;

export function runtimeConfig(env = process.env) {
  if (env.GCP_DATA_RUNTIME_ENABLED !== "true") {
    throw Object.assign(new Error("GCP data runtime is not enabled."), { status: 503, code: "GCP_DATA_DISABLED" });
  }
  if (env.GOOGLE_CLOUD_PROJECT !== TARGET_PROJECT && env.GCP_PROJECT !== TARGET_PROJECT) {
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
  if (!instanceConnectionName.startsWith(`${TARGET_PROJECT}:`) || firebaseProjectId !== TARGET_PROJECT) {
    throw Object.assign(new Error("GCP authority does not match the UAT project."), { status: 503, code: "GCP_AUTHORITY_MISMATCH" });
  }
  return { instanceConnectionName, database, user, firebaseProjectId, storagePrefix };
}

async function databasePool(config) {
  if (pool) return pool;
  connector = new Connector();
  const options = await connector.getOptions({ instanceConnectionName: config.instanceConnectionName, authType: "IAM" });
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
  const clauses = [];
  for (const filter of Array.isArray(input) ? input : []) {
    const column = identifier(filter.column);
    if (filter.operator === "in") {
      if (!Array.isArray(filter.value) || filter.value.length === 0) { clauses.push("FALSE"); continue; }
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
  const orders = Array.isArray(request.orders) ? request.orders : [];
  if (orders.length) sql += ` ORDER BY ${orders.map((order) => `${identifier(order.column)} ${order.ascending === false ? "DESC" : "ASC"}`).join(", ")}`;
  if (Number.isSafeInteger(request.limit) && request.limit >= 0 && request.limit <= 10_000) sql += ` LIMIT ${request.limit}`;
  if (Number.isSafeInteger(request.offset) && request.offset >= 0) sql += ` OFFSET ${request.offset}`;
  return sql;
}

function mutationRows(values) {
  const rows = Array.isArray(values) ? values : [values];
  if (!rows.length || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw Object.assign(new Error("Mutation payload is invalid."), { status: 400, code: "INVALID_MUTATION" });
  const keys = Object.keys(rows[0]);
  if (!keys.length || keys.some((key) => !IDENTIFIER.test(key)) || rows.some((row) => Object.keys(row).sort().join("\0") !== [...keys].sort().join("\0"))) throw Object.assign(new Error("Mutation columns are invalid."), { status: 400, code: "INVALID_MUTATION_COLUMNS" });
  return { rows, keys };
}

export function compileTableQuery(request) {
  const allowed = TABLE_OPERATIONS[request.table];
  if (!allowed || !allowed.includes(request.operation)) throw Object.assign(new Error("Table operation is not manifested."), { status: 403, code: "TABLE_OPERATION_DENIED" });
  const table = `public.${identifier(request.table)}`;
  const parameters = [];
  const returning = columns(request.columns);
  if (request.operation === "select") return { text: `SELECT ${returning} FROM ${table}${selectionSuffix(request, parameters)}`, values: parameters };
  if (request.operation === "delete") return { text: `DELETE FROM ${table}${filters(request.filters, parameters)} RETURNING ${returning}`, values: parameters };
  const { rows, keys } = mutationRows(request.values);
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

export async function verifyFirebaseBearer(header, config = runtimeConfig()) {
  const match = String(header || "").match(/^Bearer\s+([^\s]+)$/i);
  if (!match) throw Object.assign(new Error("Firebase bearer token is required."), { status: 401, code: "AUTH_REQUIRED" });
  const app = getApps()[0] || initializeApp({ projectId: config.firebaseProjectId });
  const decoded = await getAuth(app).verifyIdToken(match[1], true);
  if (!decoded.uid || decoded.aud !== config.firebaseProjectId || decoded.iss !== `https://securetoken.google.com/${config.firebaseProjectId}`) throw Object.assign(new Error("Firebase token authority is invalid."), { status: 401, code: "AUTH_INVALID" });
  return decoded;
}

export async function executeDataRequest(request, uid) {
  const config = runtimeConfig();
  const activePool = await databasePool(config);
  const client = await activePool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.firebase_uid', $1, true)", [uid]);
    let query;
    if (request?.kind === "table") query = compileTableQuery(request);
    else if (request?.kind === "rpc" && RPC_NAMES.has(request.name)) {
      const entries = Object.entries(request.args || {});
      if (entries.some(([key]) => !IDENTIFIER.test(key))) throw Object.assign(new Error("RPC argument is invalid."), { status: 400, code: "INVALID_RPC_ARGUMENT" });
      query = { text: `SELECT * FROM public.${identifier(request.name)}(${entries.map(([key], index) => `${identifier(key)} => $${index + 1}`).join(", ")})`, values: entries.map(([, value]) => value) };
    } else throw Object.assign(new Error("Data operation is not manifested."), { status: 403, code: "DATA_OPERATION_DENIED" });
    const result = await client.query(query);
    await client.query("COMMIT");
    let data = result.rows;
    if (request.cardinality === "single") {
      if (data.length !== 1) throw Object.assign(new Error("Expected exactly one row."), { status: 406, code: "CARDINALITY_MISMATCH" });
      data = data[0];
    } else if (request.cardinality === "maybe-single") {
      if (data.length > 1) throw Object.assign(new Error("Expected at most one row."), { status: 406, code: "CARDINALITY_MISMATCH" });
      data = data[0] || null;
    }
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
      if (!STORAGE_BUCKETS.has(sourceBucket)) throw Object.assign(new Error("Storage bucket is not manifested."), { status: 403, code: "BUCKET_DENIED" });
      return storage.bucket(`${config.storagePrefix}-${sourceBucket}`);
    },
  };
}
