import { RuntimeError } from "../errors.js";
import {
  buildCreateLinkTokenRequest,
  PLAID_BACKGROUND_PRODUCTS,
  PLAID_DATA_PRODUCTS,
  PLAID_IMMEDIATE_PRODUCTS,
} from "./plaid-client.js";
import {
  ensureProductStatuses,
  summarizeProductResults,
  syncPlaidDataProduct,
} from "./plaid-data-sync.js";

export const FINANCIAL_LINK_KMS_ENVELOPE_PROTECTION = "cloud_kms_envelope_v1";
export const PLAID_SYNC_LOCK_WINDOW_MS = 60_000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIAGNOSTIC_ACCESS_STATES = new Set([
  "not_started",
  "payment_in_review",
  "rejected_investor",
  "verified_investor",
]);
const SAFE_DIAGNOSTIC_CODES = new Set([
  "API_ERROR",
  "INSTITUTION_DOWN",
  "INSTITUTION_ERROR",
  "INVALID_INPUT",
  "INVALID_LINK_TOKEN",
  "INVALID_PUBLIC_TOKEN",
  "INVALID_REQUEST",
  "ITEM_ERROR",
  "ITEM_LOGIN_REQUIRED",
  "OAUTH_ERROR",
  "PRODUCT_NOT_READY",
  "RATE_LIMIT_EXCEEDED",
  "RECAPTCHA_ERROR",
]);
const SAFE_PLAID_EVENT_CODES = new Set([
  "ERROR",
  "EXIT",
  "HANDOFF",
  "OPEN",
  "SELECT_INSTITUTION",
  "SUBMIT_CREDENTIALS",
  "TRANSITION_VIEW",
]);
const SAFE_PLAID_VIEW_CODES = new Set([
  "CONNECTED",
  "CONSENT",
  "CREDENTIAL",
  "ERROR",
  "EXIT",
  "HANDOFF",
  "OAUTH",
  "SELECT_ACCOUNT",
  "SELECT_INSTITUTION",
]);
const DIAGNOSTIC_SENSITIVE_TEXT =
  /(?:bearer\s+|(?:access|public|refresh|service)[_-]?token|(?:access|public|link)-(?:sandbox|development|production)-[A-Za-z0-9_-]+|authorization|cookie|credential|secret|password|passcode|api[_-]?key|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;
// These modes are route-derived inside this module. They are deliberately
// not request input: the two preserved Supabase slugs have the same browser
// wire contract but differed only in whether the start route attempted the
// 60-second item lock.
const PLAID_SYNC_MODES = Object.freeze({
  start: Object.freeze({
    queueSource: "plaid-data-sync-start",
    acquireLock: true,
  }),
  legacy: Object.freeze({
    queueSource: "plaid-data-sync",
    acquireLock: false,
  }),
});

function runtimeError(code, message, statusCode, diagnosticCode) {
  return new RuntimeError(code, message, statusCode, { diagnosticCode });
}

// The source whole-flow handlers launch their background product fanout with
// EdgeRuntime.waitUntil() and only log a later failure.  Keep GCP enqueue and
// publish failures off the existing browser contract too, while retaining a
// bounded, credential-free signal in service logs for operational follow-up.
function reportBackgroundSyncFailure(source, phase, error) {
  const diagnosticCode = error instanceof RuntimeError
    ? error.diagnosticCode || error.code
    : "FINANCIAL_BACKGROUND_SYNC_SCHEDULING_FAILED";
  console.warn(`[${source}] Background sync ${phase} failed`, {
    diagnostic_code: diagnosticCode,
  });
}

function nowDate(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Financial link clock is invalid.");
  return date;
}

function nowIso(now) {
  return nowDate(now).toISOString();
}

function validUid(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function requireOwner(actor, userId) {
  if (!validUid(userId)) {
    throw runtimeError("INVALID_REQUEST", "userId is required", 400, "USER_ID_INVALID");
  }
  if (!actor || !validUid(actor.uid) || actor.uid !== userId) {
    throw runtimeError("ACCESS_DENIED", "Access denied.", 403, "FIREBASE_OWNER_MISMATCH");
  }
  return Object.freeze({
    uid: actor.uid,
    email: typeof actor.email === "string" ? actor.email.trim().toLowerCase() : null,
  });
}

async function resolveFinancialPrincipal(repository, owner) {
  const resolve = requireMethod(
    repository,
    "resolveFinancialPrincipal",
    "FINANCIAL_REPOSITORY",
  );
  const principal = await resolve({ firebaseUid: owner.uid });
  const legacyUserUuid = String(
    principal?.legacyUserUuid ?? principal?.legacy_user_uuid ?? "",
  );
  if (!UUID_PATTERN.test(legacyUserUuid)) {
    throw runtimeError(
      "FINANCIAL_PRINCIPAL_UNAVAILABLE",
      "Financial link is unavailable.",
      503,
      "LEGACY_UUID_PRINCIPAL_REQUIRED",
    );
  }
  return Object.freeze({
    firebaseUid: owner.uid,
    legacyUserUuid: legacyUserUuid.toLowerCase(),
  });
}

function requireMethod(target, method, label) {
  if (!target || target.configured !== true || typeof target[method] !== "function") {
    throw runtimeError(
      "FINANCIAL_LINK_ADAPTER_UNAVAILABLE",
      "Financial service is unavailable.",
      503,
      `${label}_${method}_MISSING`,
    );
  }
  return target[method].bind(target);
}

function assertTokenEnvelope(tokenEnvelope) {
  if (
    !tokenEnvelope ||
    tokenEnvelope.configured !== true ||
    tokenEnvelope.protection !== FINANCIAL_LINK_KMS_ENVELOPE_PROTECTION ||
    typeof tokenEnvelope.seal !== "function" ||
    typeof tokenEnvelope.open !== "function"
  ) {
    throw runtimeError(
      "TOKEN_ENVELOPE_UNAVAILABLE",
      "Financial service is unavailable.",
      503,
      "PLAID_TOKEN_KMS_ENVELOPE_REQUIRED",
    );
  }
  return tokenEnvelope;
}

function assertSyncQueue(syncQueue) {
  if (
    !syncQueue ||
    syncQueue.configured !== true ||
    typeof syncQueue.enqueueProducts !== "function" ||
    typeof syncQueue.publishProducts !== "function"
  ) {
    throw runtimeError(
      "FINANCIAL_SYNC_QUEUE_UNAVAILABLE",
      "Financial service is unavailable.",
      503,
      "PLAID_SYNC_QUEUE_REQUIRED",
    );
  }
  return syncQueue;
}

function assertRepository(repository) {
  if (!repository || repository.configured !== true) {
    throw runtimeError(
      "FINANCIAL_LINK_ADAPTER_UNAVAILABLE",
      "Financial service is unavailable.",
      503,
      "FINANCIAL_LINK_REPOSITORY_REQUIRED",
    );
  }
  return repository;
}

function safeRedirect(value, allowedRedirectOrigins) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw runtimeError("INVALID_REDIRECT", "Invalid redirect.", 400, "REDIRECT_INVALID");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw runtimeError("INVALID_REDIRECT", "Invalid redirect.", 400, "REDIRECT_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !allowedRedirectOrigins.has(url.origin)
  ) {
    throw runtimeError("INVALID_REDIRECT", "Invalid redirect.", 400, "REDIRECT_ORIGIN_DENIED");
  }
  return url.toString();
}

function normalizedEmail(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 320 || !EMAIL_PATTERN.test(value.trim())) {
    throw runtimeError("INVALID_REQUEST", "Invalid email.", 400, "EMAIL_INVALID");
  }
  return value.trim().toLowerCase();
}

function normalizeSelectedAccounts(accounts) {
  if (accounts === undefined || accounts === null) return [];
  if (!Array.isArray(accounts) || accounts.length > 32) {
    throw runtimeError("INVALID_REQUEST", "Invalid accounts.", 400, "ACCOUNT_SELECTION_INVALID");
  }
  return accounts.map((account) => {
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      throw runtimeError("INVALID_REQUEST", "Invalid accounts.", 400, "ACCOUNT_SELECTION_INVALID");
    }
    const accountId = account.id || account.account_id;
    if (typeof accountId !== "string" || !accountId.trim() || accountId.length > 256) {
      throw runtimeError("INVALID_REQUEST", "Invalid accounts.", 400, "ACCOUNT_SELECTION_INVALID");
    }
    return {
      account_id: accountId.trim(),
      name: typeof account.name === "string" && account.name ? account.name : "Linked account",
      mask: typeof account.mask === "string" ? account.mask : null,
      subtype: typeof account.subtype === "string" ? account.subtype : null,
      type: typeof account.type === "string" ? account.type : null,
    };
  });
}

function projectExchangeAccount(account) {
  return {
    account_id: account.account_id,
    name: account.name || account.official_name || "Linked account",
    official_name: account.official_name || null,
    mask: account.mask || null,
    type: account.type || null,
    subtype: account.subtype || null,
  };
}

function productsRequested(configuration) {
  return [...new Set([
    ...configuration.primaryProducts,
    "auth",
    "identity",
    "transactions",
    "investments",
    "liabilities",
    "signal",
  ])];
}

function truncateText(value, limit) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > limit ? text.slice(0, limit) : text;
}

function safeDiagnosticText(value, limit) {
  const text = truncateText(value, limit);
  return text && DIAGNOSTIC_SENSITIVE_TEXT.test(text) ? "redacted" : text;
}

function truncateJson(value) {
  if (!value || typeof value !== "object") return value;
  const serialized = JSON.stringify(value);
  if (serialized.length <= 16_000) return value;
  return {
    __truncated: true,
    __original_bytes: serialized.length,
    sample: serialized.slice(0, 16_000),
  };
}

function diagnosticObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function diagnosticBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function diagnosticInteger(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function diagnosticNumber(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function diagnosticCode(value, allowed = SAFE_DIAGNOSTIC_CODES) {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function diagnosticPresence(value) {
  return typeof value === "string" && value.length > 0 ? true : null;
}

// This route stays lossy and accepts the legacy anonymous payload shape, but
// it must not turn a fire-and-forget browser diagnostic into persisted Plaid
// credentials or user PII. Keep only bounded facts that the existing support
// flow needs; the response and acceptance semantics remain unchanged.
function sanitizeDiagnostics({ pageState, plaidMetadata, errorDetails, browserContext }) {
  const page = diagnosticObject(pageState);
  const plaid = diagnosticObject(plaidMetadata);
  const error = diagnosticObject(errorDetails);
  const browser = diagnosticObject(browserContext);
  const viewport = diagnosticObject(browser.viewport);
  return Object.freeze({
    pageState: Object.freeze({
      isReviewMode: diagnosticBoolean(page.isReviewMode),
      useSandboxDirectConnect: diagnosticBoolean(page.useSandboxDirectConnect),
      blockLocalPlaidLink: diagnosticBoolean(page.blockLocalPlaidLink),
      isPlaidOAuthResume: diagnosticBoolean(page.isPlaidOAuthResume),
      isCompleted: diagnosticBoolean(page.isCompleted),
      hasOAuthStateId: diagnosticBoolean(page.hasOAuthStateId),
      currentStep: diagnosticInteger(page.currentStep, 0, 100),
      accessState: DIAGNOSTIC_ACCESS_STATES.has(page.accessState) ? page.accessState : null,
    }),
    plaidMetadata: Object.freeze({
      eventName: diagnosticCode(plaid.eventName, SAFE_PLAID_EVENT_CODES),
      viewName: diagnosticCode(plaid.viewName, SAFE_PLAID_VIEW_CODES),
      errorCode: diagnosticCode(plaid.errorCode ?? plaid.error_code),
      errorType: diagnosticCode(plaid.errorType ?? plaid.error_type),
      accountsCount: diagnosticInteger(plaid.accountsCount, 0, 32),
      productsAvailable: diagnosticInteger(plaid.productsAvailable, 0, PLAID_DATA_PRODUCTS.length),
      canProceed: diagnosticBoolean(plaid.canProceed),
      institutionPresent:
        diagnosticPresence(plaid.institutionName) ?? diagnosticPresence(plaid.institutionId),
      itemPresent: diagnosticPresence(plaid.itemId),
      requestPresent: diagnosticPresence(plaid.requestId),
      oauthStatePresent: diagnosticPresence(plaid.oauthStateId),
    }),
    errorDetails: Object.freeze({
      errorCode: diagnosticCode(error.errorCode ?? error.error_code ?? error.code),
      errorType: diagnosticCode(error.errorType ?? error.error_type),
      lineNumber: diagnosticInteger(error.lineNumber, 0, 10_000_000),
      columnNumber: diagnosticInteger(error.columnNumber, 0, 10_000_000),
      hasMessage: diagnosticPresence(error.message),
      hasDisplayMessage: diagnosticPresence(error.displayMessage ?? error.display_message),
      hasStack: diagnosticPresence(error.stack),
    }),
    browserContext: Object.freeze({
      online: diagnosticBoolean(browser.online),
      viewportWidth: diagnosticInteger(viewport.width, 0, 20_000),
      viewportHeight: diagnosticInteger(viewport.height, 0, 20_000),
      devicePixelRatio: diagnosticNumber(browser.devicePixelRatio, 0.1, 16),
    }),
  });
}

function diagnosticsRecord({ userId, sessionId, eventType, plaidStep, pageState, plaidMetadata, errorDetails, browserContext }) {
  if (!eventType) return null;
  const diagnostics = sanitizeDiagnostics({ pageState, plaidMetadata, errorDetails, browserContext });
  return {
    // The legacy endpoint derived the authenticated user and ignored the
    // caller-provided `user_id`; retain that ownership behavior exactly. The
    // repository resolves Firebase identity before this reaches UUID-owned SQL.
    userId: UUID_PATTERN.test(String(userId ?? "")) ? String(userId).toLowerCase() : null,
    sessionId: typeof sessionId === "string" && sessionId.length === 36 ? sessionId : null,
    eventType: safeDiagnosticText(eventType, 64),
    plaidStep: safeDiagnosticText(plaidStep, 32),
    pageState: truncateJson(diagnostics.pageState),
    plaidMetadata: truncateJson(diagnostics.plaidMetadata),
    errorDetails: truncateJson(diagnostics.errorDetails),
    browserContext: truncateJson(diagnostics.browserContext),
  };
}

function itemContext(item) {
  return {
    purpose: "plaid_access_token",
    userId: item.userId,
    plaidItemId: item.plaidItemId,
  };
}

function assertActiveItem(item, userId) {
  if (
    !item ||
    item.userId !== userId ||
    typeof item.plaidItemId !== "string" ||
    !item.plaidItemId ||
    !item.accessTokenEnvelope
  ) {
    throw runtimeError(
      "PLAID_ITEM_NOT_FOUND",
      "No active Plaid Item found for this user",
      404,
      "ACTIVE_PLAID_ITEM_REQUIRED",
    );
  }
  return item;
}

/**
 * The isolated GCP domain adapter for the pre-existing financial-link flow.
 * It intentionally contains no route registration, registry promotion, or
 * deployment code: those remain governed separately.  Every dependency is a
 * narrow injected boundary so the eventual Cloud SQL/KMS/Cloud Tasks adapters
 * can be independently verified without adding a second Plaid architecture.
 */
export function createFinancialLinkAdapter({
  plaid,
  repository,
  tokenEnvelope,
  syncQueue,
  allowedRedirectOrigins = [],
  now = Date.now,
} = {}) {
  if (!plaid || plaid.configured !== true || typeof plaid.post !== "function") {
    throw new Error("Configured Plaid client is required.");
  }
  assertRepository(repository);
  assertTokenEnvelope(tokenEnvelope);
  assertSyncQueue(syncQueue);
  const redirectOrigins = new Set(
    allowedRedirectOrigins.map((origin) => String(origin).trim()).filter(Boolean),
  );

  async function createLinkToken({
    actor,
    userId,
    userEmail,
    redirectUri,
    receivedRedirectUri,
    signal,
  } = {}) {
    const owner = requireOwner(actor, userId);
    const principal = await resolveFinancialPrincipal(repository, owner);
    const requestedEmail = normalizedEmail(userEmail);
    const verifiedEmail = normalizedEmail(owner.email);
    if (requestedEmail && requestedEmail !== verifiedEmail) {
      throw runtimeError("ACCESS_DENIED", "Access denied.", 403, "PLAID_EMAIL_OWNER_MISMATCH");
    }
    const payload = {
      userId: principal.legacyUserUuid,
      userEmail: verifiedEmail,
      redirectUri: safeRedirect(redirectUri, redirectOrigins),
      receivedRedirectUri: safeRedirect(receivedRedirectUri, redirectOrigins),
    };
    const body = buildCreateLinkTokenRequest({
      config: plaid.configuration,
      ...payload,
    });
    const { data } = await plaid.post("/link/token/create", body, { signal });
    if (typeof data?.link_token !== "string" || typeof data?.expiration !== "string") {
      throw runtimeError(
        "PLAID_PROVIDER_RESPONSE_INVALID",
        "Failed to create link token",
        502,
        "PLAID_LINK_TOKEN_RESPONSE_INVALID",
      );
    }
    return { link_token: data.link_token, expiration: data.expiration };
  }

  async function exchangePublicToken({
    actor,
    publicToken,
    userId,
    institutionName = null,
    institutionId = null,
    accounts,
    signal,
  } = {}) {
    const owner = requireOwner(actor, userId);
    const principal = await resolveFinancialPrincipal(repository, owner);
    if (typeof publicToken !== "string" || !publicToken.trim() || publicToken.length > 1_024) {
      throw runtimeError("INVALID_REQUEST", "publicToken is required", 400, "PUBLIC_TOKEN_INVALID");
    }
    const normalizedInstitutionName = institutionName == null
      ? null
      : truncateText(institutionName, 256);
    const normalizedInstitutionId = institutionId == null
      ? null
      : truncateText(institutionId, 128);
    const selectedAccounts = normalizeSelectedAccounts(accounts);
    const payload = {
      publicToken: publicToken.trim(),
      userId: principal.legacyUserUuid,
      institutionName: normalizedInstitutionName,
      institutionId: normalizedInstitutionId,
      accounts: selectedAccounts,
    };

    const { data } = await plaid.post("/item/public_token/exchange", {
      public_token: payload.publicToken,
    }, { signal });
    if (typeof data?.access_token !== "string" || typeof data?.item_id !== "string") {
      throw runtimeError(
        "PLAID_PROVIDER_RESPONSE_INVALID",
        "Failed to exchange token",
        502,
        "PLAID_EXCHANGE_RESPONSE_INVALID",
      );
    }

    const item = {
      userId: principal.legacyUserUuid,
      plaidItemId: data.item_id,
      institutionId: payload.institutionId,
      institutionName: payload.institutionName,
    };
    const accessTokenEnvelope = await tokenEnvelope.seal({
      plaintext: data.access_token,
      context: itemContext(item),
      signal,
    });
    if (!accessTokenEnvelope || accessTokenEnvelope === data.access_token) {
      throw runtimeError(
        "TOKEN_ENVELOPE_UNAVAILABLE",
        "Financial service is unavailable.",
        503,
        "PLAID_ACCESS_TOKEN_NOT_SEALED",
      );
    }

    const upsertItem = requireMethod(repository, "upsertPlaidItem", "FINANCIAL_REPOSITORY");
    const setFinancialLinkStatus = requireMethod(repository, "setFinancialLinkStatus", "FINANCIAL_REPOSITORY");
    const upsertAccounts = requireMethod(repository, "upsertPlaidAccounts", "FINANCIAL_REPOSITORY");
    const timestamp = nowIso(now);
    await upsertItem({
      ...item,
      accessTokenEnvelope,
      productsRequested: productsRequested(plaid.configuration),
      webhookUrl: plaid.configuration.dataWebhookUrl || null,
      status: "active",
      errorCode: null,
      errorMessage: null,
      updatedAt: timestamp,
    });
    await setFinancialLinkStatus({ userId: principal.legacyUserUuid, status: "pending", updatedAt: timestamp });

    let accountsForUi = selectedAccounts;
    try {
      const { data: accountsData } = await plaid.post("/accounts/get", {
        access_token: data.access_token,
      }, { signal });
      if (Array.isArray(accountsData?.accounts)) accountsForUi = accountsData.accounts;
    } catch {
      // Preserve the existing best-effort accounts fetch.  The exchange is
      // valid even when the optional initial account refresh is unavailable.
    }
    if (accountsForUi.length > 0) {
      await upsertAccounts({
        userId: principal.legacyUserUuid,
        plaidItemId: data.item_id,
        accounts: accountsForUi,
        updatedAt: nowIso(now),
      });
    }
    return {
      item_id: data.item_id,
      institution: { name: payload.institutionName, id: payload.institutionId },
      accounts: accountsForUi.map(projectExchangeAccount),
    };
  }

  async function loadItemAndToken({ userId, itemId, signal }) {
    const getActivePlaidItem = requireMethod(repository, "getActivePlaidItem", "FINANCIAL_REPOSITORY");
    const item = assertActiveItem(
      await getActivePlaidItem({ userId, plaidItemId: itemId || null }),
      userId,
    );
    const accessToken = await tokenEnvelope.open({
      envelope: item.accessTokenEnvelope,
      context: itemContext(item),
      signal,
    });
    if (typeof accessToken !== "string" || !accessToken) {
      throw runtimeError(
        "TOKEN_ENVELOPE_UNAVAILABLE",
        "Financial service is unavailable.",
        503,
        "PLAID_ACCESS_TOKEN_UNSEAL_INVALID",
      );
    }
    return { item, accessToken };
  }

  async function currentSyncResponse({ userId, item }) {
    const listProductStatuses = requireMethod(repository, "listProductStatuses", "FINANCIAL_REPOSITORY");
    const statuses = await listProductStatuses({ userId, plaidItemId: item.plaidItemId });
    const availableProducts = {};
    let productsAvailable = 0;
    for (const row of Array.isArray(statuses) ? statuses : []) {
      if (!PLAID_DATA_PRODUCTS.includes(row?.product)) continue;
      availableProducts[row.product] = Boolean(row.available);
      if (row.available) productsAvailable += 1;
    }
    return {
      status: "partial",
      item_id: item.plaidItemId,
      institution: { id: item.institutionId || null, name: item.institutionName || null },
      available_products: availableProducts,
      products_available: productsAvailable,
      fetch_errors: {},
      can_proceed: Boolean(
        availableProducts.accounts &&
        availableProducts.balance &&
        availableProducts.auth,
      ),
      sync_in_progress: true,
      background_products: [...PLAID_BACKGROUND_PRODUCTS],
      background_sync_started: false,
    };
  }

  async function runPlaidDataSync({
    actor,
    userId,
    itemId = null,
    signal,
    mode,
  } = {}) {
    const owner = requireOwner(actor, userId);
    const principal = await resolveFinancialPrincipal(repository, owner);
    const payload = {
      userId: principal.legacyUserUuid,
      itemId: itemId == null || itemId === "" ? null : truncateText(itemId, 256),
    };
    const { item, accessToken } = await loadItemAndToken({
      userId: principal.legacyUserUuid,
      itemId: payload.itemId,
      signal,
    });
    await ensureProductStatuses({
      repository,
      userId: principal.legacyUserUuid,
      plaidItemId: item.plaidItemId,
      now,
    });

    if (mode.acquireLock) {
      let lockAcquired = true;
      try {
        const tryAcquireSyncLock = requireMethod(repository, "tryAcquireSyncLock", "FINANCIAL_REPOSITORY");
        const timestamp = nowDate(now);
        lockAcquired = Boolean(await tryAcquireSyncLock({
          plaidItemId: item.plaidItemId,
          startedAt: timestamp.toISOString(),
          cutoffAt: new Date(timestamp.getTime() - PLAID_SYNC_LOCK_WINDOW_MS).toISOString(),
        }));
      } catch {
        // The Supabase implementation explicitly failed open when the lock
        // column was unavailable. Preserve that behavior, while normal UAT
        // deployment still proves the Cloud SQL lock is present.
        lockAcquired = true;
      }
      if (!lockAcquired) return currentSyncResponse({ userId: principal.legacyUserUuid, item });
    }

    const immediateResults = [];
    for (const product of PLAID_IMMEDIATE_PRODUCTS) {
      immediateResults.push(await syncPlaidDataProduct({
        repository,
        plaid,
        userId: principal.legacyUserUuid,
        item,
        accessToken,
        product,
        signal,
        now,
      }));
    }

    // Persist the task intents before returning whenever the outbox is
    // available, then publish them outside the browser response. The source
    // function starts this work with waitUntil(backgroundSync) and logs a
    // background failure rather than replacing its immediate summary with a
    // 500. Match that user-facing contract if Cloud SQL/outbox scheduling is
    // temporarily unavailable too; no browser retry or replay is introduced.
    let jobs = null;
    try {
      jobs = await syncQueue.enqueueProducts({
        // The private worker receives this value only in a Cloud Tasks
        // header after the durable job has bound it to the legacy UUID.
        // It is never accepted from a browser request.
        firebaseUid: owner.uid,
        userId: principal.legacyUserUuid,
        plaidItemId: item.plaidItemId,
        products: [...PLAID_BACKGROUND_PRODUCTS],
        source: mode.queueSource,
        signal,
      });
    } catch (error) {
      reportBackgroundSyncFailure(mode.queueSource, "enqueue", error);
    }
    if (jobs) {
      void Promise.resolve(syncQueue.publishProducts({ jobs })).catch((error) => {
        // The outbox remains an auditable PENDING record if publication fails.
        // Preserve the source route's non-blocking background-error behavior
        // without adding an application-level browser replay or retry.
        reportBackgroundSyncFailure(mode.queueSource, "publish", error);
      });
    }
    const summary = summarizeProductResults(immediateResults);
    if (summary.can_proceed) {
      const setFinancialLinkStatus = requireMethod(repository, "setFinancialLinkStatus", "FINANCIAL_REPOSITORY");
      await setFinancialLinkStatus({
        userId: principal.legacyUserUuid,
        status: "completed",
        updatedAt: nowIso(now),
      });
    }
    return {
      ...summary,
      item_id: item.plaidItemId,
      institution: { id: item.institutionId || null, name: item.institutionName || null },
      background_products: [...PLAID_BACKGROUND_PRODUCTS],
      background_sync_started: true,
    };
  }

  // Keep public adapter methods fixed to route semantics. The handler cannot
  // choose the mode from untrusted request data.
  async function startPlaidDataSync(input = {}) {
    return runPlaidDataSync({ ...input, mode: PLAID_SYNC_MODES.start });
  }

  async function syncPlaidData(input = {}) {
    return runPlaidDataSync({ ...input, mode: PLAID_SYNC_MODES.legacy });
  }

  /**
   * Private worker-only operation for the existing product-sync behavior.
   * The runtime authenticates the Cloud Task caller separately; this domain
   * boundary then requires the repository/outbox to prove that the task owns
   * this UUID principal, item, and product before it can unseal a token.
   */
  async function syncProduct({ legacyUserUuid, userId, itemId = null, product, job, signal } = {}) {
    const principalUserId = legacyUserUuid || userId;
    if (!UUID_PATTERN.test(String(principalUserId ?? ""))) {
      throw runtimeError(
        "INVALID_REQUEST",
        "A UUID principal is required",
        400,
        "LEGACY_UUID_PRINCIPAL_REQUIRED",
      );
    }
    const normalizedPrincipalUserId = String(principalUserId).toLowerCase();
    if (!PLAID_DATA_PRODUCTS.includes(product) || !job || typeof job !== "object") {
      throw runtimeError(
        "INVALID_REQUEST",
        "A verified product sync job is required",
        400,
        "PRODUCT_SYNC_JOB_INVALID",
      );
    }
    // A Cloud Task is not itself a data-ownership proof.  Validate the
    // durable job binding before loading the item or asking KMS to decrypt an
    // access-token envelope.  This is stricter than the old Edge function
    // (which had no durable worker) while preserving its product result.
    const verifyQueuedProductSyncJob = requireMethod(
      repository,
      "verifyQueuedProductSyncJob",
      "FINANCIAL_REPOSITORY",
    );
    const requestedItemId = itemId || job.plaidItemId || job.plaid_item_id || null;
    const verified = await verifyQueuedProductSyncJob({
      job,
      legacyUserUuid: normalizedPrincipalUserId,
      plaidItemId: requestedItemId,
      product,
      signal,
    });
    if (verified !== true) {
      throw runtimeError(
        "ACCESS_DENIED",
        "Access denied.",
        403,
        "PRODUCT_SYNC_JOB_OWNERSHIP_DENIED",
      );
    }
    const { item, accessToken } = await loadItemAndToken({
      userId: normalizedPrincipalUserId,
      itemId: requestedItemId,
      signal,
    });
    if (item.plaidItemId !== requestedItemId) {
      throw runtimeError(
        "ACCESS_DENIED",
        "Access denied.",
        403,
        "PRODUCT_SYNC_JOB_ITEM_MISMATCH",
      );
    }
    await ensureProductStatuses({
      repository,
      userId: normalizedPrincipalUserId,
      plaidItemId: item.plaidItemId,
      now,
    });
    return syncPlaidDataProduct({
      repository,
      plaid,
      userId: normalizedPrincipalUserId,
      item,
      accessToken,
      product,
      signal,
      now,
    });
  }

  /**
   * Preserve the exported Firebase browser contract for
   * `plaid-data-sync-product`. The source edge function synchronously loaded
   * the caller-owned item and performed this exact product operation; it did
   * not create a durable job or replay failed browser requests. Cloud Tasks
   * remain limited to the source-equivalent background work started by the
   * two full-sync routes.
   */
  async function syncProductForUser({ actor, userId, itemId = null, product, signal } = {}) {
    const owner = requireOwner(actor, userId);
    const principal = await resolveFinancialPrincipal(repository, owner);
    if (!PLAID_DATA_PRODUCTS.includes(product)) {
      throw runtimeError(
        "INVALID_REQUEST",
        "Valid product is required",
        400,
        "PLAID_PRODUCT_INVALID",
      );
    }
    const { item, accessToken } = await loadItemAndToken({
      userId: principal.legacyUserUuid,
      itemId,
      signal,
    });
    await ensureProductStatuses({
      repository,
      userId: principal.legacyUserUuid,
      plaidItemId: item.plaidItemId,
      now,
    });
    const result = await syncPlaidDataProduct({
      repository,
      plaid,
      userId: principal.legacyUserUuid,
      item,
      accessToken,
      product,
      signal,
      now,
    });
    return {
      success: true,
      item_id: item.plaidItemId,
      result: {
        product: result.product,
        status: result.status,
        available: result.available,
        recordsCount: result.recordsCount ?? null,
        error: result.error || null,
        errorCode: result.errorCode || null,
      },
    };
  }

  /**
   * Preserve the standalone asset-report-create branch. It is a legacy
   * authenticated endpoint contract separate from the normal sync-created
   * report and intentionally returns only Plaid's report polling token.
   */
  async function createAssetReport({ actor, accessToken, signal } = {}) {
    // The source route authenticates the caller but has no body user ID to
    // resolve. Keep that same identity boundary without accepting a claimed
    // principal or persisting the browser-provided access token.
    requireOwner(actor, actor?.uid);
    if (
      typeof accessToken !== "string" ||
      !accessToken.trim() ||
      accessToken.length > 4_096 ||
      /[\u0000-\u001f\u007f]/.test(accessToken)
    ) {
      throw runtimeError(
        "INVALID_REQUEST",
        "accessToken is required",
        400,
        "ASSET_REPORT_ACCESS_TOKEN_INVALID",
      );
    }
    const { data } = await plaid.post("/asset_report/create", {
      access_tokens: [accessToken.trim()],
      days_requested: 60,
    }, { signal });
    const assetReportToken = typeof data?.asset_report_token === "string"
      ? data.asset_report_token
      : null;
    const assetReportId = typeof data?.asset_report_id === "string"
      ? data.asset_report_id
      : null;
    if (!assetReportToken || !assetReportId) {
      throw runtimeError(
        "PLAID_ASSET_REPORT_INVALID",
        "Plaid did not return an asset report.",
        502,
      );
    }
    return Object.freeze({
      status: "pending",
      asset_report_token: assetReportToken,
      asset_report_id: assetReportId,
    });
  }

  /**
   * Preserve the existing authenticated asset-report poll. The stored report
   * token must belong to this Firebase principal before it reaches Plaid.
   */
  async function getAssetReport({ actor, userId, assetReportToken, signal } = {}) {
    const owner = requireOwner(actor, userId);
    const principal = await resolveFinancialPrincipal(repository, owner);
    if (
      typeof assetReportToken !== "string" ||
      !assetReportToken.trim() ||
      assetReportToken.length > 4_096
    ) {
      throw runtimeError(
        "INVALID_REQUEST",
        "assetReportToken is required",
        400,
        "ASSET_REPORT_TOKEN_INVALID",
      );
    }
    const getFinancialData = requireMethod(repository, "getFinancialData", "FINANCIAL_REPOSITORY");
    const financialData = await getFinancialData({ userId: principal.legacyUserUuid });
    const storedToken = financialData?.asset_report_token || financialData?.assetReportToken || null;
    if (storedToken !== assetReportToken.trim()) {
      throw runtimeError(
        "ASSET_REPORT_NOT_FOUND",
        "Asset report is unavailable.",
        404,
        "ASSET_REPORT_OWNER_MISMATCH",
      );
    }
    try {
      const { data } = await plaid.post("/asset_report/get", {
        asset_report_token: storedToken,
      }, { signal });
      return { status: "complete", data: data?.report };
    } catch (error) {
      if (error?.details?.error_code === "PRODUCT_NOT_READY") {
        return { status: "pending", message: "Asset report not ready yet" };
      }
      throw error;
    }
  }

  /**
   * Diagnostics are intentionally lossy.  They never affect Link, exchange,
   * or sync and always resolve to the legacy-compatible accepted result.
   */
  async function logDiagnostics({
    actor = null,
    sessionId = null,
    eventType,
    plaidStep = null,
    pageState = {},
    plaidMetadata = {},
    errorDetails = {},
    browserContext = {},
  } = {}) {
    let principalUserId = null;
    try {
      if (validUid(actor?.uid)) {
        try {
          principalUserId = (await resolveFinancialPrincipal(repository, {
            uid: actor.uid,
            email: actor.email || null,
          })).legacyUserUuid;
        } catch {
          // Diagnostics retain the source's anonymous fallback behavior.
          principalUserId = null;
        }
      }
    } catch {
      // Invalid/expired authentication is anonymous for diagnostics, matching
      // the source endpoint's `deriveUserId` behavior.
      principalUserId = null;
    }
    let record;
    try {
      record = diagnosticsRecord({
        userId: principalUserId,
        sessionId,
        eventType,
        plaidStep,
        pageState,
        plaidMetadata,
        errorDetails,
        browserContext,
      });
    } catch {
      return { accepted: false, reason: "unexpected" };
    }
    if (!record?.eventType) return { accepted: false, reason: "missing_event_type" };
    let insertDiagnostic;
    try {
      insertDiagnostic = requireMethod(repository, "insertPlaidDiagnostic", "FINANCIAL_REPOSITORY");
    } catch {
      return { accepted: false, reason: "service_unavailable" };
    }
    try {
      await insertDiagnostic(record);
      return { accepted: true };
    } catch {
      // The source endpoint returns HTTP 200 when the diagnostics table is
      // unavailable; this result must never interrupt the Link flow.
      return { accepted: false, reason: "db_error" };
    }
  }

  return Object.freeze({
    configured: true,
    createLinkToken,
    exchangePublicToken,
    startPlaidDataSync,
    syncPlaidData,
    syncProduct,
    syncProductForUser,
    createAssetReport,
    getAssetReport,
    logDiagnostics,
    appendDiagnostics: logDiagnostics,
  });
}
