#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  calculateSelfBoundDigest,
  canonicalJson,
  fail,
  readPrivateArtifact,
  requireExactKeys,
  requireIsoTimestamp,
  requireSha256,
  safeErrorResult,
  sha256,
  writePrivateArtifact,
} from "./storage-live-common.mjs";

export const UNKNOWN_SOURCE_REVIEW_SCHEMA =
  "storage-unknown-source-review-evidence-v1";

const CLASSIFICATION_SCHEMA =
  "private-unknown-supabase-storage-bucket-classification-v1";
const TRAFFIC_SCHEMA = "private-unknown-supabase-storage-traffic-v1";
const RECOMMENDATION_SCHEMA =
  "supabase-storage-bucket-drift-recommendation-v1";

const CLASSIFICATION_KEYS = [
  "schemaVersion",
  "captureId",
  "windowStartedAt",
  "windowEndedAt",
  "rawBucketId",
  "rawBucketIdSha256",
  "bucketRecordDigestSha256",
  "public",
  "createdAt",
  "updatedAt",
  "firstMetadataDigestSha256",
  "secondMetadataDigestSha256",
  "stableTwoPass",
  "objectCount",
  "totalBytes",
  "lastObjectUpdatedAt",
  "objects",
  "currentCallerPaths",
  "historicalCommits",
  "historicalPaths",
  "urlEvidence",
  "sourceObjectBytesDownloaded",
  "providerMutationAllowed",
  "evidenceDigestSha256",
];

const CLASSIFICATION_OBJECT_KEYS = [
  "objectKeySha256",
  "sizeBytes",
  "sourceUpdatedAt",
  "mimeTypeDigestSha256",
  "cacheControlDigestSha256",
  "metadataRecordDigestSha256",
];

const TRAFFIC_KEYS = [
  "schemaVersion",
  "captureId",
  "classificationCaptureId",
  "rawBucketId",
  "rawBucketIdSha256",
  "windowStartUtc",
  "windowEndUtc",
  "windowCount",
  "windowHours",
  "logRetentionAvailableDays",
  "managementApiEndpoint",
  "requestMethod",
  "logSource",
  "queryTemplateDigestSha256",
  "aggregateOnly",
  "selectedRawLogFields",
  "windows",
  "totals",
  "providerMutationAllowed",
  "evidenceDigestSha256",
];

const TRAFFIC_WINDOW_KEYS = [
  "index",
  "startUtc",
  "endUtc",
  "requestMethod",
  "endpointClass",
  "logSource",
  "queryDigestSha256",
  "responseDigestSha256",
  "metrics",
  "firstObservedAt",
  "lastObservedAt",
];

const METRIC_KEYS = [
  "request_count",
  "method_get_count",
  "method_head_count",
  "method_post_count",
  "method_put_count",
  "method_patch_count",
  "method_delete_count",
  "method_options_count",
  "method_other_count",
  "status_1xx_count",
  "status_2xx_count",
  "status_3xx_count",
  "status_4xx_count",
  "status_5xx_count",
  "status_other_count",
];

const RECOMMENDATION_KEYS = [
  "schemaVersion",
  "createdAt",
  "rawBucketIdSha256",
  "sourceProjectRefClass",
  "ownerClassification",
  "useClassification",
  "objectCount",
  "totalBytes",
  "lastObjectUpdatedAt",
  "repoCurrentCallerCount",
  "repoHistoricalCommitCount",
  "repoUrlEvidenceCount",
  "trafficWindowStartUtc",
  "trafficWindowEndUtc",
  "trafficRequestCount",
  "trafficWriteLikeRequestCount",
  "trafficDeleteRequestCount",
  "recommendation",
  "exclusionSafe",
  "contractChangeAuthorized",
  "requiredNextReview",
  "secondaryProjectReferencesNotAutomaticallyAssociated",
  "secondaryReferences",
  "classificationFileDigestSha256",
  "classificationEvidenceDigestSha256",
  "trafficFileDigestSha256",
  "trafficEvidenceDigestSha256",
  "retirementManifestFileDigestSha256",
  "evidenceDigestSha256",
];

const SECONDARY_REFERENCE_KEYS = [
  "referenceKey",
  "migrationState",
  "finalDisposition",
];

const REVIEW_EVIDENCE_KEYS = [
  "schemaVersion",
  "createdAt",
  "unknownBucketIdSha256",
  "classification",
  "traffic",
  "recommendation",
  "blockers",
  "sourceCopyAllowed",
  "targetCopyAllowed",
  "contractChangeAuthorized",
  "providerMutationAllowed",
  "evidenceDigestSha256",
];

const CLASSIFICATION_SUMMARY_KEYS = [
  "captureId",
  "windowStartedAt",
  "windowEndedAt",
  "fileDigestSha256",
  "evidenceDigestSha256",
  "bucketRecordDigestSha256",
  "public",
  "firstMetadataDigestSha256",
  "secondMetadataDigestSha256",
  "stableTwoPass",
  "objectCount",
  "totalBytes",
  "lastObjectUpdatedAt",
  "objectMetadataDigestSha256",
  "repoCurrentCallerCount",
  "repoHistoricalCommitCount",
  "repoHistoricalPathCount",
  "repoUrlEvidenceCount",
  "sourceObjectBytesDownloaded",
];

const TRAFFIC_SUMMARY_KEYS = [
  "captureId",
  "classificationCaptureId",
  "windowStartUtc",
  "windowEndUtc",
  "windowCount",
  "windowHours",
  "fileDigestSha256",
  "evidenceDigestSha256",
  "requestMethod",
  "endpointClass",
  "logSource",
  "queryTemplateDigestSha256",
  "windowQueryResponseDigestSha256",
  "aggregateOnly",
  "selectedRawLogFields",
  "totals",
  "firstObservedAt",
  "lastObservedAt",
];

const RECOMMENDATION_SUMMARY_KEYS = [
  "fileDigestSha256",
  "evidenceDigestSha256",
  "createdAt",
  "sourceProjectRefClass",
  "ownerClassification",
  "useClassification",
  "recommendation",
  "exclusionSafe",
  "contractChangeAuthorized",
  "requiredNextReviewDigestSha256",
  "secondaryReferenceCount",
  "secondaryReferenceDispositionDigestSha256",
  "retirementManifestFileDigestSha256",
  "requiredOwnershipDisposition",
];

const EXPECTED_SECONDARY_REFERENCES = [
  "devops-webhook",
  "kyc-client-runtime",
  "kyc-protocol-documentation",
  "legacy-community-data",
  "legacy-metrics-project",
  "reports-market-storage",
].sort();

const requireNonNegativeInteger = (value, code, label) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(code, `${label} must be a safe non-negative integer.`);
  }
  return value;
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

const requireSelfDigest = (value, code, label) => {
  requireSha256(value.evidenceDigestSha256, code, `${label} digest`);
  if (
    calculateSelfBoundDigest(value, "evidenceDigestSha256") !==
    value.evidenceDigestSha256
  ) {
    fail(code, `${label} digest does not match.`);
  }
};

const requirePrivateBucketId = (value) => {
  requireBoundedString(value.rawBucketId, "UNKNOWN_REVIEW_BUCKET_ID_INVALID", "bucket ID", 256);
  requireSha256(
    value.rawBucketIdSha256,
    "UNKNOWN_REVIEW_BUCKET_ID_INVALID",
    "bucket ID digest",
  );
  if (sha256(value.rawBucketId) !== value.rawBucketIdSha256) {
    fail("UNKNOWN_REVIEW_BUCKET_ID_INVALID", "The private bucket ID digest changed.");
  }
};

const validateClassification = (classification) => {
  requireExactKeys(
    classification,
    CLASSIFICATION_KEYS,
    "UNKNOWN_REVIEW_CLASSIFICATION_SCHEMA_MISMATCH",
    "unknown bucket classification",
  );
  if (classification.schemaVersion !== CLASSIFICATION_SCHEMA) {
    fail("UNKNOWN_REVIEW_CLASSIFICATION_SCHEMA_MISMATCH", "Classification schema changed.");
  }
  requireSelfDigest(
    classification,
    "UNKNOWN_REVIEW_CLASSIFICATION_DIGEST_MISMATCH",
    "classification evidence",
  );
  requirePrivateBucketId(classification);
  requireBoundedString(
    classification.captureId,
    "UNKNOWN_REVIEW_CLASSIFICATION_INVALID",
    "classification capture ID",
  );
  requireIsoTimestamp(
    classification.windowStartedAt,
    "UNKNOWN_REVIEW_CLASSIFICATION_INVALID",
    "classification start",
  );
  requireIsoTimestamp(
    classification.windowEndedAt,
    "UNKNOWN_REVIEW_CLASSIFICATION_INVALID",
    "classification end",
  );
  if (Date.parse(classification.windowEndedAt) < Date.parse(classification.windowStartedAt)) {
    fail("UNKNOWN_REVIEW_CLASSIFICATION_INVALID", "Classification window is reversed.");
  }
  for (const field of [
    "bucketRecordDigestSha256",
    "firstMetadataDigestSha256",
    "secondMetadataDigestSha256",
  ]) {
    requireSha256(
      classification[field],
      "UNKNOWN_REVIEW_CLASSIFICATION_INVALID",
      field,
    );
  }
  if (
    classification.stableTwoPass !== true ||
    classification.firstMetadataDigestSha256 !==
      classification.secondMetadataDigestSha256 ||
    classification.sourceObjectBytesDownloaded !== false ||
    classification.providerMutationAllowed !== false ||
    typeof classification.public !== "boolean" ||
    !Array.isArray(classification.objects)
  ) {
    fail("UNKNOWN_REVIEW_CLASSIFICATION_INVALID", "Classification is not stable read-only metadata evidence.");
  }
  const identities = new Set();
  let totalBytes = 0;
  let lastObjectUpdatedAt = null;
  for (const object of classification.objects) {
    requireExactKeys(
      object,
      CLASSIFICATION_OBJECT_KEYS,
      "UNKNOWN_REVIEW_OBJECT_SCHEMA_MISMATCH",
      "unknown bucket object metadata",
    );
    for (const field of [
      "objectKeySha256",
      "mimeTypeDigestSha256",
      "cacheControlDigestSha256",
      "metadataRecordDigestSha256",
    ]) {
      requireSha256(object[field], "UNKNOWN_REVIEW_OBJECT_INVALID", field);
    }
    if (identities.has(object.objectKeySha256)) {
      fail("UNKNOWN_REVIEW_OBJECT_INVALID", "Object metadata contains a duplicate key digest.");
    }
    identities.add(object.objectKeySha256);
    requireNonNegativeInteger(object.sizeBytes, "UNKNOWN_REVIEW_OBJECT_INVALID", "object bytes");
    totalBytes += object.sizeBytes;
    if (!Number.isSafeInteger(totalBytes)) {
      fail("UNKNOWN_REVIEW_OBJECT_INVALID", "Object byte total is unsafe.");
    }
    requireIsoTimestamp(
      object.sourceUpdatedAt,
      "UNKNOWN_REVIEW_OBJECT_INVALID",
      "object update",
    );
    if (
      lastObjectUpdatedAt === null ||
      Date.parse(object.sourceUpdatedAt) > Date.parse(lastObjectUpdatedAt)
    ) {
      lastObjectUpdatedAt = object.sourceUpdatedAt;
    }
  }
  requireNonNegativeInteger(
    classification.objectCount,
    "UNKNOWN_REVIEW_CLASSIFICATION_INVALID",
    "classification object count",
  );
  requireNonNegativeInteger(
    classification.totalBytes,
    "UNKNOWN_REVIEW_CLASSIFICATION_INVALID",
    "classification byte total",
  );
  if (
    classification.objectCount !== classification.objects.length ||
    classification.totalBytes !== totalBytes ||
    classification.lastObjectUpdatedAt !== lastObjectUpdatedAt ||
    sha256(canonicalJson(classification.objects)) !==
      classification.firstMetadataDigestSha256
  ) {
    fail("UNKNOWN_REVIEW_CLASSIFICATION_INVALID", "Classification metadata totals or digest changed.");
  }
  for (const field of [
    "currentCallerPaths",
    "historicalCommits",
    "historicalPaths",
    "urlEvidence",
  ]) {
    if (!Array.isArray(classification[field])) {
      fail("UNKNOWN_REVIEW_CLASSIFICATION_INVALID", "Repository evidence must be an array.");
    }
  }
  return classification;
};

const validateMetrics = (metrics, label) => {
  requireExactKeys(
    metrics,
    METRIC_KEYS,
    "UNKNOWN_REVIEW_TRAFFIC_METRICS_SCHEMA_MISMATCH",
    label,
  );
  for (const key of METRIC_KEYS) {
    requireNonNegativeInteger(
      metrics[key],
      "UNKNOWN_REVIEW_TRAFFIC_METRICS_INVALID",
      `${label} ${key}`,
    );
  }
  const methods = METRIC_KEYS.filter((key) => key.startsWith("method_"))
    .reduce((sum, key) => sum + metrics[key], 0);
  const statuses = METRIC_KEYS.filter((key) => key.startsWith("status_"))
    .reduce((sum, key) => sum + metrics[key], 0);
  if (methods !== metrics.request_count || statuses !== metrics.request_count) {
    fail("UNKNOWN_REVIEW_TRAFFIC_METRICS_INVALID", "Traffic dimensions do not reconcile.");
  }
};

const sumMetrics = (windows) => Object.fromEntries(
  METRIC_KEYS.map((key) => [
    key,
    windows.reduce((sum, window) => sum + window.metrics[key], 0),
  ]),
);

const validateTraffic = (traffic) => {
  requireExactKeys(
    traffic,
    TRAFFIC_KEYS,
    "UNKNOWN_REVIEW_TRAFFIC_SCHEMA_MISMATCH",
    "unknown bucket traffic evidence",
  );
  if (traffic.schemaVersion !== TRAFFIC_SCHEMA) {
    fail("UNKNOWN_REVIEW_TRAFFIC_SCHEMA_MISMATCH", "Traffic schema changed.");
  }
  requireSelfDigest(
    traffic,
    "UNKNOWN_REVIEW_TRAFFIC_DIGEST_MISMATCH",
    "traffic evidence",
  );
  requirePrivateBucketId(traffic);
  for (const field of ["windowStartUtc", "windowEndUtc"]) {
    requireIsoTimestamp(traffic[field], "UNKNOWN_REVIEW_TRAFFIC_INVALID", field);
  }
  for (const field of ["queryTemplateDigestSha256"]) {
    requireSha256(traffic[field], "UNKNOWN_REVIEW_TRAFFIC_INVALID", field);
  }
  if (
    traffic.requestMethod !== "GET" ||
    traffic.managementApiEndpoint !== "/v1/projects/{ref}/analytics/endpoints/logs" ||
    traffic.logSource !== "storage_logs" ||
    traffic.aggregateOnly !== true ||
    traffic.selectedRawLogFields !== false ||
    traffic.providerMutationAllowed !== false ||
    !Array.isArray(traffic.windows)
  ) {
    fail("UNKNOWN_REVIEW_TRAFFIC_INVALID", "Traffic evidence escaped the aggregate read-only contract.");
  }
  requireNonNegativeInteger(traffic.windowCount, "UNKNOWN_REVIEW_TRAFFIC_INVALID", "window count");
  requireNonNegativeInteger(traffic.windowHours, "UNKNOWN_REVIEW_TRAFFIC_INVALID", "window hours");
  if (
    traffic.windowCount !== traffic.windows.length ||
    traffic.windowCount === 0 ||
    traffic.windowHours === 0
  ) {
    fail("UNKNOWN_REVIEW_TRAFFIC_INVALID", "Traffic window declaration changed.");
  }
  let expectedStart = traffic.windowStartUtc;
  for (const [index, window] of traffic.windows.entries()) {
    requireExactKeys(
      window,
      TRAFFIC_WINDOW_KEYS,
      "UNKNOWN_REVIEW_TRAFFIC_WINDOW_SCHEMA_MISMATCH",
      "traffic window",
    );
    requireIsoTimestamp(window.startUtc, "UNKNOWN_REVIEW_TRAFFIC_WINDOW_INVALID", "window start");
    requireIsoTimestamp(window.endUtc, "UNKNOWN_REVIEW_TRAFFIC_WINDOW_INVALID", "window end");
    requireSha256(window.queryDigestSha256, "UNKNOWN_REVIEW_TRAFFIC_WINDOW_INVALID", "query digest");
    requireSha256(window.responseDigestSha256, "UNKNOWN_REVIEW_TRAFFIC_WINDOW_INVALID", "response digest");
    const expectedEnd = new Date(
      Date.parse(window.startUtc) + traffic.windowHours * 60 * 60 * 1_000,
    ).toISOString();
    if (
      window.index !== index ||
      window.startUtc !== expectedStart ||
      window.endUtc !== expectedEnd ||
      window.requestMethod !== traffic.requestMethod ||
      window.endpointClass !== "SUPABASE_MANAGEMENT_ANALYTICS_LOGS" ||
      window.logSource !== traffic.logSource
    ) {
      fail("UNKNOWN_REVIEW_TRAFFIC_WINDOW_INVALID", "Traffic windows are not exact contiguous reads.");
    }
    for (const field of ["firstObservedAt", "lastObservedAt"]) {
      if (window[field] !== null) {
        requireBoundedString(
          window[field],
          "UNKNOWN_REVIEW_TRAFFIC_WINDOW_INVALID",
          field,
          128,
        );
      }
    }
    validateMetrics(window.metrics, "traffic window metrics");
    expectedStart = window.endUtc;
  }
  if (expectedStart !== traffic.windowEndUtc) {
    fail("UNKNOWN_REVIEW_TRAFFIC_WINDOW_INVALID", "Traffic windows do not cover the declared interval.");
  }
  validateMetrics(traffic.totals, "traffic totals");
  if (canonicalJson(sumMetrics(traffic.windows)) !== canonicalJson(traffic.totals)) {
    fail("UNKNOWN_REVIEW_TRAFFIC_METRICS_INVALID", "Traffic totals do not equal the window sum.");
  }
  return traffic;
};

const validateRecommendation = ({
  recommendation,
  classification,
  classificationFileDigestSha256,
  traffic,
  trafficFileDigestSha256,
}) => {
  requireExactKeys(
    recommendation,
    RECOMMENDATION_KEYS,
    "UNKNOWN_REVIEW_RECOMMENDATION_SCHEMA_MISMATCH",
    "unknown bucket recommendation",
  );
  if (recommendation.schemaVersion !== RECOMMENDATION_SCHEMA) {
    fail("UNKNOWN_REVIEW_RECOMMENDATION_SCHEMA_MISMATCH", "Recommendation schema changed.");
  }
  requireSelfDigest(
    recommendation,
    "UNKNOWN_REVIEW_RECOMMENDATION_DIGEST_MISMATCH",
    "recommendation evidence",
  );
  for (const field of [
    "classificationFileDigestSha256",
    "classificationEvidenceDigestSha256",
    "trafficFileDigestSha256",
    "trafficEvidenceDigestSha256",
    "retirementManifestFileDigestSha256",
  ]) {
    requireSha256(recommendation[field], "UNKNOWN_REVIEW_RECOMMENDATION_INVALID", field);
  }
  if (
    recommendation.rawBucketIdSha256 !== classification.rawBucketIdSha256 ||
    traffic.rawBucketIdSha256 !== classification.rawBucketIdSha256 ||
    traffic.rawBucketId !== classification.rawBucketId ||
    traffic.classificationCaptureId !== classification.captureId ||
    recommendation.classificationFileDigestSha256 !== classificationFileDigestSha256 ||
    recommendation.classificationEvidenceDigestSha256 !== classification.evidenceDigestSha256 ||
    recommendation.trafficFileDigestSha256 !== trafficFileDigestSha256 ||
    recommendation.trafficEvidenceDigestSha256 !== traffic.evidenceDigestSha256 ||
    recommendation.objectCount !== classification.objectCount ||
    recommendation.totalBytes !== classification.totalBytes ||
    recommendation.lastObjectUpdatedAt !== classification.lastObjectUpdatedAt ||
    recommendation.repoCurrentCallerCount !== classification.currentCallerPaths.length ||
    recommendation.repoHistoricalCommitCount !== classification.historicalCommits.length ||
    recommendation.repoUrlEvidenceCount !== classification.urlEvidence.length ||
    recommendation.trafficWindowStartUtc !== traffic.windowStartUtc ||
    recommendation.trafficWindowEndUtc !== traffic.windowEndUtc ||
    recommendation.trafficRequestCount !== traffic.totals.request_count ||
    recommendation.trafficWriteLikeRequestCount !==
      traffic.totals.method_post_count +
        traffic.totals.method_put_count +
        traffic.totals.method_patch_count +
        traffic.totals.method_delete_count ||
    recommendation.trafficDeleteRequestCount !== traffic.totals.method_delete_count
  ) {
    fail("UNKNOWN_REVIEW_RECOMMENDATION_INVALID", "Recommendation facts do not match private evidence.");
  }
  if (
    recommendation.sourceProjectRefClass !== "LOCKED_PRIMARY_PROJECT" ||
    recommendation.ownerClassification !==
      "PRIMARY_SUPABASE_ACTIVE_STORAGE_OWNER_UNRESOLVED" ||
    recommendation.useClassification !== "LIVE_TRAFFIC_OBSERVED" ||
    recommendation.recommendation !==
      "CONTRACT_UPDATE_REVIEW_REQUIRED_DO_NOT_EXCLUDE" ||
    recommendation.exclusionSafe !== false ||
    recommendation.contractChangeAuthorized !== false ||
    recommendation.secondaryProjectReferencesNotAutomaticallyAssociated !== true ||
    !Array.isArray(recommendation.requiredNextReview) ||
    !Array.isArray(recommendation.secondaryReferences)
  ) {
    fail("UNKNOWN_REVIEW_RECOMMENDATION_INVALID", "Recommendation is not fail-closed.");
  }
  const secondaryReferences = recommendation.secondaryReferences.map((reference) => {
    requireExactKeys(
      reference,
      SECONDARY_REFERENCE_KEYS,
      "UNKNOWN_REVIEW_SECONDARY_SCHEMA_MISMATCH",
      "secondary reference",
    );
    if (
      reference.migrationState !== "OWNERSHIP_AND_NON_USE_REVIEW_REQUIRED" ||
      reference.finalDisposition !== "REMOVE_REFERENCE_BEFORE_ZERO_DEPENDENCY"
    ) {
      fail("UNKNOWN_REVIEW_SECONDARY_INVALID", "A secondary reference disposition is not fail-closed.");
    }
    return reference;
  });
  const keys = secondaryReferences.map((reference) => reference.referenceKey).sort();
  if (
    new Set(keys).size !== keys.length ||
    canonicalJson(keys) !== canonicalJson(EXPECTED_SECONDARY_REFERENCES)
  ) {
    fail("UNKNOWN_REVIEW_SECONDARY_INVALID", "Secondary reference set changed.");
  }
  return recommendation;
};

const firstObserved = (windows) => windows
  .map((window) => window.firstObservedAt)
  .filter((value) => value !== null)
  .sort()[0] ?? null;

const lastObserved = (windows) => windows
  .map((window) => window.lastObservedAt)
  .filter((value) => value !== null)
  .sort()
  .at(-1) ?? null;

export const buildUnknownSourceReviewEvidence = ({
  classification,
  classificationFileDigestSha256,
  traffic,
  trafficFileDigestSha256,
  recommendation,
  recommendationFileDigestSha256,
}) => {
  for (const [value, label] of [
    [classificationFileDigestSha256, "classification file digest"],
    [trafficFileDigestSha256, "traffic file digest"],
    [recommendationFileDigestSha256, "recommendation file digest"],
  ]) {
    requireSha256(value, "UNKNOWN_REVIEW_FILE_DIGEST_INVALID", label);
  }
  validateClassification(classification);
  validateTraffic(traffic);
  validateRecommendation({
    recommendation,
    classification,
    classificationFileDigestSha256,
    traffic,
    trafficFileDigestSha256,
  });
  const classificationSummary = {
    captureId: classification.captureId,
    windowStartedAt: classification.windowStartedAt,
    windowEndedAt: classification.windowEndedAt,
    fileDigestSha256: classificationFileDigestSha256,
    evidenceDigestSha256: classification.evidenceDigestSha256,
    bucketRecordDigestSha256: classification.bucketRecordDigestSha256,
    public: classification.public,
    firstMetadataDigestSha256: classification.firstMetadataDigestSha256,
    secondMetadataDigestSha256: classification.secondMetadataDigestSha256,
    stableTwoPass: classification.stableTwoPass,
    objectCount: classification.objectCount,
    totalBytes: classification.totalBytes,
    lastObjectUpdatedAt: classification.lastObjectUpdatedAt,
    objectMetadataDigestSha256: sha256(canonicalJson(classification.objects)),
    repoCurrentCallerCount: classification.currentCallerPaths.length,
    repoHistoricalCommitCount: classification.historicalCommits.length,
    repoHistoricalPathCount: classification.historicalPaths.length,
    repoUrlEvidenceCount: classification.urlEvidence.length,
    sourceObjectBytesDownloaded: classification.sourceObjectBytesDownloaded,
  };
  requireExactKeys(
    classificationSummary,
    CLASSIFICATION_SUMMARY_KEYS,
    "UNKNOWN_REVIEW_CLASSIFICATION_SUMMARY_SCHEMA_MISMATCH",
    "classification summary",
  );
  const queryReceipts = traffic.windows.map((window) => ({
    index: window.index,
    startUtc: window.startUtc,
    endUtc: window.endUtc,
    requestMethod: window.requestMethod,
    endpointClass: window.endpointClass,
    queryDigestSha256: window.queryDigestSha256,
    responseDigestSha256: window.responseDigestSha256,
  }));
  const trafficSummary = {
    captureId: traffic.captureId,
    classificationCaptureId: traffic.classificationCaptureId,
    windowStartUtc: traffic.windowStartUtc,
    windowEndUtc: traffic.windowEndUtc,
    windowCount: traffic.windowCount,
    windowHours: traffic.windowHours,
    fileDigestSha256: trafficFileDigestSha256,
    evidenceDigestSha256: traffic.evidenceDigestSha256,
    requestMethod: traffic.requestMethod,
    endpointClass: "SUPABASE_MANAGEMENT_ANALYTICS_LOGS",
    logSource: traffic.logSource,
    queryTemplateDigestSha256: traffic.queryTemplateDigestSha256,
    windowQueryResponseDigestSha256: sha256(canonicalJson(queryReceipts)),
    aggregateOnly: traffic.aggregateOnly,
    selectedRawLogFields: traffic.selectedRawLogFields,
    totals: structuredClone(traffic.totals),
    firstObservedAt: firstObserved(traffic.windows),
    lastObservedAt: lastObserved(traffic.windows),
  };
  requireExactKeys(
    trafficSummary,
    TRAFFIC_SUMMARY_KEYS,
    "UNKNOWN_REVIEW_TRAFFIC_SUMMARY_SCHEMA_MISMATCH",
    "traffic summary",
  );
  const recommendationSummary = {
    fileDigestSha256: recommendationFileDigestSha256,
    evidenceDigestSha256: recommendation.evidenceDigestSha256,
    createdAt: recommendation.createdAt,
    sourceProjectRefClass: recommendation.sourceProjectRefClass,
    ownerClassification: recommendation.ownerClassification,
    useClassification: recommendation.useClassification,
    recommendation: recommendation.recommendation,
    exclusionSafe: recommendation.exclusionSafe,
    contractChangeAuthorized: recommendation.contractChangeAuthorized,
    requiredNextReviewDigestSha256: sha256(
      canonicalJson(recommendation.requiredNextReview),
    ),
    secondaryReferenceCount: recommendation.secondaryReferences.length,
    secondaryReferenceDispositionDigestSha256: sha256(
      canonicalJson(
        [...recommendation.secondaryReferences].sort((left, right) =>
          left.referenceKey.localeCompare(right.referenceKey)),
      ),
    ),
    retirementManifestFileDigestSha256:
      recommendation.retirementManifestFileDigestSha256,
    requiredOwnershipDisposition:
      "EXPLICIT_OWNERSHIP_AND_MIGRATION_OR_ARCHIVE_DISPOSITION_REQUIRED",
  };
  requireExactKeys(
    recommendationSummary,
    RECOMMENDATION_SUMMARY_KEYS,
    "UNKNOWN_REVIEW_RECOMMENDATION_SUMMARY_SCHEMA_MISMATCH",
    "recommendation summary",
  );
  const evidence = {
    schemaVersion: UNKNOWN_SOURCE_REVIEW_SCHEMA,
    createdAt: recommendation.createdAt,
    unknownBucketIdSha256: classification.rawBucketIdSha256,
    classification: classificationSummary,
    traffic: trafficSummary,
    recommendation: recommendationSummary,
    blockers: [
      "SOURCE_UNKNOWN_BUCKET_OWNER_UNRESOLVED",
      "SOURCE_UNKNOWN_BUCKET_MIGRATION_OR_ARCHIVE_DISPOSITION_REQUIRED",
      "SOURCE_UNKNOWN_BUCKET_CONTRACT_REVIEW_REQUIRED",
      "SOURCE_COPY_BLOCKED",
      "TARGET_COPY_BLOCKED",
    ],
    sourceCopyAllowed: false,
    targetCopyAllowed: false,
    contractChangeAuthorized: false,
    providerMutationAllowed: false,
    evidenceDigestSha256: null,
  };
  evidence.evidenceDigestSha256 = calculateSelfBoundDigest(
    evidence,
    "evidenceDigestSha256",
  );
  return evidence;
};

export const validateUnknownSourceReviewEvidence = ({ evidence, ...inputs }) => {
  requireExactKeys(
    evidence,
    REVIEW_EVIDENCE_KEYS,
    "UNKNOWN_REVIEW_EVIDENCE_SCHEMA_MISMATCH",
    "unknown source review evidence",
  );
  if (evidence.schemaVersion !== UNKNOWN_SOURCE_REVIEW_SCHEMA) {
    fail("UNKNOWN_REVIEW_EVIDENCE_SCHEMA_MISMATCH", "Unknown source review schema changed.");
  }
  requireSelfDigest(
    evidence,
    "UNKNOWN_REVIEW_EVIDENCE_DIGEST_MISMATCH",
    "unknown source review evidence",
  );
  const recomputed = buildUnknownSourceReviewEvidence(inputs);
  if (canonicalJson(recomputed) !== canonicalJson(evidence)) {
    fail("UNKNOWN_REVIEW_EVIDENCE_RECOMPUTE_MISMATCH", "Unknown source review evidence changed.");
  }
  if (
    evidence.sourceCopyAllowed !== false ||
    evidence.targetCopyAllowed !== false ||
    evidence.contractChangeAuthorized !== false ||
    evidence.providerMutationAllowed !== false
  ) {
    fail("UNKNOWN_REVIEW_EVIDENCE_EXECUTION_UNSAFE", "Unknown source review cannot authorize execution.");
  }
  return {
    valid: true,
    unknownBucketIdSha256: evidence.unknownBucketIdSha256,
    objectCount: evidence.classification.objectCount,
    totalBytes: evidence.classification.totalBytes,
    trafficRequestCount: evidence.traffic.totals.request_count,
    sourceCopyAllowed: false,
    targetCopyAllowed: false,
  };
};

const parseArguments = (argv) => {
  const valueFlags = new Set([
    "--mode",
    "--classification",
    "--classification-file-digest-sha256",
    "--traffic",
    "--traffic-file-digest-sha256",
    "--recommendation",
    "--recommendation-file-digest-sha256",
    "--output",
    "--evidence",
    "--evidence-file-digest-sha256",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!valueFlags.has(argument)) {
      fail("UNKNOWN_REVIEW_ARGUMENT_UNSUPPORTED", "Only documented unknown-review arguments are accepted.");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || values.has(argument)) {
      fail("UNKNOWN_REVIEW_ARGUMENT_INVALID", "An unknown-review argument is missing or duplicated.");
    }
    values.set(argument, value);
    index += 1;
  }
  return values;
};

const requiredArgument = (values, name) => {
  const value = values.get(name);
  if (typeof value !== "string" || value.length === 0) {
    fail("UNKNOWN_REVIEW_ARGUMENT_MISSING", `${name} is required.`);
  }
  return value;
};

const readBoundJson = (path, expectedDigest, label) => {
  requireSha256(expectedDigest, "UNKNOWN_REVIEW_FILE_DIGEST_INVALID", `${label} file digest`);
  const artifact = readPrivateArtifact(path);
  if (artifact.fileDigestSha256 !== expectedDigest) {
    fail("UNKNOWN_REVIEW_FILE_DIGEST_MISMATCH", `${label} file digest changed.`);
  }
  try {
    return { value: JSON.parse(artifact.bytes.toString("utf8")), artifact };
  } catch {
    fail("UNKNOWN_REVIEW_JSON_INVALID", `${label} is not valid JSON.`);
  }
};

export const runUnknownSourceReviewCli = async (argv) => {
  const values = parseArguments(argv);
  const mode = values.get("--mode") || "build";
  if (!new Set(["build", "validate"]).has(mode)) {
    fail("UNKNOWN_REVIEW_MODE_INVALID", "Unknown-review mode must be build or validate.");
  }
  const classificationDigest = requiredArgument(
    values,
    "--classification-file-digest-sha256",
  );
  const trafficDigest = requiredArgument(values, "--traffic-file-digest-sha256");
  const recommendationDigest = requiredArgument(
    values,
    "--recommendation-file-digest-sha256",
  );
  const classification = readBoundJson(
    requiredArgument(values, "--classification"),
    classificationDigest,
    "classification",
  ).value;
  const traffic = readBoundJson(
    requiredArgument(values, "--traffic"),
    trafficDigest,
    "traffic",
  ).value;
  const recommendation = readBoundJson(
    requiredArgument(values, "--recommendation"),
    recommendationDigest,
    "recommendation",
  ).value;
  const inputs = {
    classification,
    classificationFileDigestSha256: classificationDigest,
    traffic,
    trafficFileDigestSha256: trafficDigest,
    recommendation,
    recommendationFileDigestSha256: recommendationDigest,
  };
  if (mode === "build") {
    const output = requiredArgument(values, "--output");
    const evidence = buildUnknownSourceReviewEvidence(inputs);
    const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    writePrivateArtifact(output, bytes);
    return {
      ok: true,
      mode,
      evidenceFileDigestSha256: sha256(bytes),
      evidenceDigestSha256: evidence.evidenceDigestSha256,
      unknownBucketIdSha256: evidence.unknownBucketIdSha256,
      objectCount: evidence.classification.objectCount,
      totalBytes: evidence.classification.totalBytes,
      trafficRequestCount: evidence.traffic.totals.request_count,
      sourceCopyAllowed: false,
      targetCopyAllowed: false,
    };
  }
  const evidenceDigest = requiredArgument(values, "--evidence-file-digest-sha256");
  const evidence = readBoundJson(
    requiredArgument(values, "--evidence"),
    evidenceDigest,
    "unknown source review evidence",
  ).value;
  return {
    ok: true,
    mode,
    ...validateUnknownSourceReviewEvidence({ evidence, ...inputs }),
  };
};

const isDirectExecution =
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  runUnknownSourceReviewCli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify(safeErrorResult(error, "UNKNOWN_SOURCE_REVIEW_FAILED"))}\n`,
      );
      process.exitCode = 1;
    });
}
