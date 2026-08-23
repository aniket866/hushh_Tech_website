import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  getIdTokenResult,
  getRedirectResult,
  GoogleAuthProvider,
  OAuthProvider,
  onIdTokenChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithRedirect,
  signOut as firebaseSignOut,
  type Auth,
  type User as FirebaseUser,
} from "firebase/auth";
import type {
  AuthChangeEvent,
  BackendError,
  BackendResult,
  GcpBackendClient,
  FunctionInvokeOptions,
  QueryBuilder,
  Session,
  User,
} from "./types";
import {
  clearNoHybridBrowserFixture,
  resolveNoHybridBrowserFixture,
} from "../../auth/noHybridBrowserFixture";

const APP_NAME = "hushh-tech-gcp";
const DATA_PATH = "/api/gcp/data";
const STORAGE_PATH = "/api/gcp/storage";
const FUNCTION_NAME = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,126}[a-z0-9])$/;
const FUNCTION_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export interface GcpClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  appId: string;
}

type QueryOperation = "select" | "insert" | "upsert" | "update" | "delete";

interface QueryState {
  table: string;
  operation: QueryOperation;
  columns: string;
  values?: unknown;
  options?: Record<string, unknown>;
  filters: Array<{ operator: string; column: string; value: unknown }>;
  orders: Array<{ column: string; ascending: boolean }>;
  limit?: number;
  offset?: number;
  cardinality: "many" | "single" | "maybe-single";
}

function backendError(error: unknown, status?: number): BackendError {
  if (error && typeof error === "object" && "message" in error) {
    const candidate = error as { message?: unknown; code?: unknown; name?: unknown };
    return {
      name: typeof candidate.name === "string" ? candidate.name : "GcpBackendError",
      message: typeof candidate.message === "string" ? candidate.message : "GCP backend request failed.",
      code: typeof candidate.code === "string" ? candidate.code : undefined,
      status,
    };
  }
  return { name: "GcpBackendError", message: "GCP backend request failed.", status };
}

export function firebaseUserToSessionUser(
  value: FirebaseUser,
  claims: Readonly<Record<string, unknown>> = {},
): User {
  const createdAt = value.metadata.creationTime || new Date(0).toISOString();
  return {
    id: value.uid,
    aud: "authenticated",
    role: "authenticated",
    email: value.email || undefined,
    phone: value.phoneNumber || undefined,
    app_metadata: {
      provider: value.providerData[0]?.providerId || "firebase",
      providers: value.providerData.map((entry) => entry.providerId),
      fund_admin: claims.fund_admin === true,
      deployment_admin: claims.deployment_admin === true,
    },
    user_metadata: {
      full_name: value.displayName || undefined,
      avatar_url: value.photoURL || undefined,
    },
    identities: value.providerData.map((entry) => ({
      id: entry.uid,
      user_id: value.uid,
      provider: entry.providerId,
      identity_data: {
        email: entry.email,
        full_name: entry.displayName,
        avatar_url: entry.photoURL,
      },
    })),
    created_at: createdAt,
    updated_at: value.metadata.lastRefreshTime || createdAt,
    last_sign_in_at: value.metadata.lastSignInTime,
    is_anonymous: value.isAnonymous,
  };
}

async function toSession(value: FirebaseUser | null, forceRefresh = false): Promise<Session | null> {
  if (!value) return null;
  const token = await getIdTokenResult(value, forceRefresh);
  const expiresAt = Math.floor(new Date(token.expirationTime).getTime() / 1000);
  const issuedAt = Math.floor(new Date(token.issuedAtTime).getTime() / 1000);
  return {
    access_token: token.token,
    refresh_token: value.refreshToken,
    token_type: "bearer",
    expires_in: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
    expires_at: expiresAt,
    user: firebaseUserToSessionUser(value, token.claims),
  };
}

async function authenticatedFetch(
  auth: Auth,
  path: string,
  init: RequestInit,
): Promise<BackendResult<any>> {
  const token = await requestAccessToken(auth);
  if (!token) {
    return { data: null, error: { name: "AuthError", message: "Sign in required.", status: 401 }, status: 401 };
  }
  try {
    const response = await fetch(path, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        data: null,
        error: backendError(payload?.error || payload || new Error("GCP backend request failed."), response.status),
        status: response.status,
        statusText: response.statusText,
      };
    }
    return {
      data: payload?.data ?? null,
      count: typeof payload?.count === "number" ? payload.count : null,
      error: null,
      status: response.status,
      statusText: response.statusText,
    };
  } catch (error) {
    return { data: null, error: backendError(error), status: 0, statusText: "NETWORK_ERROR" };
  }
}

async function requestAccessToken(auth: Auth): Promise<string | null> {
  const fixture = resolveNoHybridBrowserFixture();
  if (fixture?.session?.access_token) return fixture.session.access_token;
  await auth.authStateReady();
  return auth.currentUser ? auth.currentUser.getIdToken() : null;
}

class GcpQueryBuilder<T = unknown> implements QueryBuilder<T> {
  constructor(private readonly auth: Auth, private readonly state: QueryState) {}

  private mutate(patch: Partial<QueryState>) {
    Object.assign(this.state, patch);
    return this;
  }

  select(columns = "*", options?: Record<string, unknown>) {
    if (this.state.operation === "select") this.state.options = options;
    return this.mutate({ columns });
  }
  insert(values: unknown, options?: Record<string, unknown>) { return this.mutate({ operation: "insert", values, options }); }
  upsert(values: unknown, options?: Record<string, unknown>) { return this.mutate({ operation: "upsert", values, options }); }
  update(values: unknown, options?: Record<string, unknown>) { return this.mutate({ operation: "update", values, options }); }
  delete(options?: Record<string, unknown>) { return this.mutate({ operation: "delete", options }); }
  eq(column: string, value: unknown) { this.state.filters.push({ operator: "eq", column, value }); return this; }
  neq(column: string, value: unknown) { this.state.filters.push({ operator: "neq", column, value }); return this; }
  gte(column: string, value: unknown) { this.state.filters.push({ operator: "gte", column, value }); return this; }
  lte(column: string, value: unknown) { this.state.filters.push({ operator: "lte", column, value }); return this; }
  in(column: string, value: unknown[]) { this.state.filters.push({ operator: "in", column, value }); return this; }
  contains(column: string, value: unknown) { this.state.filters.push({ operator: "contains", column, value }); return this; }
  ilike(column: string, value: string) { this.state.filters.push({ operator: "ilike", column, value }); return this; }
  order(column: string, options: Record<string, unknown> = {}) {
    this.state.orders.push({ column, ascending: options.ascending !== false });
    return this;
  }
  limit(value: number) { return this.mutate({ limit: value }); }
  range(from: number, to: number) { return this.mutate({ offset: from, limit: Math.max(0, to - from + 1) }); }
  single() { return this.mutate({ cardinality: "single" }); }
  maybeSingle() { return this.mutate({ cardinality: "maybe-single" }); }
  then<TResult1 = BackendResult<T>, TResult2 = never>(
    onfulfilled?: ((value: BackendResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return authenticatedFetch(this.auth, DATA_PATH, {
      method: "POST",
      body: JSON.stringify({ kind: "table", ...this.state }),
    }).then(onfulfilled, onrejected);
  }
}

function createAuthFacade(auth: Auth) {
  const unsupportedMfa = async () => ({
    data: null,
    error: { name: "MfaUnavailable", message: "Multi-factor enrollment is not enabled for this GCP project.", status: 503 },
  });
  return {
    storageKey: "hushh-tech-firebase-auth",
    async getSession() {
      const fixture = resolveNoHybridBrowserFixture();
      if (fixture) return { data: { session: fixture.session }, error: null };
      await auth.authStateReady();
      try { return { data: { session: await toSession(auth.currentUser) }, error: null }; }
      catch (error) { return { data: { session: null }, error: backendError(error) }; }
    },
    async getUser() {
      const fixture = resolveNoHybridBrowserFixture();
      if (fixture) return { data: { user: fixture.user }, error: null };
      await auth.authStateReady();
      return auth.currentUser
        ? { data: { user: toUser(auth.currentUser) }, error: null }
        : { data: { user: null }, error: { name: "AuthError", message: "Sign in required.", status: 401 } };
    },
    onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void) {
      const fixture = resolveNoHybridBrowserFixture();
      if (fixture) {
        queueMicrotask(() => callback("INITIAL_SESSION", fixture.session));
        return { data: { subscription: { unsubscribe() {} } } };
      }
      let initialized = false;
      const unsubscribe = onIdTokenChanged(auth, async (user) => {
        const event: AuthChangeEvent = initialized ? (user ? "TOKEN_REFRESHED" : "SIGNED_OUT") : "INITIAL_SESSION";
        initialized = true;
        callback(event, await toSession(user));
      });
      return { data: { subscription: { unsubscribe } } };
    },
    async signInWithOAuth({ provider }: { provider: "google" | "apple"; options?: Record<string, unknown> }) {
      try {
        const authProvider = provider === "google" ? new GoogleAuthProvider() : new OAuthProvider("apple.com");
        await signInWithRedirect(auth, authProvider);
        return { data: { provider, url: null }, error: null };
      } catch (error) { return { data: null, error: backendError(error) }; }
    },
    async signInWithPassword({ email, password }: { email: string; password: string }) {
      try {
        const credential = await signInWithEmailAndPassword(auth, email, password);
        return { data: { user: toUser(credential.user), session: await toSession(credential.user) }, error: null };
      } catch (error) { return { data: { user: null, session: null }, error: backendError(error) }; }
    },
    async exchangeCodeForSession() {
      try {
        const result = await getRedirectResult(auth);
        const session = await toSession(result?.user || auth.currentUser);
        return { data: { session, user: session?.user || null }, error: session ? null : { name: "AuthError", message: "No redirect session found." } };
      } catch (error) { return { data: { session: null, user: null }, error: backendError(error) }; }
    },
    async setSession() { return { data: { session: null, user: null }, error: { name: "AuthError", message: "Raw session injection is disabled." } }; },
    async refreshSession() {
      const fixture = resolveNoHybridBrowserFixture();
      if (fixture) {
        return { data: { session: fixture.session, user: fixture.user }, error: null };
      }
      try {
        const session = await toSession(auth.currentUser, true);
        return { data: { session, user: session?.user || null }, error: session ? null : { name: "AuthError", message: "Sign in required.", status: 401 } };
      } catch (error) { return { data: { session: null, user: null }, error: backendError(error) }; }
    },
    async signOut() {
      if (resolveNoHybridBrowserFixture()) {
        clearNoHybridBrowserFixture();
        return { error: null };
      }
      try { await firebaseSignOut(auth); return { error: null }; }
      catch (error) { return { error: backendError(error) }; }
    },
    stopAutoRefresh() {},
    mfa: {
      enroll: unsupportedMfa,
      challenge: unsupportedMfa,
      verify: unsupportedMfa,
      unenroll: unsupportedMfa,
      listFactors: unsupportedMfa,
      getAuthenticatorAssuranceLevel: unsupportedMfa,
    },
  };
}

function firebaseApp(config: GcpClientConfig): FirebaseApp {
  return getApps().some((entry) => entry.name === APP_NAME)
    ? getApp(APP_NAME)
    : initializeApp(config, APP_NAME);
}

export function createGcpBackendClient(config: GcpClientConfig): GcpBackendClient {
  const auth = getAuth(firebaseApp(config));
  void setPersistence(auth, browserLocalPersistence);
  return {
    auth: createAuthFacade(auth),
    from<T = unknown>(table: string) {
      return new GcpQueryBuilder<T>(auth, {
        table,
        operation: "select",
        columns: "*",
        filters: [],
        orders: [],
        cardinality: "many",
      });
    },
    rpc<T = unknown>(name: string, args: Record<string, unknown> = {}) {
      return authenticatedFetch(auth, DATA_PATH, {
        method: "POST",
        body: JSON.stringify({ kind: "rpc", name, args }),
      }) as Promise<BackendResult<T>>;
    },
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, body: Blob | ArrayBuffer, options: Record<string, unknown> = {}) => {
            const token = await requestAccessToken(auth);
            if (!token) return { data: null, error: { name: "AuthError", message: "Sign in required.", status: 401 } };
            const response = await fetch(`${STORAGE_PATH}/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`, {
              method: "PUT",
              credentials: "same-origin",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": String(options.contentType || "application/octet-stream") },
              body,
            });
            const payload = await response.json().catch(() => null);
            return response.ok ? { data: payload?.data ?? { path }, error: null } : { data: null, error: backendError(payload?.error, response.status) };
          },
          getPublicUrl(path: string) {
            return { data: { publicUrl: `${STORAGE_PATH}/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}` } };
          },
          async download(path: string) {
            const token = await requestAccessToken(auth);
            if (!token) return { data: null, error: { name: "AuthError", message: "Sign in required.", status: 401 } };
            try {
              const response = await fetch(`${STORAGE_PATH}/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`, {
                method: "GET",
                credentials: "same-origin",
                cache: "no-store",
                headers: { Authorization: `Bearer ${token}` },
              });
              if (!response.ok) {
                const payload = await response.json().catch(() => null);
                return { data: null, error: backendError(payload?.error || payload, response.status) };
              }
              return { data: await response.blob(), error: null };
            } catch (error) {
              return { data: null, error: backendError(error) };
            }
          },
          remove(paths: string[]) {
            return authenticatedFetch(auth, STORAGE_PATH, { method: "DELETE", body: JSON.stringify({ bucket, paths }) });
          },
          list(path = "", options: Record<string, unknown> = {}) {
            return authenticatedFetch(auth, STORAGE_PATH, { method: "POST", body: JSON.stringify({ bucket, path, options }) });
          },
        };
      },
    },
    functions: {
      async invoke<T = unknown>(name: string, options: FunctionInvokeOptions = {}) {
        if (!FUNCTION_NAME.test(name)) {
          return { data: null, error: { name: "FunctionPathError", message: "Function name is invalid.", status: 400 }, status: 400 };
        }
        const subpath = options.subpath ?? [];
        if (!Array.isArray(subpath) || subpath.some((segment) => !FUNCTION_PATH_SEGMENT.test(segment))) {
          return { data: null, error: { name: "FunctionPathError", message: "Function path is invalid.", status: 400 }, status: 400 };
        }
        const method = options.method ?? "POST";
        if (method !== "GET" && method !== "POST") {
          return { data: null, error: { name: "FunctionMethodError", message: "Function method is invalid.", status: 405 }, status: 405 };
        }
        if (method === "GET" && options.body !== undefined) {
          return { data: null, error: { name: "FunctionBodyError", message: "GET functions cannot include a body.", status: 400 }, status: 400 };
        }
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(options.query ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
          if (!FUNCTION_PATH_SEGMENT.test(key)) {
            return { data: null, error: { name: "FunctionQueryError", message: "Function query is invalid.", status: 400 }, status: 400 };
          }
          if (value !== undefined) query.append(key, String(value));
        }
        const token = await requestAccessToken(auth);
        const pathname = ["", "functions", "v1", name, ...subpath]
          .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
          .join("/");
        const response = await fetch(`${pathname}${query.size ? `?${query.toString()}` : ""}`, {
          method,
          credentials: "same-origin",
          cache: "no-store",
          signal: options.signal,
          headers: {
            Accept: "application/json",
            ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
        });
        const payload = await response.json().catch(() => null);
        return response.ok
          ? { data: payload as T, error: null, status: response.status }
          : { data: null, error: backendError(payload?.error || payload, response.status), status: response.status };
      },
    },
  };
}
