import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import { RuntimeError } from "../errors.js";

const MAX_BODY_BYTES = 1_048_576;
const MAX_TITLE_BYTES = 512;
const MAX_BRANCH_BYTES = 256;
const MAX_LOGIN_BYTES = 64;
const MAX_LABELS = 50;
const MAX_LABEL_BYTES = 100;
const DELIVERY_LEASE_MS = 30_000;
const JSON_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
  "content-type": "application/json",
});
const SIGNATURE_PATTERN = /^sha256=([a-f0-9]{64})$/;
const DELIVERY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GROUP_RESOURCE_PATTERN = /^groups\/[a-z0-9][a-z0-9-]{2,62}$/;
const LEDGER_DURABILITY = "cloud_sql_leased_fenced_webhook_delivery_v1";
const TARGET_PROJECT = "hushh-tech-uat";
const TARGET_REGION = "us-central1";
const APPROVAL_SCOPE = "github-devops-notify-detached-candidate-v1";
const APPROVED_REPOSITORY = "hushh-labs/hushh_Tech_website";
const RECIPIENT_GROUP = "groups/hushh-tech-devops-notify";

export const GITHUB_DEVOPS_NOTIFY_SOURCE_PIN = Object.freeze({
  slug: "github-devops-notify",
  functionId: "9d5b0e1a-d76d-4dcd-a3a2-14afb19d09b4",
  manifestVersion: 6164,
  sourceVersion: 6207,
  liveBundleSha256:
    "c0ba88aa56b479ef5ae5ccea04ad0a3f1dbab407f807188d79ca27cb7e55cecd",
  deploymentBindingSha256:
    "dda6e2a6cbe7688626467f83f1d648253c94d191c0cb325f94a43d62189a8440",
});

export const GITHUB_DEVOPS_NOTIFY_BLOCKERS = Object.freeze([
  "SOURCE_BUNDLE_VERSION_UNBOUND",
  "SOURCE_METADATA_END_CHECK_MISSING",
  "SOURCE_REVISION_UNPROVEN",
  "SOURCE_VERSION_DRIFT",
  "TARGET_CONTRACT_MISSING",
  "TARGET_REGISTRY_NOT_ENABLED",
  "DETACHED_CANDIDATE_APPROVAL_MISSING",
  "SOURCE_LIVE_FAILURE_PARITY_UNRESOLVED",
  "GITHUB_REPOSITORY_AND_SIGNATURE_LIVE_PROOF_MISSING",
  "CLOUD_SQL_FENCED_DELIVERY_LEDGER_LIVE_PROOF_MISSING",
  "WORKSPACE_GROUP_GMAIL_DELEGATION_LIVE_PROOF_MISSING",
  "PROVIDER_ADAPTER_NOT_RUNTIME_WIRED",
  "PRIVATE_UAT_LIVE_PARITY_MISSING",
]);

function fail(code, message = "Webhook rejected.", statusCode = 400, cause) {
  throw new RuntimeError(code, message, statusCode, cause ? { cause } : {});
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function json(status, body) {
  return Object.freeze({ status, headers: JSON_HEADERS, body: Object.freeze(body) });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw new RuntimeError("HANDLER_ABORTED", "Service unavailable.", 503, {
    cause: signal.reason instanceof Error ? signal.reason : undefined,
  });
}

function header(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(",").trim();
  return typeof value === "string" ? value.trim() : "";
}

function boundedText(value, maximumBytes, code = "INVALID_PAYLOAD") {
  if (typeof value !== "string") fail(code);
  const output = value.trim();
  if (
    output.length === 0 ||
    Buffer.byteLength(output, "utf8") > maximumBytes ||
    [...output].some((character) => character.codePointAt(0) < 32)
  ) {
    fail(code);
  }
  return output;
}

function boundedInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_PAYLOAD");
  }
  return value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function rejectDuplicateJsonObjectKeys(rawText) {
  let cursor = 0;
  const malformed = () => fail("INVALID_JSON");
  const skipWhitespace = () => {
    while (/\s/.test(rawText[cursor] ?? "")) cursor += 1;
  };
  const parseString = () => {
    if (rawText[cursor] !== '"') malformed();
    const start = cursor;
    cursor += 1;
    while (cursor < rawText.length) {
      const character = rawText[cursor];
      if (character === '"') {
        cursor += 1;
        try {
          return JSON.parse(rawText.slice(start, cursor));
        } catch {
          malformed();
        }
      }
      if (character === "\\") {
        cursor += 1;
        const escape = rawText[cursor];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(rawText.slice(cursor + 1, cursor + 5))) {
            malformed();
          }
          cursor += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape ?? "")) malformed();
        cursor += 1;
        continue;
      }
      if (character.codePointAt(0) < 32) malformed();
      cursor += 1;
    }
    malformed();
  };
  const parsePrimitive = () => {
    const start = cursor;
    while (cursor < rawText.length && !/[\s,\]}]/.test(rawText[cursor])) {
      cursor += 1;
    }
    if (start === cursor) malformed();
    try {
      JSON.parse(rawText.slice(start, cursor));
    } catch {
      malformed();
    }
  };
  const parseValue = () => {
    skipWhitespace();
    if (rawText[cursor] === "{") parseObject();
    else if (rawText[cursor] === "[") parseArray();
    else if (rawText[cursor] === '"') parseString();
    else parsePrimitive();
  };
  const parseArray = () => {
    cursor += 1;
    skipWhitespace();
    if (rawText[cursor] === "]") {
      cursor += 1;
      return;
    }
    while (cursor < rawText.length) {
      parseValue();
      skipWhitespace();
      if (rawText[cursor] === "]") {
        cursor += 1;
        return;
      }
      if (rawText[cursor] !== ",") malformed();
      cursor += 1;
      skipWhitespace();
    }
    malformed();
  };
  const parseObject = () => {
    cursor += 1;
    const keys = new Set();
    skipWhitespace();
    if (rawText[cursor] === "}") {
      cursor += 1;
      return;
    }
    while (cursor < rawText.length) {
      const key = parseString();
      if (keys.has(key)) fail("DUPLICATE_JSON_KEY");
      keys.add(key);
      skipWhitespace();
      if (rawText[cursor] !== ":") malformed();
      cursor += 1;
      parseValue();
      skipWhitespace();
      if (rawText[cursor] === "}") {
        cursor += 1;
        return;
      }
      if (rawText[cursor] !== ",") malformed();
      cursor += 1;
      skipWhitespace();
    }
    malformed();
  };
  parseValue();
  skipWhitespace();
  if (cursor !== rawText.length) malformed();
}

export function parseUniqueJson(rawBody) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) fail("INVALID_JSON");
  const rawText = rawBody.toString("utf8");
  if (!Buffer.from(rawText, "utf8").equals(rawBody)) fail("INVALID_JSON");
  rejectDuplicateJsonObjectKeys(rawText);
  try {
    return JSON.parse(rawText);
  } catch (error) {
    fail("INVALID_JSON", "Webhook rejected.", 400, error);
  }
}

export function verifyGitHubWebhookSignature({ rawBody, signature, secret }) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;
  const secretBytes = Buffer.isBuffer(secret)
    ? secret
    : typeof secret === "string"
      ? Buffer.from(secret, "utf8")
      : Buffer.alloc(0);
  if (secretBytes.length < 32 || secretBytes.length > 512) return false;
  const match = SIGNATURE_PATTERN.exec(signature ?? "");
  if (!match) return false;
  const supplied = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secretBytes).update(rawBody).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function safeDate(value) {
  const text = boundedText(value, 64);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) fail("INVALID_PAYLOAD");
  return new Date(milliseconds).toISOString();
}

function safeLogin(value) {
  const login = boundedText(value, MAX_LOGIN_BYTES);
  if (!LOGIN_PATTERN.test(login)) fail("INVALID_PAYLOAD");
  return login;
}

function projectPayload(payload, repositoryAllowlist) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("INVALID_PAYLOAD");
  }
  const pullRequest = payload.pull_request;
  const repository = payload.repository;
  if (!pullRequest || !repository || payload.action !== "closed") {
    fail("EVENT_NOT_ACTIONABLE", "Event ignored.", 202);
  }
  if (pullRequest.merged !== true || pullRequest.base?.ref !== "main") {
    fail("EVENT_NOT_ACTIONABLE", "Event ignored.", 202);
  }
  const repositoryName = boundedText(repository.full_name, 201);
  if (
    !REPOSITORY_PATTERN.test(repositoryName) ||
    !repositoryAllowlist.has(repositoryName)
  ) {
    fail("REPOSITORY_NOT_ALLOWED", "Webhook rejected.", 403);
  }
  const number = boundedInteger(pullRequest.number, 1, 2_147_483_647);
  const title = boundedText(pullRequest.title, MAX_TITLE_BYTES);
  const author = safeLogin(pullRequest.user?.login);
  const mergedBy = safeLogin(pullRequest.merged_by?.login);
  const headBranch = boundedText(pullRequest.head?.ref, MAX_BRANCH_BYTES);
  const labels = Array.isArray(pullRequest.labels)
    ? pullRequest.labels.map((label) => boundedText(label?.name, MAX_LABEL_BYTES))
    : [];
  if (labels.length > MAX_LABELS) fail("INVALID_PAYLOAD");
  const repositoryUrl = `https://github.com/${repositoryName}`;
  const pullRequestUrl = `${repositoryUrl}/pull/${number}`;
  if (repository.html_url !== repositoryUrl || pullRequest.html_url !== pullRequestUrl) {
    fail("UNTRUSTED_GITHUB_URL");
  }
  return Object.freeze({
    repository: repositoryName,
    number,
    title,
    author,
    mergedBy,
    headBranch,
    baseBranch: "main",
    mergedAt: safeDate(pullRequest.merged_at),
    changedFiles: boundedInteger(pullRequest.changed_files, 0, 1_000_000),
    additions: boundedInteger(pullRequest.additions, 0, 100_000_000),
    deletions: boundedInteger(pullRequest.deletions, 0, 100_000_000),
    labels: Object.freeze(labels),
    pullRequestUrl,
  });
}

function renderNotification(projection) {
  const labelMarkup = projection.labels.length
    ? `<p>Labels: ${projection.labels.map(escapeHtml).join(", ")}</p>`
    : "";
  const subject = `[${projection.repository}] PR #${projection.number} merged`;
  const html = [
    "<!doctype html><html><body>",
    `<h1>${escapeHtml(projection.title)}</h1>`,
    `<p>Repository: ${escapeHtml(projection.repository)}</p>`,
    `<p>Pull request: <a href="${escapeHtml(projection.pullRequestUrl)}">#${projection.number}</a></p>`,
    `<p>Merged by: ${escapeHtml(projection.mergedBy)}</p>`,
    `<p>Author: ${escapeHtml(projection.author)}</p>`,
    `<p>Branch: ${escapeHtml(projection.headBranch)} → main</p>`,
    `<p>Files: ${projection.changedFiles}; additions: ${projection.additions}; deletions: ${projection.deletions}</p>`,
    labelMarkup,
    "</body></html>",
  ].join("");
  return Object.freeze({ subject, html });
}

function approvalBinding() {
  return sha256(
    JSON.stringify({
      scope: APPROVAL_SCOPE,
      targetProject: TARGET_PROJECT,
      targetRegion: TARGET_REGION,
      source: GITHUB_DEVOPS_NOTIFY_SOURCE_PIN,
      blockers: GITHUB_DEVOPS_NOTIFY_BLOCKERS,
    }),
  );
}

async function assertDetachedApproval({ verifyDetachedApproval, approvalReceipt, now }) {
  if (typeof verifyDetachedApproval !== "function" || approvalReceipt == null) {
    fail("DETACHED_CANDIDATE_NOT_APPROVED", "Service unavailable.", 503);
  }
  let result;
  try {
    result = await verifyDetachedApproval({
      rawReceipt: approvalReceipt,
      bindingSha256: approvalBinding(),
      scope: APPROVAL_SCOPE,
      targetProject: TARGET_PROJECT,
      targetRegion: TARGET_REGION,
    });
  } catch (error) {
    fail("DETACHED_CANDIDATE_NOT_APPROVED", "Service unavailable.", 503, error);
  }
  const nowMs = now().getTime();
  if (
    result?.valid !== true ||
    result.bindingSha256 !== approvalBinding() ||
    result.scope !== APPROVAL_SCOPE ||
    result.targetProject !== TARGET_PROJECT ||
    result.targetRegion !== TARGET_REGION ||
    !Number.isSafeInteger(result.expiresAtMs) ||
    result.expiresAtMs <= nowMs ||
    result.expiresAtMs > nowMs + 900_000 ||
    typeof result.reviewerIdentity !== "string" ||
    result.reviewerIdentity.length < 3 ||
    result.reviewerIdentity.length > 256 ||
    result.independentReviewer !== true
  ) {
    fail("DETACHED_CANDIDATE_NOT_APPROVED", "Service unavailable.", 503);
  }
}

function assertDependencies({ operationLedger, mailer, recipientGroup }) {
  if (
    operationLedger?.configured !== true ||
    operationLedger.durability !== LEDGER_DURABILITY ||
    !["claim", "markProviderInvoked", "markSent", "complete", "markRetryable"].every(
      (method) => typeof operationLedger[method] === "function",
    )
  ) {
    fail("DURABLE_LEDGER_UNAVAILABLE", "Service unavailable.", 503);
  }
  if (
    mailer?.configured !== true ||
    mailer.authMode !== "workload_identity_domain_delegation" ||
    typeof mailer.sendGroupMessage !== "function"
  ) {
    fail("MAIL_PROVIDER_UNAVAILABLE", "Service unavailable.", 503);
  }
  if (!GROUP_RESOURCE_PATTERN.test(recipientGroup ?? "")) {
    fail("RECIPIENT_GROUP_UNAVAILABLE", "Service unavailable.", 503);
  }
}

function replayResponse(value, deliveryId) {
  if (
    value?.status !== 200 ||
    value?.headers?.["cache-control"] !== "private, no-store" ||
    value?.headers?.["content-type"] !== "application/json" ||
    Object.keys(value.headers).length !== 2 ||
    value?.body?.success !== true ||
    value?.body?.delivery_id !== deliveryId ||
    value?.body?.notification_state !== "sent" ||
    Object.keys(value.body).length !== 3 ||
    Object.keys(value).length !== 3
  ) {
    fail("DURABLE_LEDGER_UNAVAILABLE", "Service unavailable.", 503);
  }
  return json(200, {
    success: true,
    delivery_id: deliveryId,
    notification_state: "sent",
  });
}

function claimDisposition(claim, deliveryId) {
  if (claim?.disposition === "COMPLETED" && claim.response) {
    return replayResponse(claim.response, deliveryId);
  }
  if (claim?.disposition === "PAYLOAD_CONFLICT") {
    fail("DELIVERY_PAYLOAD_CONFLICT", "Webhook rejected.", 409);
  }
  if (["PROCESSING", "UNKNOWN"].includes(claim?.disposition)) {
    fail("DELIVERY_RECONCILIATION_REQUIRED", "Webhook pending.", 409);
  }
  if (
    claim?.disposition !== "ACQUIRED" ||
    claim.acquired !== true ||
    !Number.isSafeInteger(claim.attempt) ||
    claim.attempt < 1 ||
    typeof claim.fencingToken !== "string" ||
    claim.fencingToken.length < 16
  ) {
    fail("DURABLE_LEDGER_UNAVAILABLE", "Service unavailable.", 503);
  }
  return null;
}

export function createGithubDevopsNotifyCandidate({
  approvalReceipt,
  verifyDetachedApproval,
  webhookSecret,
  operationLedger,
  mailer,
  recipientGroup,
  repositoryAllowlist = [APPROVED_REPOSITORY],
  now = () => new Date(),
} = {}) {
  const allowedRepositories = new Set(repositoryAllowlist);
  if (
    repositoryAllowlist.length !== 1 ||
    repositoryAllowlist[0] !== APPROVED_REPOSITORY ||
    allowedRepositories.size !== 1
  ) {
    fail("REPOSITORY_ALLOWLIST_INVALID", "Service unavailable.", 503);
  }
  if (recipientGroup !== RECIPIENT_GROUP) {
    fail("RECIPIENT_GROUP_UNAVAILABLE", "Service unavailable.", 503);
  }

  return async function githubDevopsNotify({ request, signal } = {}) {
    await assertDetachedApproval({ verifyDetachedApproval, approvalReceipt, now });
    assertDependencies({ operationLedger, mailer, recipientGroup });
    throwIfAborted(signal);
    if (request?.method !== "POST") fail("METHOD_NOT_ALLOWED", "Method not allowed.", 405);
    if (request?.route?.search) fail("QUERY_NOT_ALLOWED");
    if (header(request.headers, "authorization")) fail("AUTHORIZATION_NOT_ALLOWED");
    if (header(request.headers, "content-type").toLowerCase() !== "application/json") {
      fail("UNSUPPORTED_MEDIA_TYPE", "Unsupported media type.", 415);
    }
    if (!Buffer.isBuffer(request.body) || request.body.length > MAX_BODY_BYTES) {
      fail("PAYLOAD_TOO_LARGE", "Webhook rejected.", 413);
    }
    const deliveryId = header(request.headers, "x-github-delivery");
    const eventName = header(request.headers, "x-github-event");
    const signature = header(request.headers, "x-hub-signature-256");
    if (!DELIVERY_PATTERN.test(deliveryId) || eventName !== "pull_request") {
      fail("INVALID_GITHUB_HEADERS");
    }
    if (!verifyGitHubWebhookSignature({ rawBody: request.body, signature, secret: webhookSecret })) {
      fail("WEBHOOK_SIGNATURE_INVALID", "Webhook rejected.", 401);
    }
    const bodyHash = sha256(request.body);
    const projection = projectPayload(parseUniqueJson(request.body), allowedRepositories);
    const operationKey = `github:${deliveryId}`;
    let claim;
    try {
      claim = await operationLedger.claim({
        operationKey,
        payloadHash: bodyHash,
        leaseDurationMs: DELIVERY_LEASE_MS,
      });
    } catch (error) {
      throw new RuntimeError(
        "DURABLE_LEDGER_UNAVAILABLE",
        "Service unavailable.",
        503,
        { cause: error },
      );
    }
    const prior = claimDisposition(claim, deliveryId);
    if (prior) return prior;
    const ownership = Object.freeze({
      operationKey,
      payloadHash: bodyHash,
      attempt: claim.attempt,
      fencingToken: claim.fencingToken,
    });
    let providerInvoked = false;
    try {
      throwIfAborted(signal);
      const message = renderNotification(projection);
      const invoked = await operationLedger.markProviderInvoked(ownership);
      if (invoked?.state !== "UNKNOWN") {
        fail("DURABLE_LEDGER_UNAVAILABLE", "Service unavailable.", 503);
      }
      providerInvoked = true;
      throwIfAborted(signal);
      const result = await mailer.sendGroupMessage({
        operationKey,
        groupResource: recipientGroup,
        subject: message.subject,
        html: message.html,
        signal,
      });
      if (
        result?.accepted !== true ||
        typeof result.providerMessageId !== "string" ||
        result.providerMessageId.length < 1 ||
        result.providerMessageId.length > 512
      ) {
        fail("DELIVERY_RECONCILIATION_REQUIRED", "Webhook pending.", 503);
      }
      const sent = await operationLedger.markSent({
        ...ownership,
        providerMessageIdSha256: sha256(result.providerMessageId),
      });
      if (sent?.state !== "SENT") {
        fail("DELIVERY_RECONCILIATION_REQUIRED", "Webhook pending.", 503);
      }
      const response = json(200, {
        success: true,
        delivery_id: deliveryId,
        notification_state: "sent",
      });
      const completed = await operationLedger.complete({ ...ownership, response });
      if (completed?.state !== "COMPLETED") {
        fail("DELIVERY_RECONCILIATION_REQUIRED", "Webhook pending.", 503);
      }
      return response;
    } catch (error) {
      if (!providerInvoked) {
        try {
          const retryable = await operationLedger.markRetryable(ownership);
          if (retryable?.state !== "RETRYABLE") {
            throw new Error("retry state not persisted", { cause: error });
          }
        } catch (ledgerError) {
          throw new RuntimeError(
            "DURABLE_LEDGER_UNAVAILABLE",
            "Service unavailable.",
            503,
            { cause: ledgerError },
          );
        }
      }
      if (providerInvoked && !(error instanceof RuntimeError && error.code === "DELIVERY_RECONCILIATION_REQUIRED")) {
        throw new RuntimeError(
          "DELIVERY_RECONCILIATION_REQUIRED",
          "Webhook pending.",
          503,
          { cause: error },
        );
      }
      if (!providerInvoked && signal?.aborted) {
        throw new RuntimeError(
          "HANDLER_ABORTED",
          "Service unavailable.",
          503,
          { cause: signal.reason instanceof Error ? signal.reason : error },
        );
      }
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(
        "DURABLE_LEDGER_UNAVAILABLE",
        "Service unavailable.",
        503,
        { cause: error },
      );
    }
  };
}

export const __testing = Object.freeze({
  approvalBinding,
  renderNotification,
});
