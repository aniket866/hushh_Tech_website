export interface UserIdentity {
  id?: string;
  identity_id?: string;
  user_id?: string;
  provider?: string;
  identity_data?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  last_sign_in_at?: string;
}

export interface User {
  id: string;
  aud: string;
  role?: string;
  email?: string;
  phone?: string;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  identities?: UserIdentity[];
  created_at: string;
  updated_at?: string;
  last_sign_in_at?: string;
  is_anonymous?: boolean;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at?: number;
  user: User;
}

export type AuthChangeEvent =
  | "INITIAL_SESSION"
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED"
  | "PASSWORD_RECOVERY"
  | "MFA_CHALLENGE_VERIFIED";

export interface BackendError {
  name: string;
  message: string;
  status?: number;
  code?: string;
  details?: string;
  hint?: string;
}

export interface BackendResult<T = unknown> {
  data: T | null;
  error: BackendError | null;
  count?: number | null;
  status?: number;
  statusText?: string;
}

export interface QueryBuilder<T = unknown>
  extends PromiseLike<BackendResult<T>> {
  select(columns?: string, options?: Record<string, unknown>): QueryBuilder<T>;
  insert(values: unknown, options?: Record<string, unknown>): QueryBuilder<T>;
  upsert(values: unknown, options?: Record<string, unknown>): QueryBuilder<T>;
  update(values: unknown, options?: Record<string, unknown>): QueryBuilder<T>;
  delete(options?: Record<string, unknown>): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  neq(column: string, value: unknown): QueryBuilder<T>;
  gte(column: string, value: unknown): QueryBuilder<T>;
  lte(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, values: unknown[]): QueryBuilder<T>;
  contains(column: string, value: unknown): QueryBuilder<T>;
  ilike(column: string, value: string): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(value: number): QueryBuilder<T>;
  range(from: number, to: number): QueryBuilder<T>;
  single(): QueryBuilder<T>;
  maybeSingle(): QueryBuilder<T>;
}

export interface GcpBackendClient {
  auth: Record<string, any>;
  from<T = unknown>(table: string): QueryBuilder<T>;
  rpc<T = unknown>(name: string, args?: Record<string, unknown>): Promise<BackendResult<T>>;
  storage: { from(bucket: string): Record<string, any> };
  functions: { invoke<T = unknown>(name: string, options?: Record<string, unknown>): Promise<BackendResult<T>> };
}

// Compatibility alias while call sites move to the provider-neutral name.
export type BackendClient = GcpBackendClient;
