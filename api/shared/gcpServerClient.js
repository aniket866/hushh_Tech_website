import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { executeDataRequest, runtimeConfig, storageRuntime, verifyFirebaseBearer } from "./gcpDataRuntime.js";

const serviceActor = () => {
  const uid = process.env.GCP_SERVER_ACTOR_UID?.trim();
  if (!uid) throw Object.assign(new Error("GCP server actor is not configured."), { status: 503, code: "GCP_SERVER_ACTOR_MISSING" });
  return uid;
};

class ServerQueryBuilder {
  constructor(table) {
    this.request = { kind: "table", table, operation: "select", columns: "*", filters: [], orders: [], cardinality: "many" };
  }
  select(columns = "*", options) { this.request.columns = columns; this.request.options = options; return this; }
  insert(values, options) { Object.assign(this.request, { operation: "insert", values, options }); return this; }
  upsert(values, options) { Object.assign(this.request, { operation: "upsert", values, options }); return this; }
  update(values, options) { Object.assign(this.request, { operation: "update", values, options }); return this; }
  delete(options) { Object.assign(this.request, { operation: "delete", options }); return this; }
  eq(column, value) { this.request.filters.push({ operator: "eq", column, value }); return this; }
  neq(column, value) { this.request.filters.push({ operator: "neq", column, value }); return this; }
  gte(column, value) { this.request.filters.push({ operator: "gte", column, value }); return this; }
  lte(column, value) { this.request.filters.push({ operator: "lte", column, value }); return this; }
  in(column, value) { this.request.filters.push({ operator: "in", column, value }); return this; }
  contains(column, value) { this.request.filters.push({ operator: "contains", column, value }); return this; }
  ilike(column, value) { this.request.filters.push({ operator: "ilike", column, value }); return this; }
  order(column, options = {}) { this.request.orders.push({ column, ascending: options.ascending !== false }); return this; }
  limit(value) { this.request.limit = value; return this; }
  range(from, to) { this.request.offset = from; this.request.limit = Math.max(0, to - from + 1); return this; }
  single() { this.request.cardinality = "single"; return this; }
  maybeSingle() { this.request.cardinality = "maybe-single"; return this; }
  then(resolve, reject) {
    return executeDataRequest(this.request, serviceActor())
      .then((result) => ({ ...result, error: null }))
      .catch((error) => ({ data: null, error }))
      .then(resolve, reject);
  }
}

function firebaseAdmin() {
  const projectId = runtimeConfig().firebaseProjectId;
  const appName = `hushh-tech-server-${projectId}`;
  const app = getApps().find((candidate) => candidate.name === appName) || initializeApp({ projectId }, appName);
  return getAuth(app);
}

export function createGcpServerClient() {
  return {
    from(table) { return new ServerQueryBuilder(table); },
    async rpc(name, args = {}) {
      try { return { ...(await executeDataRequest({ kind: "rpc", name, args }, serviceActor())), error: null }; }
      catch (error) { return { data: null, error }; }
    },
    auth: {
      async getUser(token) {
        try {
          const decoded = token ? await firebaseAdmin().verifyIdToken(token, true) : await verifyFirebaseBearer("");
          return { data: { user: { id: decoded.uid, email: decoded.email, user_metadata: { full_name: decoded.name }, app_metadata: { provider: decoded.firebase?.sign_in_provider } } }, error: null };
        } catch (error) { return { data: { user: null }, error }; }
      },
      admin: {
        async deleteUser(uid) { try { await firebaseAdmin().deleteUser(uid); return { data: { user: null }, error: null }; } catch (error) { return { data: null, error }; } },
        async listUsers(page = 1, perPage = 1000) {
          try {
            const result = await firebaseAdmin().listUsers(Math.min(Math.max(perPage, 1), 1000), page > 1 ? process.env.FIREBASE_LIST_PAGE_TOKEN : undefined);
            return { data: { users: result.users.map((user) => ({ id: user.uid, email: user.email, created_at: user.metadata.creationTime, last_sign_in_at: user.metadata.lastSignInTime })) }, error: null };
          } catch (error) { return { data: { users: [] }, error }; }
        },
      },
    },
    storage: {
      from(bucket) {
        const target = () => storageRuntime().bucket(bucket);
        return {
          async list(prefix = "", options = {}) {
            try { const [files] = await target().getFiles({ prefix, maxResults: Math.min(Number(options.limit) || 100, 1000), autoPaginate: false }); return { data: files.map((file) => ({ name: file.name, metadata: file.metadata })), error: null }; }
            catch (error) { return { data: null, error }; }
          },
          async remove(paths = []) {
            try { await Promise.all(paths.map((path) => target().file(path).delete({ ignoreNotFound: true }))); return { data: paths, error: null }; }
            catch (error) { return { data: null, error }; }
          },
          getPublicUrl(path) { return { data: { publicUrl: `/api/gcp/storage/${encodeURIComponent(bucket)}/${String(path).split("/").map(encodeURIComponent).join("/")}` } }; },
        };
      },
    },
  };
}
