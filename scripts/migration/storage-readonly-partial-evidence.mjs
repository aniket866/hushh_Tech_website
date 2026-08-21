#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  STORAGE_CUTOVER_CONTRACT,
} from "./storage-cutover-contract.mjs";
import {
  MAXIMUM_PRIVATE_INPUT_BYTES,
  calculateSelfBoundDigest,
  canonicalJson,
  contractFileDigestSha256,
  currentCleanGitHead,
  fail,
  isPlainObject,
  readPrivateArtifact,
  requireExactKeys,
  requireIsoTimestamp,
  requireSha256,
  runCommand,
  safeErrorResult,
  sha256,
  writePrivateArtifact,
} from "./storage-live-common.mjs";
import {
  COPY_POLICY_CANDIDATE,
  copyPolicyCandidateFileDigestSha256,
  validateCopyPolicyCandidate,
} from "./storage-live-policy.mjs";

export const RAW_PARTIAL_CAPTURE_SCHEMA = "storage-readonly-raw-capture-v1";
export const PARTIAL_EVIDENCE_SCHEMA = "storage-readonly-partial-evidence-v1";
export const MAXIMUM_PARTIAL_RESPONSE_BYTES = 8_388_608;
export const PARTIAL_REQUEST_TIMEOUT_MS = 60_000;
export const PARTIAL_CAPTURE_ID_PATTERN = /^storage-partial-[0-9a-f-]{36}$/;

export const PARTIAL_NORMALIZATION_ALGORITHMS = Object.freeze({
  requestReceipt:
    "sha256(canonicalJson({captureId,ordinal,transport,provider,endpointClass,scopeDigestSha256,pageIndex,method,requestTargetSha256,startedAt,endedAt,httpStatus,processExitStatus,responseByteCount,rawResponseDigestSha256}))",
  sourceBucketSet:
    "sort_utf8({bucketId,public}); retain required bucket ids; sha256 unknown ids; exact required public-state comparison",
  targetConfiguration:
    "exact location+uniformBucketLevelAccess+publicAccessPrevention+versioning projection",
  targetBucketIam:
    "sort role; sort sha256(member); bind condition sha256; compare exact frozen bucket allowlist",
  targetInheritedIam:
    "project+folder+organization policies; retain roles with storage permissions; hash scopes and members; require empty inherited set",
  targetObjectList:
    "complete page chain; sha256 object names; bind generation+size; split exact migration namespace from unmanaged objects",
});

const RAW_CAPTURE_KEYS = [
  "schemaVersion",
  "captureId",
  "windowStartedAt",
  "windowEndedAt",
  "collectorRevision",
  "environment",
  "project",
  "region",
  "contractFileDigestSha256",
  "copyPolicyCandidateFileDigestSha256",
  "requests",
  "rawCaptureDigestSha256",
];

const RAW_REQUEST_KEYS = [
  "requestId",
  "captureId",
  "ordinal",
  "transport",
  "provider",
  "endpointClass",
  "scope",
  "pageIndex",
  "method",
  "requestTarget",
  "requestTargetSha256",
  "startedAt",
  "endedAt",
  "httpStatus",
  "processExitStatus",
  "responseByteCount",
  "rawResponseDigestSha256",
  "rawResponseBase64",
];

const EVIDENCE_KEYS = [
  "schemaVersion",
  "captureId",
  "windowStartedAt",
  "windowEndedAt",
  "collectorRevision",
  "environment",
  "project",
  "region",
  "contractFileDigestSha256",
  "copyPolicyCandidateFileDigestSha256",
  "sourceProjectRefSha256",
  "normalizationAlgorithms",
  "rawCaptureFileDigestSha256",
  "rawCaptureDigestSha256",
  "requestCount",
  "requestEvidenceDigestSha256",
  "requests",
  "source",
  "targets",
  "blockers",
  "safeForCopy",
  "providerMutationAllowed",
  "evidenceDigestSha256",
];

const EVIDENCE_REQUEST_KEYS = RAW_REQUEST_KEYS.filter(
  (key) => !new Set(["scope", "requestTarget", "rawResponseBase64"]).has(key),
).concat(["scopeDigestSha256"]);

const SOURCE_SUMMARY_KEYS = [
  "requestHttpStatus",
  "requiredBucketCount",
  "liveBucketCount",
  "requiredBuckets",
  "unknownBucketCount",
  "unknownBucketIdDigests",
  "liveBucketSetDigestSha256",
  "requiredBucketSetComplete",
  "requiredPublicStatesMatch",
];

const TARGET_SUMMARY_KEYS = [
  "bucketName",
  "configurationHttpStatus",
  "configurationRead",
  "configurationSafe",
  "location",
  "uniformBucketLevelAccess",
  "publicAccessPrevention",
  "versioningEnabled",
  "configurationEvidenceDigestSha256",
  "iamHttpStatus",
  "iamRead",
  "bucketIamBindingCount",
  "inheritedStorageIamBindingCount",
  "publicIamMemberCount",
  "noConditionalBindings",
  "bucketMatchesFrozenAllowlist",
  "inheritedStorageBindingsEmpty",
  "effectiveMatchesFrozenAllowlist",
  "bucketIamEvidenceDigestSha256",
  "inheritedIamEvidenceDigestSha256",
  "objectListHttpStatuses",
  "objectListComplete",
  "totalObjectCount",
  "totalBytes",
  "namespaceObjectCount",
  "namespaceTotalBytes",
  "namespaceInventoryDigestSha256",
  "unmanagedObjectCount",
  "unmanagedTotalBytes",
  "unmanagedInventoryDigestSha256",
];

const HTTP_ENDPOINTS = new Set([
  "SOURCE_BUCKET_LIST",
  "GCS_BUCKET_CONFIGURATION",
  "GCS_BUCKET_IAM",
  "GCS_OBJECT_LIST",
]);

const LOCAL_ENDPOINTS = new Set([
  "GCP_PROJECT_IAM",
  "GCP_ANCESTORS",
  "GCP_FOLDER_IAM",
  "GCP_ORGANIZATION_IAM",
  "GCP_ROLE_DESCRIPTION",
]);

const requirePositiveInteger = (value, code, label, { allowZero = false } = {}) => {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    fail(code, `${label} must be a safe ${allowZero ? "non-negative" : "positive"} integer.`);
  }
  return value;
};

const requireNullablePositiveInteger = (value, code, label) => {
  if (value === null) return null;
  return requirePositiveInteger(value, code, label, { allowZero: true });
};

const requireBoundedString = (value, code, label, maximum = 4_096) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\0\r\n]/.test(value)
  ) {
    fail(code, `${label} must be bounded single-line text.`);
  }
  return value;
};

const exactJson = (left, right) => canonicalJson(left) === canonicalJson(right);

const requestIdentity = (request) =>
  sha256(canonicalJson({
    captureId: request.captureId,
    ordinal: request.ordinal,
    transport: request.transport,
    provider: request.provider,
    endpointClass: request.endpointClass,
    scope: request.scope,
    pageIndex: request.pageIndex,
    method: request.method,
    requestTargetSha256: request.requestTargetSha256,
  }));

export const buildRawPartialRequest = ({
  captureId,
  ordinal,
  transport,
  provider,
  endpointClass,
  scope,
  pageIndex = null,
  method,
  requestTarget,
  startedAt,
  endedAt,
  httpStatus,
  processExitStatus,
  responseBytes,
}) => {
  const bytes = Buffer.isBuffer(responseBytes)
    ? responseBytes
    : Buffer.from(responseBytes);
  const request = {
    requestId: null,
    captureId,
    ordinal,
    transport,
    provider,
    endpointClass,
    scope,
    pageIndex,
    method,
    requestTarget,
    requestTargetSha256: sha256(requestTarget),
    startedAt,
    endedAt,
    httpStatus,
    processExitStatus,
    responseByteCount: bytes.length,
    rawResponseDigestSha256: sha256(bytes),
    rawResponseBase64: bytes.toString("base64"),
  };
  request.requestId = requestIdentity(request);
  return request;
};

const canonicalBase64 = (value, code, label) => {
  if (typeof value !== "string") fail(code, `${label} must be base64 text.`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(code, `${label} is not canonical base64.`);
  return bytes;
};

const parseResponseJson = (request, code) => {
  const bytes = canonicalBase64(request.rawResponseBase64, code, "raw response");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code, "A captured provider response is not valid JSON.");
  }
};

const sanitizeRequest = (request) => {
  const sanitized = {
    requestId: request.requestId,
    captureId: request.captureId,
    ordinal: request.ordinal,
    transport: request.transport,
    provider: request.provider,
    endpointClass: request.endpointClass,
    pageIndex: request.pageIndex,
    method: request.method,
    requestTargetSha256: request.requestTargetSha256,
    startedAt: request.startedAt,
    endedAt: request.endedAt,
    httpStatus: request.httpStatus,
    processExitStatus: request.processExitStatus,
    responseByteCount: request.responseByteCount,
    rawResponseDigestSha256: request.rawResponseDigestSha256,
    scopeDigestSha256: sha256(request.scope),
  };
  requireExactKeys(
    sanitized,
    EVIDENCE_REQUEST_KEYS,
    "PARTIAL_EVIDENCE_REQUEST_SCHEMA_MISMATCH",
    "partial evidence request",
  );
  return sanitized;
};

const validateHttpRequestTarget = (request) => {
  let url;
  try {
    url = new URL(request.requestTarget);
  } catch {
    fail("PARTIAL_REQUEST_TARGET_INVALID", "A captured HTTP target is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.port !== ""
  ) {
    fail(
      "PARTIAL_REQUEST_TARGET_INVALID",
      "Captured HTTP targets must use credential-free default-port HTTPS without fragments.",
    );
  }
  if (request.endpointClass === "SOURCE_BUCKET_LIST") {
    const expectedHost = `${STORAGE_CUTOVER_CONTRACT.sourceSnapshot.projectRef}.supabase.co`;
    if (
      request.provider !== "supabase" ||
      request.scope !== "PRIMARY_SOURCE_BUCKET_SET" ||
      url.hostname !== expectedHost ||
      url.pathname !== "/storage/v1/bucket" ||
      url.search !== ""
    ) {
      fail("PARTIAL_REQUEST_TARGET_INVALID", "Source bucket evidence escaped its fixed endpoint.");
    }
    return;
  }
  if (request.provider !== "gcp" || url.hostname !== "storage.googleapis.com") {
    fail("PARTIAL_REQUEST_TARGET_INVALID", "Target evidence escaped the Google Storage endpoint.");
  }
  const bucket = STORAGE_CUTOVER_CONTRACT.buckets.find(
    (entry) => entry.targetBucket === request.scope,
  );
  if (!bucket) fail("PARTIAL_REQUEST_TARGET_INVALID", "Target evidence uses an unknown bucket.");
  const encodedBucket = encodeURIComponent(bucket.targetBucket);
  const exactSearch = (expected) => {
    const actual = [...url.searchParams.entries()].sort(([left], [right]) =>
      left.localeCompare(right));
    const normalizedExpected = [...expected].sort(([left], [right]) =>
      left.localeCompare(right));
    return exactJson(actual, normalizedExpected);
  };
  if (
    request.endpointClass === "GCS_BUCKET_CONFIGURATION" &&
    (
      url.pathname !== `/storage/v1/b/${encodedBucket}` ||
      !exactSearch([["projection", "full"]])
    )
  ) {
    fail("PARTIAL_REQUEST_TARGET_INVALID", "Target configuration evidence uses the wrong path.");
  }
  if (
    request.endpointClass === "GCS_BUCKET_IAM" &&
    (
      url.pathname !== `/storage/v1/b/${encodedBucket}/iam` ||
      url.search !== ""
    )
  ) {
    fail("PARTIAL_REQUEST_TARGET_INVALID", "Target IAM evidence uses the wrong path.");
  }
  if (
    request.endpointClass === "GCS_OBJECT_LIST" &&
    (
      url.pathname !== `/storage/v1/b/${encodedBucket}/o` ||
      !exactSearch([
        ["maxResults", "1000"],
        ...(request.pageIndex === 0
          ? []
          : [["pageToken", url.searchParams.get("pageToken")]]),
        ["projection", "full"],
      ]) ||
      (request.pageIndex > 0 && !url.searchParams.get("pageToken"))
    )
  ) {
    fail("PARTIAL_REQUEST_TARGET_INVALID", "Target object evidence uses the wrong path.");
  }
};

const validateLocalRequestTarget = (request) => {
  let command;
  try {
    command = JSON.parse(request.requestTarget);
  } catch {
    fail("PARTIAL_REQUEST_TARGET_INVALID", "A captured local read target is invalid.");
  }
  requireExactKeys(
    command,
    ["executable", "args"],
    "PARTIAL_REQUEST_TARGET_INVALID",
    "captured local read target",
  );
  if (command.executable !== "gcloud" || !Array.isArray(command.args)) {
    fail("PARTIAL_REQUEST_TARGET_INVALID", "Only gcloud read targets are allowed.");
  }
  if (
    command.args.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        argument.length > 1_024 ||
        /[\0\r\n]/.test(argument),
    )
  ) {
    fail("PARTIAL_REQUEST_TARGET_INVALID", "A captured gcloud argument is invalid.");
  }
  const joined = command.args.join("\0");
  const mutationToken = /(?:^|\0)(?:add-iam-policy-binding|set-iam-policy|remove-iam-policy-binding|create|delete|update|patch)(?:\0|$)/;
  if (mutationToken.test(joined)) {
    fail("PARTIAL_PROVIDER_MUTATION_BLOCKED", "A captured local command is not read-only.");
  }
  let expectedArgs;
  if (request.endpointClass === "GCP_PROJECT_IAM") {
    if (request.scope !== "projects/hushh-tech-uat") {
      fail("PARTIAL_REQUEST_TARGET_INVALID", "Project IAM evidence uses the wrong scope.");
    }
    expectedArgs = ["projects", "get-iam-policy", "hushh-tech-uat", "--format=json"];
  } else if (request.endpointClass === "GCP_ANCESTORS") {
    if (request.scope !== "projects/hushh-tech-uat") {
      fail("PARTIAL_REQUEST_TARGET_INVALID", "Ancestor evidence uses the wrong scope.");
    }
    expectedArgs = ["projects", "get-ancestors", "hushh-tech-uat", "--format=json"];
  } else if (request.endpointClass === "GCP_FOLDER_IAM") {
    const match = /^folders\/(\d+)$/.exec(request.scope);
    if (!match) fail("PARTIAL_REQUEST_TARGET_INVALID", "Folder IAM evidence uses the wrong scope.");
    expectedArgs = [
      "resource-manager",
      "folders",
      "get-iam-policy",
      match[1],
      "--format=json",
    ];
  } else if (request.endpointClass === "GCP_ORGANIZATION_IAM") {
    const match = /^organizations\/(\d+)$/.exec(request.scope);
    if (!match) fail("PARTIAL_REQUEST_TARGET_INVALID", "Organization IAM evidence uses the wrong scope.");
    expectedArgs = ["organizations", "get-iam-policy", match[1], "--format=json"];
  } else if (request.endpointClass === "GCP_ROLE_DESCRIPTION") {
    let match;
    if ((match = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/roles\/([A-Za-z0-9_.]+)$/.exec(request.scope))) {
      expectedArgs = [
        "iam",
        "roles",
        "describe",
        match[2],
        `--project=${match[1]}`,
        "--format=json",
      ];
    } else if ((match = /^organizations\/(\d+)\/roles\/([A-Za-z0-9_.]+)$/.exec(request.scope))) {
      expectedArgs = [
        "iam",
        "roles",
        "describe",
        match[2],
        `--organization=${match[1]}`,
        "--format=json",
      ];
    } else if (/^roles\/[A-Za-z0-9_.]+$/.test(request.scope)) {
      expectedArgs = ["iam", "roles", "describe", request.scope, "--format=json"];
    } else {
      fail("PARTIAL_REQUEST_TARGET_INVALID", "Role evidence uses the wrong scope.");
    }
  }
  if (!exactJson(command.args, expectedArgs)) {
    fail("PARTIAL_REQUEST_TARGET_INVALID", "A captured gcloud command escaped its fixed read contract.");
  }
};

const simpleStorageRole = (role) =>
  ["roles/owner", "roles/editor", "roles/viewer"].includes(role) ||
  role.startsWith("roles/storage.legacy") ||
  role.startsWith("roles/storage.");

const parseSuccessfulLocalJson = (request, code) => {
  if (request.processExitStatus !== 0) return null;
  return parseResponseJson(request, code);
};

const collectPolicyDescriptionRoles = (policy, roles) => {
  if (
    !isPlainObject(policy) ||
    (policy.bindings !== undefined && !Array.isArray(policy.bindings))
  ) {
    fail("RAW_PARTIAL_IAM_POLICY_INVALID", "An IAM policy response is invalid.");
  }
  for (const binding of policy.bindings || []) {
    if (!isPlainObject(binding) || typeof binding.role !== "string") {
      fail("RAW_PARTIAL_IAM_POLICY_INVALID", "An IAM policy binding is invalid.");
    }
    if (!simpleStorageRole(binding.role)) roles.add(binding.role);
  }
};

const validateLocalIamRequestSet = (requests) => {
  const projectRequest = requests.find(
    (request) => request.endpointClass === "GCP_PROJECT_IAM",
  );
  const ancestorRequest = requests.find(
    (request) => request.endpointClass === "GCP_ANCESTORS",
  );
  const expectedRoleDescriptions = new Set();
  const projectPolicy = parseSuccessfulLocalJson(
    projectRequest,
    "RAW_PARTIAL_PROJECT_IAM_RESPONSE_INVALID",
  );
  if (projectPolicy !== null) {
    collectPolicyDescriptionRoles(projectPolicy, expectedRoleDescriptions);
  }
  const ancestors = parseSuccessfulLocalJson(
    ancestorRequest,
    "RAW_PARTIAL_ANCESTOR_RESPONSE_INVALID",
  );
  if (ancestors !== null && !Array.isArray(ancestors)) {
    fail("RAW_PARTIAL_ANCESTOR_RESPONSE_INVALID", "Project ancestors response must be an array.");
  }
  const expectedAncestorRequests = new Map();
  for (const ancestor of ancestors || []) {
    if (
      !isPlainObject(ancestor) ||
      !new Set(["folder", "organization", "project"]).has(ancestor.type)
    ) {
      fail("RAW_PARTIAL_ANCESTOR_RESPONSE_INVALID", "A project ancestor is invalid.");
    }
    if (ancestor.type === "project") continue;
    if (
      (typeof ancestor.id !== "string" && typeof ancestor.id !== "number") ||
      !/^\d+$/.test(String(ancestor.id))
    ) {
      fail("RAW_PARTIAL_ANCESTOR_RESPONSE_INVALID", "An ancestor identifier is invalid.");
    }
    const endpointClass = ancestor.type === "folder"
      ? "GCP_FOLDER_IAM"
      : "GCP_ORGANIZATION_IAM";
    const scope = `${ancestor.type}s/${ancestor.id}`;
    if (expectedAncestorRequests.has(scope)) {
      fail("RAW_PARTIAL_IAM_ANCESTOR_RECEIPT_SET_INVALID", "An ancestor was duplicated.");
    }
    expectedAncestorRequests.set(scope, endpointClass);
  }
  const actualAncestorRequests = requests.filter((request) =>
    new Set(["GCP_FOLDER_IAM", "GCP_ORGANIZATION_IAM"]).has(request.endpointClass));
  if (actualAncestorRequests.length !== expectedAncestorRequests.size) {
    fail(
      "RAW_PARTIAL_IAM_ANCESTOR_RECEIPT_SET_INVALID",
      "Ancestor IAM receipts do not exactly match the ancestor response.",
    );
  }
  const seenAncestorScopes = new Set();
  for (const request of actualAncestorRequests) {
    if (
      expectedAncestorRequests.get(request.scope) !== request.endpointClass ||
      seenAncestorScopes.has(request.scope)
    ) {
      fail(
        "RAW_PARTIAL_IAM_ANCESTOR_RECEIPT_SET_INVALID",
        "An ancestor IAM receipt is missing, duplicated, or unrelated.",
      );
    }
    seenAncestorScopes.add(request.scope);
    const policy = parseSuccessfulLocalJson(
      request,
      "RAW_PARTIAL_ANCESTOR_IAM_RESPONSE_INVALID",
    );
    if (policy !== null) {
      collectPolicyDescriptionRoles(policy, expectedRoleDescriptions);
    }
  }
  const roleRequests = requests.filter(
    (request) => request.endpointClass === "GCP_ROLE_DESCRIPTION",
  );
  if (roleRequests.length !== expectedRoleDescriptions.size) {
    fail(
      "RAW_PARTIAL_IAM_ROLE_RECEIPT_SET_INVALID",
      "IAM role-description receipts do not exactly match observed policy roles.",
    );
  }
  const seenRoleScopes = new Set();
  for (const request of roleRequests) {
    if (
      !expectedRoleDescriptions.has(request.scope) ||
      seenRoleScopes.has(request.scope)
    ) {
      fail(
        "RAW_PARTIAL_IAM_ROLE_RECEIPT_SET_INVALID",
        "An IAM role-description receipt is missing, duplicated, or unreferenced.",
      );
    }
    seenRoleScopes.add(request.scope);
  }
};

export const finalizeRawPartialCapture = (rawCapture) => {
  const finalized = structuredClone(rawCapture);
  finalized.rawCaptureDigestSha256 = calculateSelfBoundDigest(
    finalized,
    "rawCaptureDigestSha256",
  );
  return finalized;
};

export const validateRawPartialCapture = (rawCapture) => {
  requireExactKeys(
    rawCapture,
    RAW_CAPTURE_KEYS,
    "RAW_PARTIAL_CAPTURE_SCHEMA_MISMATCH",
    "raw partial capture",
  );
  if (rawCapture.schemaVersion !== RAW_PARTIAL_CAPTURE_SCHEMA) {
    fail("RAW_PARTIAL_CAPTURE_SCHEMA_MISMATCH", "Raw partial capture schema changed.");
  }
  if (!PARTIAL_CAPTURE_ID_PATTERN.test(rawCapture.captureId || "")) {
    fail("RAW_PARTIAL_CAPTURE_ID_INVALID", "Raw partial capture ID is invalid.");
  }
  requireIsoTimestamp(rawCapture.windowStartedAt, "RAW_PARTIAL_CAPTURE_TIME_INVALID", "capture start");
  requireIsoTimestamp(rawCapture.windowEndedAt, "RAW_PARTIAL_CAPTURE_TIME_INVALID", "capture end");
  if (Date.parse(rawCapture.windowEndedAt) < Date.parse(rawCapture.windowStartedAt)) {
    fail("RAW_PARTIAL_CAPTURE_TIME_INVALID", "Raw partial capture window is reversed.");
  }
  if (!/^[a-f0-9]{40}$/.test(rawCapture.collectorRevision || "")) {
    fail("RAW_PARTIAL_CAPTURE_REVISION_INVALID", "Collector revision is invalid.");
  }
  if (
    rawCapture.environment !== "uat" ||
    rawCapture.project !== "hushh-tech-uat" ||
    rawCapture.region !== "us-central1"
  ) {
    fail("RAW_PARTIAL_CAPTURE_SCOPE_BLOCKED", "Raw partial capture escaped UAT scope.");
  }
  if (
    rawCapture.contractFileDigestSha256 !== contractFileDigestSha256() ||
    rawCapture.copyPolicyCandidateFileDigestSha256 !==
      copyPolicyCandidateFileDigestSha256()
  ) {
    fail("RAW_PARTIAL_CAPTURE_CONTRACT_DRIFT", "Raw partial capture contract binding changed.");
  }
  requireSha256(
    rawCapture.rawCaptureDigestSha256,
    "RAW_PARTIAL_CAPTURE_DIGEST_INVALID",
    "raw capture digest",
  );
  if (
    calculateSelfBoundDigest(rawCapture, "rawCaptureDigestSha256") !==
    rawCapture.rawCaptureDigestSha256
  ) {
    fail("RAW_PARTIAL_CAPTURE_DIGEST_MISMATCH", "Raw partial capture digest does not match.");
  }
  if (!Array.isArray(rawCapture.requests) || rawCapture.requests.length < 15) {
    fail("RAW_PARTIAL_CAPTURE_REQUEST_SET_INVALID", "Raw partial capture request set is incomplete.");
  }
  const startMs = Date.parse(rawCapture.windowStartedAt);
  const endMs = Date.parse(rawCapture.windowEndedAt);
  for (const [index, request] of rawCapture.requests.entries()) {
    requireExactKeys(
      request,
      RAW_REQUEST_KEYS,
      "RAW_PARTIAL_REQUEST_SCHEMA_MISMATCH",
      "raw partial request",
    );
    if (
      request.captureId !== rawCapture.captureId ||
      request.ordinal !== index ||
      request.requestId !== requestIdentity(request)
    ) {
      fail("RAW_PARTIAL_REQUEST_BINDING_INVALID", "A raw request is not bound to its capture and ordinal.");
    }
    requireBoundedString(request.scope, "RAW_PARTIAL_REQUEST_SCOPE_INVALID", "request scope");
    requireBoundedString(
      request.requestTarget,
      "RAW_PARTIAL_REQUEST_TARGET_INVALID",
      "request target",
      16_384,
    );
    requireSha256(
      request.requestTargetSha256,
      "RAW_PARTIAL_REQUEST_TARGET_INVALID",
      "request target digest",
    );
    if (sha256(request.requestTarget) !== request.requestTargetSha256) {
      fail("RAW_PARTIAL_REQUEST_TARGET_INVALID", "A request target digest changed.");
    }
    requireIsoTimestamp(request.startedAt, "RAW_PARTIAL_REQUEST_TIME_INVALID", "request start");
    requireIsoTimestamp(request.endedAt, "RAW_PARTIAL_REQUEST_TIME_INVALID", "request end");
    const requestStart = Date.parse(request.startedAt);
    const requestEnd = Date.parse(request.endedAt);
    if (
      requestStart < startMs ||
      requestEnd > endMs ||
      requestEnd < requestStart
    ) {
      fail("RAW_PARTIAL_REQUEST_TIME_INVALID", "A raw request escaped its capture window.");
    }
    requireNullablePositiveInteger(
      request.pageIndex,
      "RAW_PARTIAL_REQUEST_PAGE_INVALID",
      "request page index",
    );
    const responseBytes = canonicalBase64(
      request.rawResponseBase64,
      "RAW_PARTIAL_RESPONSE_INVALID",
      "raw response",
    );
    requirePositiveInteger(
      request.responseByteCount,
      "RAW_PARTIAL_RESPONSE_INVALID",
      "raw response byte count",
      { allowZero: true },
    );
    if (
      responseBytes.length !== request.responseByteCount ||
      sha256(responseBytes) !== request.rawResponseDigestSha256
    ) {
      fail("RAW_PARTIAL_RESPONSE_DIGEST_MISMATCH", "A raw response digest or byte count changed.");
    }
    requireSha256(
      request.rawResponseDigestSha256,
      "RAW_PARTIAL_RESPONSE_INVALID",
      "raw response digest",
    );
    if (request.transport === "HTTP_JSON") {
      if (
        !HTTP_ENDPOINTS.has(request.endpointClass) ||
        request.method !== "GET" ||
        request.httpStatus === null ||
        request.processExitStatus !== null ||
        !Number.isSafeInteger(request.httpStatus) ||
        request.httpStatus < 100 ||
        request.httpStatus > 599
      ) {
        fail("RAW_PARTIAL_HTTP_RECEIPT_INVALID", "A raw HTTP request receipt is invalid.");
      }
      validateHttpRequestTarget(request);
    } else if (request.transport === "LOCAL_GCLOUD_READ") {
      if (
        !LOCAL_ENDPOINTS.has(request.endpointClass) ||
        request.provider !== "gcp" ||
        request.method !== "LOCAL_READ" ||
        request.httpStatus !== null ||
        !Number.isSafeInteger(request.processExitStatus) ||
        request.processExitStatus < 0
      ) {
        fail("RAW_PARTIAL_LOCAL_RECEIPT_INVALID", "A raw local read receipt is invalid.");
      }
      validateLocalRequestTarget(request);
    } else {
      fail("RAW_PARTIAL_TRANSPORT_INVALID", "A raw request uses an unknown transport.");
    }
  }
  const exactlyOne = (endpointClass) =>
    rawCapture.requests.filter((request) => request.endpointClass === endpointClass).length === 1;
  if (!exactlyOne("SOURCE_BUCKET_LIST") || !exactlyOne("GCP_PROJECT_IAM") || !exactlyOne("GCP_ANCESTORS")) {
    fail("RAW_PARTIAL_CAPTURE_REQUEST_SET_INVALID", "Required singleton requests are missing or duplicated.");
  }
  validateLocalIamRequestSet(rawCapture.requests);
  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    for (const endpointClass of ["GCS_BUCKET_CONFIGURATION", "GCS_BUCKET_IAM"]) {
      const matching = rawCapture.requests.filter(
        (request) => request.endpointClass === endpointClass && request.scope === bucket.targetBucket,
      );
      if (matching.length !== 1) {
        fail("RAW_PARTIAL_CAPTURE_REQUEST_SET_INVALID", "A target singleton request is missing or duplicated.");
      }
    }
    const pages = rawCapture.requests.filter(
      (request) => request.endpointClass === "GCS_OBJECT_LIST" && request.scope === bucket.targetBucket,
    );
    if (
      pages.length === 0 ||
      pages.some((request, index) => request.pageIndex !== index)
    ) {
      fail("RAW_PARTIAL_CAPTURE_REQUEST_SET_INVALID", "A target object page chain is incomplete.");
    }
  }
  return rawCapture;
};

const requireHttpStatus = (request, allowed, code) => {
  if (!allowed.includes(request.httpStatus)) {
    fail(code, `Captured ${request.endpointClass} returned an unsupported status.`);
  }
};

const normalizeSourceBucketSummary = (requests) => {
  const request = requests.find((entry) => entry.endpointClass === "SOURCE_BUCKET_LIST");
  requireHttpStatus(request, [200], "SOURCE_BUCKET_PARTIAL_READ_FAILED");
  const body = parseResponseJson(request, "SOURCE_BUCKET_PARTIAL_RESPONSE_INVALID");
  if (!Array.isArray(body)) {
    fail("SOURCE_BUCKET_PARTIAL_RESPONSE_INVALID", "Source bucket response must be an array.");
  }
  const normalized = [];
  const seen = new Set();
  for (const bucket of body) {
    if (!isPlainObject(bucket)) {
      fail("SOURCE_BUCKET_PARTIAL_RESPONSE_INVALID", "Source bucket entry is invalid.");
    }
    const bucketId = bucket.id ?? bucket.name;
    if (
      typeof bucketId !== "string" ||
      bucketId.length === 0 ||
      bucketId.length > 256 ||
      /[\0\r\n]/.test(bucketId) ||
      typeof bucket.public !== "boolean" ||
      seen.has(bucketId)
    ) {
      fail("SOURCE_BUCKET_PARTIAL_RESPONSE_INVALID", "Source bucket set is invalid.");
    }
    seen.add(bucketId);
    normalized.push({ bucketId, public: bucket.public });
  }
  normalized.sort((left, right) => left.bucketId.localeCompare(right.bucketId));
  const expected = new Map(
    STORAGE_CUTOVER_CONTRACT.buckets.map((bucket) => [bucket.sourceBucket, bucket.sourcePublic]),
  );
  const requiredBuckets = [...expected.entries()].map(([bucketId, expectedPublic]) => {
    const observed = normalized.find((bucket) => bucket.bucketId === bucketId);
    return {
      bucketId,
      expectedPublic,
      observed: observed !== undefined,
      publicStateMatches: observed?.public === expectedPublic,
    };
  });
  const unknown = normalized.filter((bucket) => !expected.has(bucket.bucketId));
  const summary = {
    requestHttpStatus: request.httpStatus,
    requiredBucketCount: expected.size,
    liveBucketCount: normalized.length,
    requiredBuckets,
    unknownBucketCount: unknown.length,
    unknownBucketIdDigests: unknown.map((bucket) => sha256(bucket.bucketId)).sort(),
    liveBucketSetDigestSha256: sha256(canonicalJson(normalized)),
    requiredBucketSetComplete: requiredBuckets.every((bucket) => bucket.observed),
    requiredPublicStatesMatch: requiredBuckets.every((bucket) => bucket.publicStateMatches),
  };
  requireExactKeys(
    summary,
    SOURCE_SUMMARY_KEYS,
    "PARTIAL_SOURCE_SUMMARY_SCHEMA_MISMATCH",
    "partial source summary",
  );
  return summary;
};

const normalizeBindings = (bindings, { scope = null } = {}) => {
  if (!Array.isArray(bindings)) {
    fail("PARTIAL_IAM_RESPONSE_INVALID", "IAM bindings must be an array.");
  }
  return bindings.map((binding) => {
    if (
      !isPlainObject(binding) ||
      typeof binding.role !== "string" ||
      !Array.isArray(binding.members)
    ) {
      fail("PARTIAL_IAM_RESPONSE_INVALID", "An IAM binding is invalid.");
    }
    const members = [...binding.members];
    if (
      members.some(
        (member) => typeof member !== "string" || member.length === 0 || /[\0\r\n]/.test(member),
      ) ||
      new Set(members).size !== members.length
    ) {
      fail("PARTIAL_IAM_RESPONSE_INVALID", "An IAM member set is invalid.");
    }
    return {
      role: binding.role,
      memberDigests: members.map((member) => sha256(member)).sort(),
      publicMemberCount: members.filter(
        (member) => member === "allUsers" || member === "allAuthenticatedUsers",
      ).length,
      conditionDigestSha256: binding.condition
        ? sha256(canonicalJson(binding.condition))
        : null,
      scopeDigestSha256: scope === null ? null : sha256(scope),
    };
  }).sort((left, right) =>
    `${left.scopeDigestSha256 || ""}\0${left.role}\0${left.conditionDigestSha256 || ""}`
      .localeCompare(
        `${right.scopeDigestSha256 || ""}\0${right.role}\0${right.conditionDigestSha256 || ""}`,
      ));
};

const normalizedFrozenBucketAllowlist = (bucket) =>
  bucket.allowedIamBindings.map((binding) => ({
    role: binding.role,
    memberDigests: binding.members.map((member) => sha256(member)).sort(),
    publicMemberCount: binding.members.filter(
      (member) => member === "allUsers" || member === "allAuthenticatedUsers",
    ).length,
    conditionDigestSha256: null,
    scopeDigestSha256: null,
  })).sort((left, right) => left.role.localeCompare(right.role));

const normalizeInheritedIam = (requests) => {
  const projectRequest = requests.find((request) => request.endpointClass === "GCP_PROJECT_IAM");
  const ancestorRequest = requests.find((request) => request.endpointClass === "GCP_ANCESTORS");
  const policies = [];
  const unresolvedRoles = new Set();
  const parseCommandJson = (request, code) => {
    if (request.processExitStatus !== 0) return null;
    return parseResponseJson(request, code);
  };
  const projectPolicy = parseCommandJson(projectRequest, "PARTIAL_PROJECT_IAM_RESPONSE_INVALID");
  if (projectPolicy) policies.push({ scope: "projects/hushh-tech-uat", policy: projectPolicy });
  const ancestors = parseCommandJson(ancestorRequest, "PARTIAL_ANCESTOR_RESPONSE_INVALID");
  if (ancestors !== null && !Array.isArray(ancestors)) {
    fail("PARTIAL_ANCESTOR_RESPONSE_INVALID", "Project ancestors response must be an array.");
  }
  for (const ancestor of ancestors || []) {
    if (!isPlainObject(ancestor) || !new Set(["folder", "organization", "project"]).has(ancestor.type)) {
      fail("PARTIAL_ANCESTOR_RESPONSE_INVALID", "A project ancestor is invalid.");
    }
    if (ancestor.type === "project") continue;
    const endpointClass = ancestor.type === "folder"
      ? "GCP_FOLDER_IAM"
      : "GCP_ORGANIZATION_IAM";
    const scope = `${ancestor.type}s/${ancestor.id}`;
    const matching = requests.filter(
      (request) => request.endpointClass === endpointClass && request.scope === scope,
    );
    if (matching.length !== 1) {
      fail("RAW_PARTIAL_CAPTURE_REQUEST_SET_INVALID", "An ancestor IAM request is missing or duplicated.");
    }
    const policy = parseCommandJson(matching[0], "PARTIAL_ANCESTOR_IAM_RESPONSE_INVALID");
    if (policy) policies.push({ scope, policy });
  }
  const roleDescriptions = new Map();
  for (const request of requests.filter((entry) => entry.endpointClass === "GCP_ROLE_DESCRIPTION")) {
    if (request.processExitStatus !== 0) continue;
    const description = parseResponseJson(request, "PARTIAL_ROLE_RESPONSE_INVALID");
    if (!Array.isArray(description.includedPermissions)) {
      fail("PARTIAL_ROLE_RESPONSE_INVALID", "An IAM role description is invalid.");
    }
    roleDescriptions.set(request.scope, description.includedPermissions);
  }
  const inherited = [];
  for (const { scope, policy } of policies) {
    if (!isPlainObject(policy) || (policy.bindings !== undefined && !Array.isArray(policy.bindings))) {
      fail("PARTIAL_IAM_RESPONSE_INVALID", "An inherited IAM policy is invalid.");
    }
    for (const binding of policy.bindings || []) {
      const relevant = simpleStorageRole(binding.role) ||
        roleDescriptions.get(binding.role)?.some((permission) => permission.startsWith("storage."));
      if (!simpleStorageRole(binding.role) && !roleDescriptions.has(binding.role)) {
        unresolvedRoles.add(binding.role);
      }
      if (relevant) inherited.push(...normalizeBindings([binding], { scope }));
    }
  }
  inherited.sort((left, right) =>
    `${left.scopeDigestSha256}\0${left.role}`.localeCompare(
      `${right.scopeDigestSha256}\0${right.role}`,
    ));
  return {
    bindings: inherited,
    unresolvedRoleCount: unresolvedRoles.size,
    commandFailures: requests.filter(
      (request) => LOCAL_ENDPOINTS.has(request.endpointClass) && request.processExitStatus !== 0,
    ).length,
  };
};

const normalizeTargetSummary = (requests) => {
  const inherited = normalizeInheritedIam(requests);
  const targets = [];
  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    const configurationRequest = requests.find(
      (request) => request.endpointClass === "GCS_BUCKET_CONFIGURATION" && request.scope === bucket.targetBucket,
    );
    const iamRequest = requests.find(
      (request) => request.endpointClass === "GCS_BUCKET_IAM" && request.scope === bucket.targetBucket,
    );
    const objectRequests = requests.filter(
      (request) => request.endpointClass === "GCS_OBJECT_LIST" && request.scope === bucket.targetBucket,
    ).sort((left, right) => left.pageIndex - right.pageIndex);
    requireHttpStatus(configurationRequest, [200], "PARTIAL_TARGET_CONFIGURATION_READ_FAILED");
    for (const request of objectRequests) {
      requireHttpStatus(request, [200], "PARTIAL_TARGET_OBJECT_LIST_READ_FAILED");
    }
    requireHttpStatus(iamRequest, [200, 403], "PARTIAL_TARGET_IAM_STATUS_INVALID");
    const configuration = parseResponseJson(
      configurationRequest,
      "PARTIAL_TARGET_CONFIGURATION_RESPONSE_INVALID",
    );
    if (!isPlainObject(configuration)) {
      fail("PARTIAL_TARGET_CONFIGURATION_RESPONSE_INVALID", "Target configuration response is invalid.");
    }
    const configSummary = {
      location: configuration.location ?? null,
      uniformBucketLevelAccess:
        configuration.iamConfiguration?.uniformBucketLevelAccess?.enabled === true,
      publicAccessPrevention:
        configuration.iamConfiguration?.publicAccessPrevention ?? null,
      versioningEnabled: configuration.versioning?.enabled === true,
    };
    const configurationSafe =
      configSummary.location === STORAGE_CUTOVER_CONTRACT.targetPolicy.bucketLocation &&
      configSummary.uniformBucketLevelAccess &&
      configSummary.publicAccessPrevention === "enforced" &&
      configSummary.versioningEnabled;

    let bucketIamBindingCount = null;
    let publicIamMemberCount = null;
    let noConditionalBindings = null;
    let bucketMatchesFrozenAllowlist = null;
    let inheritedStorageBindingsEmpty = null;
    let effectiveMatchesFrozenAllowlist = null;
    let bucketIamEvidenceDigestSha256 = iamRequest.rawResponseDigestSha256;
    let inheritedIamEvidenceDigestSha256 = sha256(canonicalJson(inherited.bindings));
    if (iamRequest.httpStatus === 200) {
      const policy = parseResponseJson(iamRequest, "PARTIAL_TARGET_IAM_RESPONSE_INVALID");
      const bucketBindings = normalizeBindings(policy.bindings || []);
      bucketIamBindingCount = bucketBindings.length;
      publicIamMemberCount = [...bucketBindings, ...inherited.bindings].reduce(
        (sum, binding) => sum + binding.publicMemberCount,
        0,
      );
      noConditionalBindings = [...bucketBindings, ...inherited.bindings].every(
        (binding) => binding.conditionDigestSha256 === null,
      );
      bucketMatchesFrozenAllowlist = exactJson(
        bucketBindings,
        normalizedFrozenBucketAllowlist(bucket),
      );
      inheritedStorageBindingsEmpty = inherited.bindings.length === 0;
      effectiveMatchesFrozenAllowlist =
        noConditionalBindings &&
        bucketMatchesFrozenAllowlist &&
        inheritedStorageBindingsEmpty &&
        inherited.unresolvedRoleCount === 0 &&
        inherited.commandFailures === 0;
      bucketIamEvidenceDigestSha256 = sha256(canonicalJson(bucketBindings));
    }

    const objects = [];
    let expectedNextPageToken = null;
    for (const [index, request] of objectRequests.entries()) {
      const url = new URL(request.requestTarget);
      const suppliedToken = url.searchParams.get("pageToken");
      if ((index === 0 && suppliedToken !== null) || (index > 0 && suppliedToken !== expectedNextPageToken)) {
        fail("PARTIAL_TARGET_OBJECT_PAGE_CHAIN_INVALID", "Target object page tokens are not contiguous.");
      }
      const body = parseResponseJson(request, "PARTIAL_TARGET_OBJECT_RESPONSE_INVALID");
      if (!isPlainObject(body) || (body.items !== undefined && !Array.isArray(body.items))) {
        fail("PARTIAL_TARGET_OBJECT_RESPONSE_INVALID", "Target object response is invalid.");
      }
      for (const object of body.items || []) {
        if (
          !isPlainObject(object) ||
          typeof object.name !== "string" ||
          typeof object.generation !== "string"
        ) {
          fail("PARTIAL_TARGET_OBJECT_RESPONSE_INVALID", "A target object entry is invalid.");
        }
        const sizeBytes = Number(object.size);
        if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
          fail("PARTIAL_TARGET_OBJECT_RESPONSE_INVALID", "A target object size is invalid.");
        }
        objects.push({
          name: object.name,
          nameSha256: sha256(object.name),
          generation: object.generation,
          sizeBytes,
        });
      }
      expectedNextPageToken = body.nextPageToken ?? null;
      if (expectedNextPageToken !== null && (
        typeof expectedNextPageToken !== "string" ||
        expectedNextPageToken.length === 0 ||
        expectedNextPageToken.length > 4_096
      )) {
        fail("PARTIAL_TARGET_OBJECT_PAGE_CHAIN_INVALID", "Target object next-page token is invalid.");
      }
    }
    if (expectedNextPageToken !== null) {
      fail("PARTIAL_TARGET_OBJECT_PAGE_CHAIN_INVALID", "Target object list ended before its next page.");
    }
    const seenObjectVersions = new Set();
    for (const object of objects) {
      const identity = `${object.name}\0${object.generation}`;
      if (seenObjectVersions.has(identity)) {
        fail("PARTIAL_TARGET_OBJECT_RESPONSE_INVALID", "Target object list contains a duplicate version.");
      }
      seenObjectVersions.add(identity);
    }
    const namespace = COPY_POLICY_CANDIDATE.copyPolicy.migrationNamespace;
    const prefix = `${namespace}/`;
    const isMigrationNamespaceObject = (object) =>
      object.name === namespace || object.name.startsWith(prefix);
    const namespaceObjects = objects.filter(isMigrationNamespaceObject);
    const unmanagedObjects = objects.filter(
      (object) => !isMigrationNamespaceObject(object),
    );
    const total = (entries) => entries.reduce((sum, object) => {
      const next = sum + object.sizeBytes;
      if (!Number.isSafeInteger(next)) {
        fail("PARTIAL_TARGET_OBJECT_RESPONSE_INVALID", "Target object totals are unsafe.");
      }
      return next;
    }, 0);
    const digestable = (entries) => entries.map((object) => ({
      nameSha256: object.nameSha256,
      generation: object.generation,
      sizeBytes: object.sizeBytes,
    })).sort((left, right) =>
      `${left.nameSha256}\0${left.generation}`.localeCompare(
        `${right.nameSha256}\0${right.generation}`,
      ));
    const summary = {
      bucketName: bucket.targetBucket,
      configurationHttpStatus: configurationRequest.httpStatus,
      configurationRead: true,
      configurationSafe,
      ...configSummary,
      configurationEvidenceDigestSha256: sha256(canonicalJson(configSummary)),
      iamHttpStatus: iamRequest.httpStatus,
      iamRead: iamRequest.httpStatus === 200,
      bucketIamBindingCount,
      inheritedStorageIamBindingCount: inherited.bindings.length,
      publicIamMemberCount,
      noConditionalBindings,
      bucketMatchesFrozenAllowlist,
      inheritedStorageBindingsEmpty,
      effectiveMatchesFrozenAllowlist,
      bucketIamEvidenceDigestSha256,
      inheritedIamEvidenceDigestSha256,
      objectListHttpStatuses: objectRequests.map((request) => request.httpStatus),
      objectListComplete: true,
      totalObjectCount: objects.length,
      totalBytes: total(objects),
      namespaceObjectCount: namespaceObjects.length,
      namespaceTotalBytes: total(namespaceObjects),
      namespaceInventoryDigestSha256: sha256(canonicalJson(digestable(namespaceObjects))),
      unmanagedObjectCount: unmanagedObjects.length,
      unmanagedTotalBytes: total(unmanagedObjects),
      unmanagedInventoryDigestSha256: sha256(canonicalJson(digestable(unmanagedObjects))),
    };
    requireExactKeys(
      summary,
      TARGET_SUMMARY_KEYS,
      "PARTIAL_TARGET_SUMMARY_SCHEMA_MISMATCH",
      "partial target summary",
    );
    targets.push(summary);
  }
  return {
    targets: targets.sort((left, right) => left.bucketName.localeCompare(right.bucketName)),
    inherited,
  };
};

const buildBlockers = ({ source, targets, inherited }) => {
  const blockers = [];
  if (!source.requiredBucketSetComplete || !source.requiredPublicStatesMatch) {
    blockers.push("SOURCE_REQUIRED_BUCKET_STATE_DRIFT");
  }
  if (source.unknownBucketCount > 0) blockers.push("SOURCE_UNKNOWN_BUCKET_REVIEW_REQUIRED");
  if (targets.some((target) => !target.configurationSafe)) {
    blockers.push("TARGET_BUCKET_CONFIGURATION_UNSAFE");
  }
  if (targets.some((target) => target.iamHttpStatus !== 200)) {
    blockers.push("TARGET_BUCKET_IAM_READ_INCOMPLETE");
  }
  if (targets.some((target) => target.effectiveMatchesFrozenAllowlist !== true)) {
    blockers.push("TARGET_IAM_NOT_FROZEN_ALLOWLIST");
  }
  if (targets.some((target) => target.namespaceObjectCount > 0)) {
    blockers.push("TARGET_NAMESPACE_REQUIRES_SOURCE_BOUND_VERIFICATION");
  }
  if (inherited.unresolvedRoleCount > 0) blockers.push("TARGET_IAM_ROLE_UNRESOLVED");
  if (inherited.commandFailures > 0) blockers.push("TARGET_INHERITED_IAM_READ_INCOMPLETE");
  blockers.push("TARGET_SIGNING_EVIDENCE_NOT_CAPTURED");
  blockers.push("SOURCE_BOUND_CANONICAL_PREFLIGHT_NOT_RUN");
  blockers.push("COPY_POLICY_NOT_ACTIVATED");
  blockers.push("COPY_EXECUTION_NOT_ALLOWED");
  return [...new Set(blockers)];
};

export const buildReadonlyPartialEvidence = ({
  rawCapture,
  rawCaptureFileDigestSha256,
}) => {
  validateCopyPolicyCandidate();
  validateRawPartialCapture(rawCapture);
  requireSha256(
    rawCaptureFileDigestSha256,
    "RAW_PARTIAL_CAPTURE_FILE_DIGEST_INVALID",
    "raw capture file digest",
  );
  const requests = rawCapture.requests.map(sanitizeRequest);
  const source = normalizeSourceBucketSummary(rawCapture.requests);
  const { targets, inherited } = normalizeTargetSummary(rawCapture.requests);
  const evidence = {
    schemaVersion: PARTIAL_EVIDENCE_SCHEMA,
    captureId: rawCapture.captureId,
    windowStartedAt: rawCapture.windowStartedAt,
    windowEndedAt: rawCapture.windowEndedAt,
    collectorRevision: rawCapture.collectorRevision,
    environment: rawCapture.environment,
    project: rawCapture.project,
    region: rawCapture.region,
    contractFileDigestSha256: rawCapture.contractFileDigestSha256,
    copyPolicyCandidateFileDigestSha256:
      rawCapture.copyPolicyCandidateFileDigestSha256,
    sourceProjectRefSha256: sha256(
      STORAGE_CUTOVER_CONTRACT.sourceSnapshot.projectRef,
    ),
    normalizationAlgorithms: PARTIAL_NORMALIZATION_ALGORITHMS,
    rawCaptureFileDigestSha256,
    rawCaptureDigestSha256: rawCapture.rawCaptureDigestSha256,
    requestCount: requests.length,
    requestEvidenceDigestSha256: sha256(canonicalJson(requests)),
    requests,
    source,
    targets,
    blockers: buildBlockers({ source, targets, inherited }),
    safeForCopy: false,
    providerMutationAllowed: false,
    evidenceDigestSha256: null,
  };
  evidence.evidenceDigestSha256 = calculateSelfBoundDigest(
    evidence,
    "evidenceDigestSha256",
  );
  return evidence;
};

export const validateReadonlyPartialEvidence = ({
  rawCapture,
  rawCaptureFileDigestSha256,
  evidence,
}) => {
  requireExactKeys(
    evidence,
    EVIDENCE_KEYS,
    "PARTIAL_EVIDENCE_SCHEMA_MISMATCH",
    "partial evidence",
  );
  if (evidence.schemaVersion !== PARTIAL_EVIDENCE_SCHEMA) {
    fail("PARTIAL_EVIDENCE_SCHEMA_MISMATCH", "Partial evidence schema changed.");
  }
  requireSha256(
    evidence.evidenceDigestSha256,
    "PARTIAL_EVIDENCE_DIGEST_INVALID",
    "partial evidence digest",
  );
  if (
    calculateSelfBoundDigest(evidence, "evidenceDigestSha256") !==
    evidence.evidenceDigestSha256
  ) {
    fail("PARTIAL_EVIDENCE_DIGEST_MISMATCH", "Partial evidence digest does not match.");
  }
  const recomputed = buildReadonlyPartialEvidence({
    rawCapture,
    rawCaptureFileDigestSha256,
  });
  if (!exactJson(evidence, recomputed)) {
    fail("PARTIAL_EVIDENCE_RECOMPUTE_MISMATCH", "Partial evidence does not match raw provider responses.");
  }
  if (
    evidence.safeForCopy !== false ||
    evidence.providerMutationAllowed !== false ||
    COPY_POLICY_CANDIDATE.executionActivated !== false ||
    COPY_POLICY_CANDIDATE.copyExecutionAllowed !== false
  ) {
    fail("PARTIAL_EVIDENCE_EXECUTION_UNSAFE", "Partial evidence cannot authorize execution.");
  }
  return {
    valid: true,
    captureId: evidence.captureId,
    requestCount: evidence.requestCount,
    blockerCount: evidence.blockers.length,
    safeForCopy: false,
  };
};

const boundedResponseBytes = async (response) => {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAXIMUM_PARTIAL_RESPONSE_BYTES)) {
    await response.body?.cancel();
    fail("PARTIAL_RESPONSE_TOO_LARGE", "A partial evidence response exceeded its size bound.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = Buffer.from(value);
      total += bytes.length;
      if (total > MAXIMUM_PARTIAL_RESPONSE_BYTES) {
        await reader.cancel();
        fail("PARTIAL_RESPONSE_TOO_LARGE", "A partial evidence response exceeded its size bound.");
      }
      chunks.push(bytes);
    }
  } finally {
    try { reader.releaseLock(); } catch { void 0; }
  }
  return Buffer.concat(chunks, total);
};

const createRecorder = ({ captureId, now = () => new Date(), requests }) => {
  const append = ({
    transport,
    provider,
    endpointClass,
    scope,
    pageIndex = null,
    method,
    requestTarget,
    startedAt,
    endedAt,
    httpStatus,
    processExitStatus,
    responseBytes,
  }) => {
    const request = buildRawPartialRequest({
      captureId,
      ordinal: requests.length,
      transport,
      provider,
      endpointClass,
      scope,
      pageIndex,
      method,
      requestTarget,
      startedAt,
      endedAt,
      httpStatus,
      processExitStatus,
      responseBytes,
    });
    requests.push(request);
    return request;
  };
  const httpJson = async ({
    fetchImpl,
    url,
    headers,
    provider,
    endpointClass,
    scope,
    pageIndex = null,
  }) => {
    const startedAt = now().toISOString();
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(PARTIAL_REQUEST_TIMEOUT_MS),
      });
    } catch {
      fail("PARTIAL_READ_TRANSPORT_FAILED", "A read-only partial evidence request failed.");
    }
    const responseBytes = await boundedResponseBytes(response);
    const request = append({
      transport: "HTTP_JSON",
      provider,
      endpointClass,
      scope,
      pageIndex,
      method: "GET",
      requestTarget: String(url),
      startedAt,
      endedAt: now().toISOString(),
      httpStatus: response.status,
      processExitStatus: null,
      responseBytes,
    });
    let body = null;
    try { body = JSON.parse(responseBytes.toString("utf8")); } catch { void 0; }
    return { request, body };
  };
  const localRead = ({ executable, args, endpointClass, scope }) => {
    const startedAt = now().toISOString();
    const result = runCommandCapture(executable, args);
    const request = append({
      transport: "LOCAL_GCLOUD_READ",
      provider: "gcp",
      endpointClass,
      scope,
      method: "LOCAL_READ",
      requestTarget: canonicalJson({ executable, args }),
      startedAt,
      endedAt: now().toISOString(),
      httpStatus: null,
      processExitStatus: result.status,
      responseBytes: result.stdout,
    });
    return { request, body: result.body };
  };
  return { httpJson, localRead };
};

const runCommandCapture = (executable, args) => {
  let stdout;
  let status;
  try {
    stdout = runCommand(executable, args, {
      maximumOutputBytes: MAXIMUM_PARTIAL_RESPONSE_BYTES,
    });
    status = 0;
  } catch {
    stdout = "";
    status = 1;
  }
  const bytes = Buffer.from(stdout);
  let body = null;
  try { body = JSON.parse(stdout); } catch { void 0; }
  return { stdout: bytes, status, body };
};

const collectLocalIamReads = ({ recorder }) => {
  const project = recorder.localRead({
    executable: "gcloud",
    args: ["projects", "get-iam-policy", "hushh-tech-uat", "--format=json"],
    endpointClass: "GCP_PROJECT_IAM",
    scope: "projects/hushh-tech-uat",
  });
  const ancestors = recorder.localRead({
    executable: "gcloud",
    args: ["projects", "get-ancestors", "hushh-tech-uat", "--format=json"],
    endpointClass: "GCP_ANCESTORS",
    scope: "projects/hushh-tech-uat",
  });
  const policies = [project.body];
  if (Array.isArray(ancestors.body)) {
    for (const ancestor of ancestors.body) {
      if (ancestor.type === "folder") {
        policies.push(recorder.localRead({
          executable: "gcloud",
          args: ["resource-manager", "folders", "get-iam-policy", String(ancestor.id), "--format=json"],
          endpointClass: "GCP_FOLDER_IAM",
          scope: `folders/${ancestor.id}`,
        }).body);
      } else if (ancestor.type === "organization") {
        policies.push(recorder.localRead({
          executable: "gcloud",
          args: ["organizations", "get-iam-policy", String(ancestor.id), "--format=json"],
          endpointClass: "GCP_ORGANIZATION_IAM",
          scope: `organizations/${ancestor.id}`,
        }).body);
      }
    }
  }
  const roles = new Set(
    policies.filter(isPlainObject)
      .flatMap((policy) => policy.bindings || [])
      .map((binding) => binding.role)
      .filter((role) => typeof role === "string" && !simpleStorageRole(role)),
  );
  for (const role of [...roles].sort()) {
    let args;
    if (role.startsWith("projects/")) {
      const [, projectId, , roleName] = role.split("/");
      args = ["iam", "roles", "describe", roleName, `--project=${projectId}`, "--format=json"];
    } else if (role.startsWith("organizations/")) {
      const [, organization, , roleName] = role.split("/");
      args = ["iam", "roles", "describe", roleName, `--organization=${organization}`, "--format=json"];
    } else {
      args = ["iam", "roles", "describe", role, "--format=json"];
    }
    recorder.localRead({
      executable: "gcloud",
      args,
      endpointClass: "GCP_ROLE_DESCRIPTION",
      scope: role,
    });
  }
};

export const captureReadonlyPartialEvidence = async ({
  sourceCredential,
  gcpAccessToken,
  fetchImpl = fetch,
  now = () => new Date(),
  captureId = `storage-partial-${randomUUID()}`,
  collectorRevision,
} = {}) => {
  validateCopyPolicyCandidate();
  if (
    typeof sourceCredential !== "string" ||
    sourceCredential.length < 20 ||
    typeof gcpAccessToken !== "string" ||
    gcpAccessToken.length < 20
  ) {
    fail("PARTIAL_READ_CREDENTIAL_MISSING", "Read-only partial evidence credentials are unavailable.");
  }
  if (!PARTIAL_CAPTURE_ID_PATTERN.test(captureId)) {
    fail("RAW_PARTIAL_CAPTURE_ID_INVALID", "Partial capture ID is invalid.");
  }
  if (!/^[a-f0-9]{40}$/.test(collectorRevision || "")) {
    fail("RAW_PARTIAL_CAPTURE_REVISION_INVALID", "Collector revision is invalid.");
  }
  const requests = [];
  const windowStartedAt = now().toISOString();
  const recorder = createRecorder({ captureId, now, requests });
  await recorder.httpJson({
    fetchImpl,
    url: new URL(
      `https://${STORAGE_CUTOVER_CONTRACT.sourceSnapshot.projectRef}.supabase.co/storage/v1/bucket`,
    ),
    headers: {
      apikey: sourceCredential,
      authorization: `Bearer ${sourceCredential}`,
    },
    provider: "supabase",
    endpointClass: "SOURCE_BUCKET_LIST",
    scope: "PRIMARY_SOURCE_BUCKET_SET",
  });
  for (const bucket of STORAGE_CUTOVER_CONTRACT.buckets) {
    const base = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket.targetBucket)}`;
    const headers = { authorization: `Bearer ${gcpAccessToken}` };
    await recorder.httpJson({
      fetchImpl,
      url: new URL(`${base}?projection=full`),
      headers,
      provider: "gcp",
      endpointClass: "GCS_BUCKET_CONFIGURATION",
      scope: bucket.targetBucket,
    });
    await recorder.httpJson({
      fetchImpl,
      url: new URL(`${base}/iam`),
      headers,
      provider: "gcp",
      endpointClass: "GCS_BUCKET_IAM",
      scope: bucket.targetBucket,
    });
    let pageToken = null;
    let pageIndex = 0;
    do {
      const url = new URL(`${base}/o`);
      url.searchParams.set("maxResults", "1000");
      url.searchParams.set("projection", "full");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const result = await recorder.httpJson({
        fetchImpl,
        url,
        headers,
        provider: "gcp",
        endpointClass: "GCS_OBJECT_LIST",
        scope: bucket.targetBucket,
        pageIndex,
      });
      if (result.request.httpStatus !== 200 || !isPlainObject(result.body)) break;
      pageToken = result.body.nextPageToken ?? null;
      pageIndex += 1;
      if (pageIndex > 100) fail("PARTIAL_TARGET_OBJECT_PAGE_LIMIT", "Target object pages exceeded the safety bound.");
    } while (pageToken);
  }
  collectLocalIamReads({ recorder });
  const rawCapture = finalizeRawPartialCapture({
    schemaVersion: RAW_PARTIAL_CAPTURE_SCHEMA,
    captureId,
    windowStartedAt,
    windowEndedAt: now().toISOString(),
    collectorRevision,
    environment: "uat",
    project: "hushh-tech-uat",
    region: "us-central1",
    contractFileDigestSha256: contractFileDigestSha256(),
    copyPolicyCandidateFileDigestSha256: copyPolicyCandidateFileDigestSha256(),
    requests,
    rawCaptureDigestSha256: null,
  });
  const rawBytes = Buffer.from(`${JSON.stringify(rawCapture, null, 2)}\n`);
  const evidence = buildReadonlyPartialEvidence({
    rawCapture,
    rawCaptureFileDigestSha256: sha256(rawBytes),
  });
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
  return { rawCapture, rawBytes, evidence, evidenceBytes };
};

const parseArguments = (argv) => {
  const flags = new Set(["--allow-read-only-live"]);
  const valueFlags = new Set([
    "--mode",
    "--environment",
    "--project",
    "--raw-output",
    "--evidence-output",
    "--raw-capture",
    "--raw-capture-file-digest-sha256",
    "--evidence",
    "--evidence-file-digest-sha256",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flags.has(argument)) {
      if (values.has(argument)) fail("DUPLICATE_ARGUMENT", "A partial evidence flag was duplicated.");
      values.set(argument, true);
      continue;
    }
    if (!valueFlags.has(argument)) {
      fail("UNSUPPORTED_ARGUMENT", "Only documented partial evidence arguments are accepted.");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("MISSING_ARGUMENT_VALUE", "A partial evidence argument is missing its value.");
    }
    if (values.has(argument)) fail("DUPLICATE_ARGUMENT", "A partial evidence argument was duplicated.");
    values.set(argument, value);
    index += 1;
  }
  return values;
};

const requiredArgument = (values, name) => {
  const value = values.get(name);
  if (typeof value !== "string" || value.length === 0) {
    fail("MISSING_ARGUMENT", `${name} is required.`);
  }
  return value;
};

export const runReadonlyPartialEvidenceCli = async (argv, dependencies = {}) => {
  const values = parseArguments(argv);
  const mode = values.get("--mode") || "capture";
  if (!new Set(["capture", "validate"]).has(mode)) {
    fail("UNSUPPORTED_MODE", "Partial evidence mode must be capture or validate.");
  }
  const environment = values.get("--environment") || "uat";
  const project = values.get("--project") || "hushh-tech-uat";
  if (environment !== "uat" || project !== "hushh-tech-uat") {
    fail("PARTIAL_CAPTURE_SCOPE_BLOCKED", "Partial evidence is restricted to Hushh Tech UAT.");
  }
  validateCopyPolicyCandidate();
  if (mode === "capture" && !values.has("--allow-read-only-live")) {
    return {
      ok: true,
      mode,
      dryRun: true,
      readOnlyLiveExecuted: false,
      executionAllowed: false,
    };
  }
  if (mode === "capture") {
    const rawOutput = requiredArgument(values, "--raw-output");
    const evidenceOutput = requiredArgument(values, "--evidence-output");
    const sourceCredential = dependencies.sourceCredential ??
      process.env.SUPABASE_SERVICE_ROLE_KEY;
    const gcpAccessToken = dependencies.gcpAccessToken ??
      runCommand("gcloud", ["auth", "print-access-token"]).trim();
    const captured = await captureReadonlyPartialEvidence({
      sourceCredential,
      gcpAccessToken,
      fetchImpl: dependencies.fetchImpl,
      now: dependencies.now,
      captureId: dependencies.captureId,
      collectorRevision: dependencies.collectorRevision ?? currentCleanGitHead(),
    });
    writePrivateArtifact(rawOutput, captured.rawBytes);
    writePrivateArtifact(evidenceOutput, captured.evidenceBytes);
    return {
      ok: true,
      mode,
      dryRun: false,
      readOnlyLiveExecuted: true,
      captureId: captured.evidence.captureId,
      rawCaptureFileDigestSha256: sha256(captured.rawBytes),
      evidenceFileDigestSha256: sha256(captured.evidenceBytes),
      requestCount: captured.evidence.requestCount,
      blockerCount: captured.evidence.blockers.length,
      safeForCopy: false,
      providerMutationAllowed: false,
    };
  }
  const rawPath = requiredArgument(values, "--raw-capture");
  const rawFileDigest = requiredArgument(values, "--raw-capture-file-digest-sha256");
  const evidencePath = requiredArgument(values, "--evidence");
  const evidenceFileDigest = requiredArgument(values, "--evidence-file-digest-sha256");
  requireSha256(rawFileDigest, "RAW_PARTIAL_CAPTURE_FILE_DIGEST_INVALID", "raw capture file digest");
  requireSha256(evidenceFileDigest, "PARTIAL_EVIDENCE_FILE_DIGEST_INVALID", "evidence file digest");
  const rawArtifact = readPrivateArtifact(rawPath, { maximumBytes: MAXIMUM_PRIVATE_INPUT_BYTES });
  const evidenceArtifact = readPrivateArtifact(evidencePath, { maximumBytes: MAXIMUM_PRIVATE_INPUT_BYTES });
  if (
    rawArtifact.fileDigestSha256 !== rawFileDigest ||
    evidenceArtifact.fileDigestSha256 !== evidenceFileDigest
  ) {
    fail("PARTIAL_EVIDENCE_FILE_DIGEST_MISMATCH", "A partial evidence input file changed.");
  }
  let rawCapture;
  let evidence;
  try {
    rawCapture = JSON.parse(rawArtifact.bytes.toString("utf8"));
    evidence = JSON.parse(evidenceArtifact.bytes.toString("utf8"));
  } catch {
    fail("PARTIAL_EVIDENCE_JSON_INVALID", "A partial evidence input is not valid JSON.");
  }
  return {
    ok: true,
    mode,
    ...validateReadonlyPartialEvidence({
      rawCapture,
      rawCaptureFileDigestSha256: rawFileDigest,
      evidence,
    }),
  };
};

const isDirectExecution =
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  runReadonlyPartialEvidenceCli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify(safeErrorResult(error, "PARTIAL_EVIDENCE_FAILED"))}\n`,
      );
      process.exitCode = 1;
    });
}
