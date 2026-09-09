import resources from "../../resources/resources";
import type {
  OwnHushhProfile,
  PublicHushhProfile,
  UpdateHushhProfileInput,
} from "../../types/hushhProfile";

export const PROFILE_DATA_CONTRACT_NOT_READY = "PROFILE_DATA_CONTRACT_NOT_READY";
export const PUBLIC_HUSHH_ID_CONTRACT_NOT_READY = "PUBLIC_HUSHH_ID_CONTRACT_NOT_READY";

export class HushhProfileApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "HushhProfileApiError";
    this.code = code;
    this.status = status;
  }
}

function errorFromPayload(payload: unknown, status: number) {
  const error = payload && typeof payload === "object" && "error" in payload
    ? (payload as { error?: unknown }).error
    : payload;
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof record.code === "string" ? record.code : "PROFILE_API_ERROR";
  const message = typeof record.message === "string" ? record.message : "Profile data is temporarily unavailable.";
  return new HushhProfileApiError(code, message, status);
}

async function readJson(response: Response) {
  return response.json().catch(() => null) as Promise<unknown>;
}

async function authenticatedRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const client = resources.config.gcpBackendClient;
  if (!client) {
    throw new HushhProfileApiError("PROFILE_API_UNAVAILABLE", "Profile data is temporarily unavailable.", 503);
  }

  const { data, error } = await client.auth.getSession();
  const token = data?.session?.access_token;
  if (error || !token) {
    throw new HushhProfileApiError("AUTH_REQUIRED", "Sign in required.", 401);
  }

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
  const payload = await readJson(response);
  if (!response.ok) throw errorFromPayload(payload, response.status);
  return (payload as { data?: T })?.data as T;
}

async function publicRequest<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  const payload = await readJson(response);
  if (!response.ok) throw errorFromPayload(payload, response.status);
  return (payload as { data?: T })?.data as T;
}

export function getOwnHushhProfile() {
  return authenticatedRequest<OwnHushhProfile>("/api/hushh-profile");
}

export function updateOwnHushhProfile(input: UpdateHushhProfileInput) {
  return authenticatedRequest<OwnHushhProfile>("/api/hushh-profile", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function getPublicHushhProfile(hushhId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(hushhId)) {
    throw new HushhProfileApiError("INVALID_HUSHH_ID", "This Hushh ID is invalid.", 400);
  }
  return publicRequest<PublicHushhProfile>(`/api/public/hushh-profile/${encodeURIComponent(hushhId)}`);
}
