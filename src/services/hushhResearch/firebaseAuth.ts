import type { Session, User } from "@/services/gcpBackend/types";
import {
  HUSHH_RESEARCH_CALLBACK_PATH,
  HUSHH_RESEARCH_CONFIG_PATH,
  HUSHH_RESEARCH_EXCHANGE_PATH,
  HUSHH_RESEARCH_LAUNCH_ORIGIN,
  HUSHH_RESEARCH_LAUNCH_PATH,
  HUSHH_RESEARCH_PRODUCT_AUDIENCE,
  HUSHH_RESEARCH_PRODUCT_CLIENT,
  HUSHH_RESEARCH_PRODUCT_CLIENT_APP_ID,
  HUSHH_RESEARCH_PROJECT_ID,
  HUSHH_RESEARCH_SOURCE,
  HUSHH_RESEARCH_START_PATH,
  isHushhResearchAuthRoute,
  type HushhResearchConfigState,
  type HushhResearchFirebaseSession,
  type HushhResearchLaunchExchangeInput,
  type HushhResearchLaunchExchangeResponse,
  type HushhResearchLaunchFailureReason,
  type HushhResearchLaunchResult,
  type HushhResearchLaunchStartFailureReason,
  type HushhResearchLaunchStartResult,
  type HushhResearchLinkState,
  type HushhResearchPublicConfig,
  type HushhResearchSessionState,
} from "./contracts";

const FIREBASE_SESSION_STORAGE_KEY = "hushh_research_firebase_session";
const FIREBASE_MODE_STORAGE_KEY = "hushh_research_auth_mode";
const FIREBASE_MODE_STORAGE_VALUE = "firebase-v1";
const FIREBASE_REFRESH_WINDOW_MS = 60_000;

const PRODUCTION_HOSTNAMES = new Set([
  "hushhtech.com",
  "www.hushhtech.com",
]);

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface LocationLike {
  hostname: string;
  origin: string;
  pathname: string;
}

export interface HushhResearchAuthClientDependencies {
  fetchImpl: typeof fetch;
  storage: StorageLike;
  location: LocationLike;
  now: () => number;
}

interface FirebaseCustomTokenResponse {
  idToken: string;
  refreshToken: string;
  expiresIn: string;
  localId: string;
  email?: string;
  displayName?: string;
}

interface FirebaseRefreshResponse {
  id_token: string;
  refresh_token: string;
  expires_in: string;
  user_id: string;
}

interface ValidatedJwtIdentityClaims {
  email?: string;
  name?: string;
  launchAuthorizationId: string;
  launchValidAfterMs: number;
}

function isLinkState(value: unknown): value is HushhResearchLinkState {
  return value === "READY" || value === "LINK_REQUIRED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parsePositiveInteger(value: unknown): number | null {
  if (!isNonEmptyString(value)) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isProductionHostname(hostname: string): boolean {
  return PRODUCTION_HOSTNAMES.has(hostname.trim().toLowerCase());
}

function getDefaultDependencies(): HushhResearchAuthClientDependencies {
  if (typeof window === "undefined") {
    throw new Error("Hushh Research authentication requires a browser.");
  }

  return {
    fetchImpl: window.fetch.bind(window),
    storage: window.localStorage,
    location: window.location,
    now: () => Date.now(),
  };
}

function parsePublicConfig(
  payload: unknown,
  location: LocationLike
): HushhResearchConfigState {
  if (!isRecord(payload) || payload.enabled !== true) {
    return { status: "disabled", reason: "feature_disabled" };
  }

  const firebase = payload.firebase;
  const launch = payload.launch;
  if (!isRecord(firebase) || !isRecord(launch)) {
    return { status: "disabled", reason: "invalid_config" };
  }

  if (
    !isNonEmptyString(firebase.apiKey) ||
    !isNonEmptyString(firebase.authDomain) ||
    firebase.projectId !== HUSHH_RESEARCH_PROJECT_ID ||
    !isNonEmptyString(firebase.appId) ||
    !isNonEmptyString(launch.audience) ||
    launch.audience !== HUSHH_RESEARCH_PRODUCT_AUDIENCE ||
    !isNonEmptyString(launch.redirectUri) ||
    launch.startPath !== HUSHH_RESEARCH_START_PATH
  ) {
    return { status: "disabled", reason: "invalid_config" };
  }

  try {
    const redirectUri = new URL(launch.redirectUri);
    if (
      redirectUri.origin !== location.origin ||
      redirectUri.pathname !== HUSHH_RESEARCH_CALLBACK_PATH ||
      redirectUri.search ||
      redirectUri.hash
    ) {
      return { status: "disabled", reason: "invalid_config" };
    }
  } catch {
    return { status: "disabled", reason: "invalid_config" };
  }

  return {
    status: "enabled",
    config: {
      enabled: true,
      firebase: {
        apiKey: firebase.apiKey.trim(),
        authDomain: firebase.authDomain.trim(),
        projectId: HUSHH_RESEARCH_PROJECT_ID,
        appId: firebase.appId.trim(),
      },
      launch: {
        audience: launch.audience.trim(),
        redirectUri: launch.redirectUri,
        startPath: HUSHH_RESEARCH_START_PATH,
      },
    },
  };
}

function parseExchangeResponse(
  payload: unknown,
  input: HushhResearchLaunchExchangeInput,
  config: HushhResearchPublicConfig
): HushhResearchLaunchExchangeResponse | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (
    !isNonEmptyString(payload.firebase_custom_token) ||
    !isPositiveNumber(payload.expires_in) ||
    !isNonEmptyString(payload.canonical_user_id) ||
    payload.audience !== config.launch.audience ||
    payload.state !== input.state ||
    !isLinkState(payload.link_state)
  ) {
    return null;
  }

  return {
    firebase_custom_token: payload.firebase_custom_token,
    expires_in: payload.expires_in,
    canonical_user_id: payload.canonical_user_id,
    audience: payload.audience,
    state: payload.state,
    link_state: payload.link_state,
  };
}

function parseFirebaseCustomTokenResponse(
  payload: unknown
): FirebaseCustomTokenResponse | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (
    !isNonEmptyString(payload.idToken) ||
    !isNonEmptyString(payload.refreshToken) ||
    !isNonEmptyString(payload.expiresIn) ||
    !isNonEmptyString(payload.localId)
  ) {
    return null;
  }

  return {
    idToken: payload.idToken,
    refreshToken: payload.refreshToken,
    expiresIn: payload.expiresIn,
    localId: payload.localId,
    email: isNonEmptyString(payload.email) ? payload.email : undefined,
    displayName: isNonEmptyString(payload.displayName)
      ? payload.displayName
      : undefined,
  };
}

function parseFirebaseRefreshResponse(
  payload: unknown
): FirebaseRefreshResponse | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (
    !isNonEmptyString(payload.id_token) ||
    !isNonEmptyString(payload.refresh_token) ||
    !isNonEmptyString(payload.expires_in) ||
    !isNonEmptyString(payload.user_id)
  ) {
    return null;
  }

  return {
    id_token: payload.id_token,
    refresh_token: payload.refresh_token,
    expires_in: payload.expires_in,
    user_id: payload.user_id,
  };
}

function decodeAndValidateJwtIdentityClaims(
  idToken: string,
  expectedUid: string
): ValidatedJwtIdentityClaims | null {
  try {
    const payloadSegment = idToken.split(".")[1];
    if (!payloadSegment) {
      return null;
    }

    const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const payload = JSON.parse(globalThis.atob(padded)) as unknown;
    if (!isRecord(payload)) {
      return null;
    }

    if (
      payload.aud !== HUSHH_RESEARCH_PROJECT_ID ||
      payload.iss !==
        `https://securetoken.google.com/${HUSHH_RESEARCH_PROJECT_ID}` ||
      payload.sub !== expectedUid ||
      payload.product_client !== HUSHH_RESEARCH_PRODUCT_CLIENT ||
      payload.product_client_app_id !==
        HUSHH_RESEARCH_PRODUCT_CLIENT_APP_ID ||
      payload.product_audience !== HUSHH_RESEARCH_PRODUCT_AUDIENCE ||
      !isNonEmptyString(payload.product_launch_authorization_id) ||
      typeof payload.product_launch_valid_after_ms !== "number" ||
      !Number.isFinite(payload.product_launch_valid_after_ms)
    ) {
      return null;
    }

    return {
      email: isNonEmptyString(payload.email) ? payload.email : undefined,
      name: isNonEmptyString(payload.name) ? payload.name : undefined,
      launchAuthorizationId: payload.product_launch_authorization_id,
      launchValidAfterMs: payload.product_launch_valid_after_ms,
    };
  } catch {
    return null;
  }
}

function parseStoredSession(rawValue: string): HushhResearchFirebaseSession | null {
  try {
    const value = JSON.parse(rawValue) as unknown;
    if (!isRecord(value)) {
      return null;
    }

    if (
      value.version !== 1 ||
      value.provider !== "firebase" ||
      value.projectId !== HUSHH_RESEARCH_PROJECT_ID ||
      !isNonEmptyString(value.audience) ||
      !isNonEmptyString(value.uid) ||
      !isNonEmptyString(value.idToken) ||
      !isNonEmptyString(value.refreshToken) ||
      typeof value.issuedAt !== "number" ||
      !Number.isFinite(value.issuedAt) ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt) ||
      !isLinkState(value.linkState) ||
      !isNonEmptyString(value.launchAuthorizationId) ||
      typeof value.launchValidAfterMs !== "number" ||
      !Number.isFinite(value.launchValidAfterMs)
    ) {
      return null;
    }

    return {
      version: 1,
      provider: "firebase",
      projectId: HUSHH_RESEARCH_PROJECT_ID,
      audience: value.audience,
      linkState: value.linkState,
      launchAuthorizationId: value.launchAuthorizationId,
      launchValidAfterMs: value.launchValidAfterMs,
      uid: value.uid,
      idToken: value.idToken,
      refreshToken: value.refreshToken,
      email: isNonEmptyString(value.email) ? value.email : undefined,
      displayName: isNonEmptyString(value.displayName)
        ? value.displayName
        : undefined,
      issuedAt: value.issuedAt,
      expiresAt: value.expiresAt,
    };
  } catch {
    return null;
  }
}

function toAuthSessionSnapshot(
  firebaseSession: HushhResearchFirebaseSession,
  now: number
): Extract<HushhResearchSessionState, { status: "authenticated" }> {
  const createdAt = new Date(firebaseSession.issuedAt).toISOString();
  const user: User = {
    id: firebaseSession.uid,
    aud: "authenticated",
    role: "authenticated",
    email: firebaseSession.email,
    app_metadata: {
      provider: "firebase",
      providers: ["firebase"],
      auth_source: HUSHH_RESEARCH_SOURCE,
      research_link_state: firebaseSession.linkState,
    },
    user_metadata: {
      canonical_user_id: firebaseSession.uid,
      full_name: firebaseSession.displayName,
    },
    identities: [],
    created_at: createdAt,
    updated_at: createdAt,
    last_sign_in_at: createdAt,
    is_anonymous: false,
  };

  const session: Session = {
    access_token: firebaseSession.idToken,
    refresh_token: firebaseSession.refreshToken,
    token_type: "bearer",
    expires_in: Math.max(
      0,
      Math.floor((firebaseSession.expiresAt - now) / 1000)
    ),
    expires_at: Math.floor(firebaseSession.expiresAt / 1000),
    user,
  };

  return { status: "authenticated", session, user };
}

function isValidCallbackInput(
  input: HushhResearchLaunchExchangeInput
): boolean {
  return (
    input.source === HUSHH_RESEARCH_SOURCE &&
    isNonEmptyString(input.code) &&
    input.code.length <= 4096 &&
    isNonEmptyString(input.state) &&
    input.state.length <= 2048
  );
}

export function createHushhResearchAuthClient(
  dependencyOverrides: Partial<HushhResearchAuthClientDependencies> = {}
) {
  const launchCompletionPromises = new Map<
    string,
    Promise<HushhResearchLaunchResult>
  >();
  const trustedIdTokens = new Set<string>();
  let sessionGeneration = 0;
  let authModeActive = false;
  const getDependencies = (): HushhResearchAuthClientDependencies => {
    const hasEveryOverride =
      dependencyOverrides.fetchImpl &&
      dependencyOverrides.storage &&
      dependencyOverrides.location &&
      dependencyOverrides.now;
    if (hasEveryOverride) {
      return dependencyOverrides as HushhResearchAuthClientDependencies;
    }

    return {
      ...getDefaultDependencies(),
      ...dependencyOverrides,
    };
  };

  const readStoredSession = (
    storage: StorageLike
  ): HushhResearchFirebaseSession | null => {
    try {
      const rawValue = storage.getItem(FIREBASE_SESSION_STORAGE_KEY);
      return rawValue ? parseStoredSession(rawValue) : null;
    } catch {
      return null;
    }
  };

  const activateMode = (storage: StorageLike): boolean => {
    authModeActive = true;
    try {
      storage.setItem(FIREBASE_MODE_STORAGE_KEY, FIREBASE_MODE_STORAGE_VALUE);
      return true;
    } catch {
      return false;
    }
  };

  const persistSession = (
    storage: StorageLike,
    session: HushhResearchFirebaseSession
  ): boolean => {
    authModeActive = true;
    try {
      storage.setItem(FIREBASE_MODE_STORAGE_KEY, FIREBASE_MODE_STORAGE_VALUE);
      storage.setItem(FIREBASE_SESSION_STORAGE_KEY, JSON.stringify(session));
      return true;
    } catch {
      try {
        storage.removeItem(FIREBASE_SESSION_STORAGE_KEY);
      } catch {
        // Storage is already unavailable; there is nothing else to clear.
      }
      return false;
    }
  };

  const clearLocalSession = (options: { preserveMode?: boolean } = {}) => {
    sessionGeneration += 1;
    let storage: StorageLike;
    try {
      storage = getDependencies().storage;
    } catch {
      return;
    }

    try {
      storage.removeItem(FIREBASE_SESSION_STORAGE_KEY);
      trustedIdTokens.clear();
      if (!options.preserveMode) {
        storage.removeItem(FIREBASE_MODE_STORAGE_KEY);
      }
    } catch {
      // Local logout is best effort when browser storage is unavailable.
    }
  };

  const isAuthMode = (): boolean => {
    let dependencies: HushhResearchAuthClientDependencies;
    try {
      dependencies = getDependencies();
    } catch {
      return authModeActive;
    }

    if (isHushhResearchAuthRoute(dependencies.location.pathname)) {
      authModeActive = true;
      return true;
    }

    try {
      const persistedMode =
        dependencies.storage.getItem(FIREBASE_MODE_STORAGE_KEY) ===
          FIREBASE_MODE_STORAGE_VALUE ||
        dependencies.storage.getItem(FIREBASE_SESSION_STORAGE_KEY) !== null;
      if (persistedMode) {
        authModeActive = true;
      }
      return authModeActive;
    } catch {
      return authModeActive;
    }
  };

  const getRuntimeConfig = async (): Promise<HushhResearchConfigState> => {
    let dependencies: HushhResearchAuthClientDependencies;
    try {
      dependencies = getDependencies();
    } catch {
      return { status: "disabled", reason: "config_unavailable" };
    }

    if (isProductionHostname(dependencies.location.hostname)) {
      return { status: "disabled", reason: "production_disabled" };
    }

    try {
      const response = await dependencies.fetchImpl(HUSHH_RESEARCH_CONFIG_PATH, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        return { status: "disabled", reason: "config_unavailable" };
      }

      return parsePublicConfig(await readJson(response), dependencies.location);
    } catch {
      return { status: "disabled", reason: "config_unavailable" };
    }
  };

  const exchangeLaunch = async (
    input: HushhResearchLaunchExchangeInput,
    config: HushhResearchPublicConfig,
    fetchImpl: typeof fetch
  ): Promise<HushhResearchLaunchExchangeResponse | null> => {
    try {
      const response = await fetchImpl(HUSHH_RESEARCH_EXCHANGE_PATH, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        return null;
      }

      return parseExchangeResponse(await readJson(response), input, config);
    } catch {
      return null;
    }
  };

  const signInWithCustomToken = async (
    exchange: HushhResearchLaunchExchangeResponse,
    config: HushhResearchPublicConfig,
    dependencies: HushhResearchAuthClientDependencies
  ): Promise<HushhResearchFirebaseSession | null> => {
    const url = new URL(
      "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken"
    );
    url.searchParams.set("key", config.firebase.apiKey);

    try {
      const response = await dependencies.fetchImpl(url.toString(), {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token: exchange.firebase_custom_token,
          returnSecureToken: true,
        }),
      });
      if (!response.ok) {
        return null;
      }

      const firebaseResponse = parseFirebaseCustomTokenResponse(
        await readJson(response)
      );
      const expiresIn = firebaseResponse
        ? parsePositiveInteger(firebaseResponse.expiresIn)
        : null;
      if (
        !firebaseResponse ||
        !expiresIn ||
        firebaseResponse.localId !== exchange.canonical_user_id
      ) {
        return null;
      }

      const claims = decodeAndValidateJwtIdentityClaims(
        firebaseResponse.idToken,
        exchange.canonical_user_id
      );
      if (!claims) {
        return null;
      }
      const issuedAt = dependencies.now();
      const firebaseSession: HushhResearchFirebaseSession = {
        version: 1,
        provider: "firebase",
        projectId: HUSHH_RESEARCH_PROJECT_ID,
        audience: exchange.audience,
        linkState: exchange.link_state,
        launchAuthorizationId: claims.launchAuthorizationId,
        launchValidAfterMs: claims.launchValidAfterMs,
        uid: firebaseResponse.localId,
        idToken: firebaseResponse.idToken,
        refreshToken: firebaseResponse.refreshToken,
        email: firebaseResponse.email || claims.email,
        displayName: firebaseResponse.displayName || claims.name,
        issuedAt,
        expiresAt: issuedAt + expiresIn * 1000,
      };
      return firebaseSession;
    } catch {
      return null;
    }
  };

  const refreshSession = async (
    currentSession: HushhResearchFirebaseSession,
    config: HushhResearchPublicConfig,
    dependencies: HushhResearchAuthClientDependencies
  ): Promise<HushhResearchFirebaseSession | null> => {
    const url = new URL("https://securetoken.googleapis.com/v1/token");
    url.searchParams.set("key", config.firebase.apiKey);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: currentSession.refreshToken,
    });

    try {
      const response = await dependencies.fetchImpl(url.toString(), {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      if (!response.ok) {
        return null;
      }

      const refreshResponse = parseFirebaseRefreshResponse(
        await readJson(response)
      );
      const expiresIn = refreshResponse
        ? parsePositiveInteger(refreshResponse.expires_in)
        : null;
      if (
        !refreshResponse ||
        !expiresIn ||
        refreshResponse.user_id !== currentSession.uid
      ) {
        return null;
      }

      const claims = decodeAndValidateJwtIdentityClaims(
        refreshResponse.id_token,
        currentSession.uid
      );
      if (
        !claims ||
        claims.launchAuthorizationId !==
          currentSession.launchAuthorizationId ||
        claims.launchValidAfterMs !== currentSession.launchValidAfterMs
      ) {
        return null;
      }
      const issuedAt = dependencies.now();
      const refreshedSession: HushhResearchFirebaseSession = {
        ...currentSession,
        idToken: refreshResponse.id_token,
        refreshToken: refreshResponse.refresh_token,
        email: claims.email || currentSession.email,
        displayName: claims.name || currentSession.displayName,
        issuedAt,
        expiresAt: issuedAt + expiresIn * 1000,
      };
      return refreshedSession;
    } catch {
      return null;
    }
  };

  const getSessionState = async (): Promise<HushhResearchSessionState> => {
    const generation = sessionGeneration;
    let dependencies: HushhResearchAuthClientDependencies;
    try {
      dependencies = getDependencies();
    } catch {
      return { status: "inactive" };
    }

    const modeActive = isAuthMode();
    const storedSession = readStoredSession(dependencies.storage);
    if (!storedSession) {
      return { status: modeActive ? "anonymous" : "inactive" };
    }

    const storedClaims = decodeAndValidateJwtIdentityClaims(
      storedSession.idToken,
      storedSession.uid
    );
    if (
      !storedClaims ||
      storedClaims.launchAuthorizationId !==
        storedSession.launchAuthorizationId ||
      storedClaims.launchValidAfterMs !== storedSession.launchValidAfterMs
    ) {
      clearLocalSession({ preserveMode: true });
      return { status: "invalidated", reason: "invalid_session" };
    }

    const configState = await getRuntimeConfig();
    if (generation !== sessionGeneration) {
      return { status: "anonymous" };
    }
    if (
      configState.status !== "enabled" ||
      configState.config.launch.audience !== storedSession.audience
    ) {
      clearLocalSession({ preserveMode: true });
      return { status: "invalidated", reason: "invalid_session" };
    }

    const wasExpired =
      storedSession.expiresAt <=
      dependencies.now() + FIREBASE_REFRESH_WINDOW_MS;
    let activeSession = storedSession;
    if (wasExpired || !trustedIdTokens.has(storedSession.idToken)) {
      const refreshedSession = await refreshSession(
        storedSession,
        configState.config,
        dependencies
      );
      if (generation !== sessionGeneration) {
        return { status: "anonymous" };
      }
      if (!refreshedSession) {
        clearLocalSession({ preserveMode: true });
        return {
          status: "invalidated",
          reason: wasExpired ? "expired" : "invalid_session",
        };
      }
      if (!persistSession(dependencies.storage, refreshedSession)) {
        return { status: "invalidated", reason: "invalid_session" };
      }
      trustedIdTokens.add(refreshedSession.idToken);
      activeSession = refreshedSession;
    }

    return toAuthSessionSnapshot(activeSession, dependencies.now());
  };

  const completeLaunchOnce = async (
    input: HushhResearchLaunchExchangeInput
  ): Promise<HushhResearchLaunchResult> => {
    if (!isValidCallbackInput(input)) {
      return { ok: false, reason: "invalid_callback" };
    }

    let dependencies: HushhResearchAuthClientDependencies;
    try {
      dependencies = getDependencies();
    } catch {
      return { ok: false, reason: "persistence_failed" };
    }

    clearLocalSession({ preserveMode: true });
    const generation = sessionGeneration;
    const configState = await getRuntimeConfig();
    if (generation !== sessionGeneration) {
      return { ok: false, reason: "exchange_rejected" };
    }
    if (configState.status !== "enabled") {
      return { ok: false, reason: "feature_disabled" };
    }

    const exchange = await exchangeLaunch(
      input,
      configState.config,
      dependencies.fetchImpl
    );
    if (generation !== sessionGeneration) {
      return { ok: false, reason: "exchange_rejected" };
    }
    if (!exchange) {
      return { ok: false, reason: "exchange_rejected" };
    }

    if (!activateMode(dependencies.storage)) {
      return { ok: false, reason: "persistence_failed" };
    }

    const firebaseSession = await signInWithCustomToken(
      exchange,
      configState.config,
      dependencies
    );
    if (generation !== sessionGeneration) {
      return { ok: false, reason: "firebase_sign_in_failed" };
    }
    if (!firebaseSession) {
      clearLocalSession({ preserveMode: true });
      return { ok: false, reason: "firebase_sign_in_failed" };
    }

    if (!persistSession(dependencies.storage, firebaseSession)) {
      return { ok: false, reason: "persistence_failed" };
    }
    trustedIdTokens.add(firebaseSession.idToken);

    return {
      ok: true,
      uid: firebaseSession.uid,
      linkState: firebaseSession.linkState,
    };
  };

  const completeLaunch = (
    input: HushhResearchLaunchExchangeInput
  ): Promise<HushhResearchLaunchResult> => {
    const completionKey = JSON.stringify([
      input.code,
      input.state,
      input.source,
    ]);
    const existingCompletion = launchCompletionPromises.get(completionKey);
    if (existingCompletion) {
      return existingCompletion;
    }

    const completion = completeLaunchOnce(input);
    launchCompletionPromises.set(completionKey, completion);
    return completion;
  };

  const startLaunch = async (): Promise<HushhResearchLaunchStartResult> => {
    let dependencies: HushhResearchAuthClientDependencies;
    try {
      dependencies = getDependencies();
    } catch {
      return { ok: false, reason: "start_rejected" };
    }

    const configState = await getRuntimeConfig();
    if (configState.status !== "enabled") {
      return { ok: false, reason: "feature_disabled" };
    }

    let response: Response;
    try {
      response = await dependencies.fetchImpl(configState.config.launch.startPath, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source: HUSHH_RESEARCH_SOURCE }),
      });
    } catch {
      return { ok: false, reason: "start_rejected" };
    }

    if (!response.ok) {
      return { ok: false, reason: "start_rejected" };
    }

    const payload = await readJson(response);
    if (
      !isRecord(payload) ||
      !isNonEmptyString(payload.launch_url) ||
      !isPositiveNumber(payload.expires_in) ||
      payload.expires_in > 60
    ) {
      return { ok: false, reason: "invalid_launch_url" };
    }

    try {
      const launchUrl = new URL(payload.launch_url);
      if (
        launchUrl.protocol !== "https:" ||
        launchUrl.origin !== HUSHH_RESEARCH_LAUNCH_ORIGIN ||
        launchUrl.pathname !== HUSHH_RESEARCH_LAUNCH_PATH ||
        launchUrl.username ||
        launchUrl.password ||
        launchUrl.hash
      ) {
        return { ok: false, reason: "invalid_launch_url" };
      }

      return {
        ok: true,
        launchUrl: launchUrl.toString(),
        expiresIn: payload.expires_in,
      };
    } catch {
      return { ok: false, reason: "invalid_launch_url" };
    }
  };

  return {
    clearLocalSession,
    completeLaunch,
    getRuntimeConfig,
    getSessionState,
    isAuthMode,
    startLaunch,
  };
}

const defaultClient = createHushhResearchAuthClient();

export function clearHushhResearchLocalSession(options?: {
  preserveMode?: boolean;
}) {
  defaultClient.clearLocalSession(options);
}

export function completeHushhResearchLaunch(
  input: HushhResearchLaunchExchangeInput
) {
  return defaultClient.completeLaunch(input);
}

export function getHushhResearchRuntimeConfig() {
  return defaultClient.getRuntimeConfig();
}

export function getHushhResearchSessionState() {
  return defaultClient.getSessionState();
}

export function isHushhResearchAuthMode() {
  return defaultClient.isAuthMode();
}

export function startHushhResearchLaunch() {
  return defaultClient.startLaunch();
}

export function getHushhResearchLaunchFailureMessage(
  reason: HushhResearchLaunchFailureReason
): string {
  switch (reason) {
    case "invalid_callback":
      return "Open a new link.";
    case "feature_disabled":
      return "Sign-in is unavailable.";
    case "exchange_rejected":
      return "This link has expired.";
    case "firebase_sign_in_failed":
      return "Sign-in could not finish.";
    case "persistence_failed":
      return "Enable browser storage.";
  }
}

export function getHushhResearchLaunchStartFailureMessage(
  reason: HushhResearchLaunchStartFailureReason
): string {
  switch (reason) {
    case "feature_disabled":
      return "Launch is unavailable.";
    case "start_rejected":
      return "Launch could not start.";
    case "invalid_launch_url":
      return "Launch could not start.";
  }
}
