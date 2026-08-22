import {
  bindCombinedPlanToExactSources,
  buildCombinedPostCopyEvidence,
  buildCombinedSevenBucketPlan,
  validateCombinedSevenBucketApproval,
  verifyAllSevenLiveSource,
} from "./storage-seven-bucket-orchestrator.mjs";
import {
  SEVEN_BUCKET_ACTIVATION,
  SEVEN_BUCKET_CONTRACT,
  validateZeroGrantPolicyEvidence,
  validateCombinedChangeManifest,
} from "./storage-seven-bucket-contract.mjs";
import {
  executeActivatedKnownSixCreateOnly,
  validateKnownSixTargetPreflight,
} from "./storage-copy-executor.mjs";
import { collectLiveTargetPreflight } from "./storage-live-inventory.mjs";
import { InCloudStoragePreflightClient } from "./storage-preflight-job.mjs";
import {
  FixedSeventhTargetReadClient,
  buildFixedAllSevenTargetPreflight,
  collectFixedSeventhTargetPreflight,
} from "./storage-fixed-seventh-target-collector.mjs";
import { performSeventhCreateOnlyCopy } from "./storage-seventh-quarantine-executor.mjs";
import {
  MAXIMUM_APPROVAL_BYTES,
  calculateSelfBoundDigest,
  canonicalJson,
  fail,
  requireExactKeys,
  requireIsoTimestamp,
  requireSafeText,
  requireSha256,
  sha256,
} from "./storage-live-common.mjs";

const REQUEST_KEYS = [
  "rawDetachedApproval",
  "rawChangeManifest",
  "rawCombinedPlan",
  "rawFreshAllSevenTargetPreflight",
  "reviewerPublicKeyPem",
  "planInputs",
  "createReadOnlyDependencies",
  "createWriteClients",
];

const PLAN_INPUT_KEYS = [
  "knownSource",
  "knownSourceFileDigestSha256",
  "seventhSource",
  "knownSixPlan",
  "knownSixPreflight",
  "knownSixPlanFileDigestSha256",
  "knownSixPreflightFileDigestSha256",
  "knownSixPreflightDigestSha256",
  "seventhPreflightFileDigestSha256",
  "seventhPreflightDigestSha256",
  "allSevenTargetPreflightFileDigestSha256",
  "seventhPreflightSafe",
  "seventhNamespaceObjectCount",
  "zeroGrantPolicyEvidence",
];

const FRESH_PREFLIGHT_KEYS = [
  "schemaVersion",
  "capturedAt",
  "project",
  "region",
  "knownSixPreflight",
  "seventhPreflight",
  "preflightDigestSha256",
];

const SEVENTH_PREFLIGHT_KEYS = [
  "schemaVersion", "capturedAt", "collectionStartedAt", "collectionCompletedAt",
  "collectionDurationMs", "project", "bucket", "namespace",
  "sourceFileDigestSha256", "sourceArtifactDigestSha256", "sourceContentSetDigestSha256",
  "sourceObjectCount", "sourceTotalBytes", "configurationDigestSha256", "iamDigestSha256",
  "tagBindingsDigestSha256", "denyPolicyDigestSha256", "runtimeReferenceDigestSha256",
  "namespaceObjectSetDigestSha256", "runtimeRoutingReferenceCount", "namespaceObjectCount",
  "namespaceTotalBytes", "configurationSafe", "bucketIamExact", "tagIsolationBound",
  "denyPolicyActive", "createOnly", "ifGenerationMatch", "overwriteAllowed", "deleteAllowed",
  "safeForCopy", "preflightDigestSha256",
];

const READ_ONLY_DEPENDENCY_KEYS = [
  "sourceClient",
  "policySnapshotProvider",
  "knownSixSourceRecords",
  "knownSixInheritedBindings",
];

const WRITE_CLIENT_KEYS = ["knownSixGcsClient", "seventhGcsClient"];
const FIXED_PLATFORM_FETCH = globalThis.fetch.bind(globalThis);

const TRUST_ANCHOR_KEYS = [
  "schemaVersion",
  "provisioned",
  "reviewerIdentity",
  "reviewerPublicKeySha256",
];

const assertNoDuplicateOrPrototypeJsonKeys = (text, code) => {
  let offset = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/.test(text[offset] || "")) offset += 1;
  };
  const stringToken = () => {
    const start = offset;
    if (text[offset] !== '"') fail(code, "A JSON string was malformed.");
    offset += 1;
    for (;;) {
      const character = text[offset];
      if (character === undefined || character.charCodeAt(0) <= 0x1f) {
        fail(code, "A JSON string was malformed.");
      }
      if (character === '"') {
        offset += 1;
        try { return JSON.parse(text.slice(start, offset)); } catch { fail(code, "A JSON string was malformed."); }
      }
      if (character === "\\") {
        offset += 1;
        if (text[offset] === "u") {
          if (!/^[a-fA-F0-9]{4}$/.test(text.slice(offset + 1, offset + 5))) {
            fail(code, "A JSON string escape was malformed.");
          }
          offset += 5;
          continue;
        }
        if (!/["\\/bfnrt]/.test(text[offset] || "")) fail(code, "A JSON string escape was malformed.");
      }
      offset += 1;
    }
  };
  const value = (depth = 0) => {
    if (depth > 128) fail(code, "The JSON nesting depth exceeded its bound.");
    whitespace();
    if (text[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set();
      if (text[offset] === "}") { offset += 1; return; }
      for (;;) {
        const key = stringToken();
        if (keys.has(key) || ["__proto__", "prototype", "constructor"].includes(key)) {
          fail(code, "A duplicate or prototype-like JSON key was rejected.");
        }
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") fail(code, "A JSON object separator was malformed.");
        offset += 1;
        value(depth + 1);
        whitespace();
        if (text[offset] === "}") { offset += 1; return; }
        if (text[offset] !== ",") fail(code, "A JSON object delimiter was malformed.");
        offset += 1;
        whitespace();
      }
    }
    if (text[offset] === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") { offset += 1; return; }
      for (;;) {
        value(depth + 1);
        whitespace();
        if (text[offset] === "]") { offset += 1; return; }
        if (text[offset] !== ",") fail(code, "A JSON array delimiter was malformed.");
        offset += 1;
      }
    }
    if (text[offset] === '"') { stringToken(); return; }
    const start = offset;
    while (offset < text.length && !/[\],}\t\n\r ]/.test(text[offset])) offset += 1;
    if (start === offset) fail(code, "A JSON value was malformed.");
    try { JSON.parse(text.slice(start, offset)); } catch { fail(code, "A JSON value was malformed."); }
  };
  value();
  whitespace();
  if (offset !== text.length) fail(code, "Trailing JSON data was rejected.");
};

// Provisioning this anchor requires a separate reviewed commit. The production entrypoint cannot
// accept an identity, key digest, clock, or prevalidated approval from its caller.
export const SEVEN_BUCKET_REVIEWER_TRUST_ANCHOR = Object.freeze({
  schemaVersion: "hushh-tech-storage-lane-7-reviewer-trust-anchor-v1",
  provisioned: false,
  reviewerIdentity: null,
  reviewerPublicKeySha256: null,
});

const rawJsonArtifact = (raw, maximumBytes, code, label) => {
  const bytes = typeof raw === "string"
    ? Buffer.from(raw, "utf8")
    : Buffer.isBuffer(raw)
      ? Buffer.from(raw)
      : raw instanceof Uint8Array
        ? Buffer.from(raw)
        : null;
  if (!bytes || bytes.length === 0 || bytes.length > maximumBytes || bytes.includes(0)) {
    fail(code, `${label} is not a bounded JSON artifact.`);
  }
  const text = bytes.toString("utf8");
  assertNoDuplicateOrPrototypeJsonKeys(text, code);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(code, `${label} is not valid JSON.`);
  }
  return { value, fileDigestSha256: sha256(bytes) };
};

const requireFreshTimestamp = (value, now, label) => {
  requireIsoTimestamp(value, "ALL_SEVEN_TARGET_PREFLIGHT_TIME_INVALID", label);
  const age = now - Date.parse(value);
  if (age < 0 || age > 300_000) {
    fail("ALL_SEVEN_TARGET_PREFLIGHT_STALE", "The all-seven target preflight must be at most five minutes old.");
  }
};

export const validateFreshAllSevenTargetPreflight = ({
  artifact,
  fileDigestSha256,
  plan,
  knownSource,
  now,
  bindingMode = "approved",
}) => {
  if (!new Set(["approved", "live"]).has(bindingMode)) {
    fail("ALL_SEVEN_TARGET_PREFLIGHT_MODE_INVALID", "The target preflight binding mode is invalid.");
  }
  requireExactKeys(artifact, FRESH_PREFLIGHT_KEYS, "ALL_SEVEN_TARGET_PREFLIGHT_SCHEMA", "fresh all-seven target preflight");
  if (
    artifact.schemaVersion !== "hushh-tech-storage-all-seven-target-preflight-v2" ||
    artifact.project !== "hushh-tech-uat" ||
    artifact.region !== "us-central1" ||
    artifact.preflightDigestSha256 !== calculateSelfBoundDigest(artifact, "preflightDigestSha256") ||
    (bindingMode === "approved" && fileDigestSha256 !== plan.allSevenTargetPreflightFileDigestSha256)
  ) {
    fail("ALL_SEVEN_TARGET_PREFLIGHT_BINDING_MISMATCH", "The fresh all-seven target preflight does not match the signed plan.");
  }
  requireFreshTimestamp(artifact.capturedAt, now, "all-seven target preflight capture time");
  const known = artifact.knownSixPreflight;
  validateKnownSixTargetPreflight(known, knownSource);
  if (
    known?.schemaVersion !== "gcs-storage-copy-preflight-v1" ||
    known.project !== "hushh-tech-uat" ||
    known.region !== "us-central1" ||
    known.bucketCount !== 6 ||
    !Array.isArray(known.buckets) || known.buckets.length !== 6 ||
    known.preflightDigestSha256 !== calculateSelfBoundDigest(known, "preflightDigestSha256") ||
    (bindingMode === "approved" && known.preflightDigestSha256 !== plan.knownSixPreflightDigestSha256) ||
    known.migrationWriterRoleExact !== true ||
    known.unmanagedObjectCount !== 0 || known.retainedHistoricalObjectCount !== 0 ||
    known.buckets.some((bucket) =>
      bucket.bucketConfigurationSafe !== true ||
      bucket.iamMatchesFrozenAllowlist !== true ||
      bucket.isolationSafe !== true ||
      bucket.inheritedAccessNeutralized !== true)
  ) {
    fail("KNOWN_SIX_FRESH_TARGET_PREFLIGHT_MISMATCH", "The fresh known-six target security proof changed.");
  }
  requireFreshTimestamp(known.collectedAt, now, "known-six target preflight time");

  const seventh = artifact.seventhPreflight;
  requireExactKeys(seventh, SEVENTH_PREFLIGHT_KEYS, "SEVENTH_FRESH_TARGET_PREFLIGHT_SCHEMA", "fresh seventh target preflight");
  for (const field of [
    "sourceFileDigestSha256", "sourceArtifactDigestSha256", "sourceContentSetDigestSha256",
    "configurationDigestSha256", "iamDigestSha256", "tagBindingsDigestSha256",
    "denyPolicyDigestSha256", "runtimeReferenceDigestSha256", "namespaceObjectSetDigestSha256",
    "preflightDigestSha256",
  ]) requireSha256(seventh[field], "SEVENTH_FRESH_TARGET_PREFLIGHT_DIGEST", field);
  if (
    seventh.schemaVersion !== "gcs-storage-quarantine-preflight-v2" ||
    seventh.project !== "hushh-tech-uat" ||
    seventh.bucket !== "hushh-tech-supabase-quarantine-uat" ||
    seventh.namespace !== SEVEN_BUCKET_CONTRACT.seventh.targetPrefix ||
    seventh.preflightDigestSha256 !== calculateSelfBoundDigest(seventh, "preflightDigestSha256") ||
    (bindingMode === "approved" && seventh.preflightDigestSha256 !== plan.seventhPreflightDigestSha256) ||
    seventh.sourceFileDigestSha256 !== plan.seventhSourceFileDigestSha256 ||
    seventh.sourceArtifactDigestSha256 !== plan.seventhSourceArtifactDigestSha256 ||
    seventh.sourceContentSetDigestSha256 !== plan.seventhSourceContentSetDigestSha256 ||
    seventh.sourceObjectCount !== 16 || seventh.sourceTotalBytes !== 1_463_542_970 ||
    seventh.configurationSafe !== true || seventh.bucketIamExact !== true ||
    seventh.tagIsolationBound !== true || seventh.denyPolicyActive !== true ||
    seventh.runtimeRoutingReferenceCount !== 0 || seventh.namespaceObjectCount !== 0 ||
    seventh.namespaceTotalBytes !== 0 || seventh.createOnly !== true ||
    seventh.namespaceObjectSetDigestSha256 !== sha256(canonicalJson([])) ||
    seventh.ifGenerationMatch !== 0 || seventh.overwriteAllowed !== false ||
    seventh.deleteAllowed !== false || seventh.safeForCopy !== true
  ) {
    fail("SEVENTH_FRESH_TARGET_PREFLIGHT_MISMATCH", "The fresh seventh target security proof changed.");
  }
  requireFreshTimestamp(seventh.capturedAt, now, "seventh target preflight time");
  requireIsoTimestamp(
    seventh.collectionStartedAt,
    "SEVENTH_FRESH_TARGET_PREFLIGHT_DURATION_INVALID",
    "seventh target collection start time",
  );
  requireIsoTimestamp(
    seventh.collectionCompletedAt,
    "SEVENTH_FRESH_TARGET_PREFLIGHT_DURATION_INVALID",
    "seventh target collection completion time",
  );
  const collectionDurationMs =
    Date.parse(seventh.collectionCompletedAt) - Date.parse(seventh.collectionStartedAt);
  if (
    seventh.collectionCompletedAt !== seventh.capturedAt ||
    !Number.isSafeInteger(seventh.collectionDurationMs) ||
    seventh.collectionDurationMs !== collectionDurationMs ||
    collectionDurationMs < 0 ||
    collectionDurationMs > 300_000
  ) {
    fail(
      "SEVENTH_FRESH_TARGET_PREFLIGHT_DURATION_INVALID",
      "The seventh target collection duration must be exact and at most five minutes.",
    );
  }
  const bindingDigest = sha256(canonicalJson({
    knownSixPreflightDigestSha256: known.preflightDigestSha256,
    seventhPreflightDigestSha256: seventh.preflightDigestSha256,
  }));
  if (
    bindingMode === "approved" &&
    bindingDigest !== plan.allSevenTargetPreflightBindingDigestSha256
  ) {
    fail("ALL_SEVEN_TARGET_PREFLIGHT_BINDING_MISMATCH", "The signed all-seven target binding changed.");
  }
  return artifact;
};

const semanticTargetPreflight = (artifact) => ({
  ...artifact,
  capturedAt: null,
  preflightDigestSha256: null,
  knownSixPreflight: {
    ...artifact.knownSixPreflight,
    collectedAt: null,
    preflightDigestSha256: null,
  },
  seventhPreflight: {
    ...artifact.seventhPreflight,
    capturedAt: null,
    collectionStartedAt: null,
    collectionCompletedAt: null,
    collectionDurationMs: null,
    preflightDigestSha256: null,
  },
});

const collectConcreteAllSevenTargetPreflight = async ({
  readDependencies,
  request,
  nowProvider,
}) => {
  if (
    !Array.isArray(readDependencies.knownSixSourceRecords) ||
    !Array.isArray(readDependencies.knownSixInheritedBindings)
  ) {
    fail(
      "FIXED_ALL_SEVEN_TARGET_COLLECTOR_REQUIRED",
      "Execution requires the checked-in fixed all-seven target collectors.",
    );
  }
  const knownSixTargetClient = new InCloudStoragePreflightClient({
    fetchImpl: FIXED_PLATFORM_FETCH,
    inheritedBindings: readDependencies.knownSixInheritedBindings,
  });
  const seventhTargetClient = new FixedSeventhTargetReadClient({
    fetchImpl: FIXED_PLATFORM_FETCH,
  });
  await knownSixTargetClient.initialize();
  const [knownSixPreflight, seventhPreflight] = await Promise.all([
    collectLiveTargetPreflight({
      gcsClient: knownSixTargetClient,
      sourceRecords: readDependencies.knownSixSourceRecords,
      collectedAt: new Date(nowProvider()).toISOString(),
    }),
    collectFixedSeventhTargetPreflight({
      client: seventhTargetClient,
      seventhSource: request.planInputs.seventhSource,
      now: nowProvider,
    }),
  ]);
  return buildFixedAllSevenTargetPreflight({
    knownSource: request.planInputs.knownSource,
    knownSixPreflight,
    seventhPreflight,
  }).raw;
};

export const assertLiveAllSevenTargetMatchesApproval = ({ approved, live }) => {
  if (canonicalJson(semanticTargetPreflight(live)) !== canonicalJson(semanticTargetPreflight(approved))) {
    fail(
      "ALL_SEVEN_TARGET_MUTATED_AFTER_APPROVAL",
      "The live all-seven target security or namespace proof changed after approval.",
    );
  }
  return live;
};

const validateTrustAnchor = (trustAnchor, reviewerPublicKeyPem) => {
  requireExactKeys(
    trustAnchor,
    TRUST_ANCHOR_KEYS,
    "SEVEN_BUCKET_TRUST_ANCHOR_SCHEMA",
    "Lane 7 reviewer trust anchor",
  );
  if (
    trustAnchor.schemaVersion !== "hushh-tech-storage-lane-7-reviewer-trust-anchor-v1" ||
    trustAnchor.provisioned !== true
  ) {
    fail(
      "SEVEN_BUCKET_TRUST_ANCHOR_UNPROVISIONED",
      "The Lane 7 reviewer trust anchor is not provisioned.",
    );
  }
  requireSafeText(
    trustAnchor.reviewerIdentity,
    "SEVEN_BUCKET_TRUST_ANCHOR_INVALID",
    "trusted reviewer identity",
    256,
  );
  requireSha256(
    trustAnchor.reviewerPublicKeySha256,
    "SEVEN_BUCKET_TRUST_ANCHOR_INVALID",
    "trusted reviewer public-key digest",
  );
  if (
    typeof reviewerPublicKeyPem !== "string" ||
    sha256(reviewerPublicKeyPem) !== trustAnchor.reviewerPublicKeySha256
  ) {
    fail(
      "SEVEN_BUCKET_TRUSTED_REVIEWER_KEY_MISMATCH",
      "The detached approval key does not match the checked-in reviewer trust anchor.",
    );
  }
  return trustAnchor;
};

// This lower validator accepts an explicit anchor only so tests can exercise the provisioned
// state while the checked-in production anchor remains deliberately unprovisioned.
export const validateDetachedSevenBucketExecution = ({
  request,
  trustAnchor,
  now = Date.now(),
}) => {
  if (
    request &&
    Object.prototype.hasOwnProperty.call(request, "approvalValidation")
  ) {
    fail(
      "CALLER_APPROVAL_VALIDATION_FORBIDDEN",
      "Caller-supplied approval validation is forbidden.",
    );
  }
  requireExactKeys(
    request,
    REQUEST_KEYS,
    "SEVEN_BUCKET_EXECUTION_REQUEST_SCHEMA",
    "seven-bucket execution request",
  );
  requireExactKeys(
    request.planInputs,
    PLAN_INPUT_KEYS,
    "SEVEN_BUCKET_PLAN_INPUT_SCHEMA",
    "seven-bucket plan inputs",
  );
  validateTrustAnchor(trustAnchor, request.reviewerPublicKeyPem);

  const approvalArtifact = rawJsonArtifact(
    request.rawDetachedApproval,
    MAXIMUM_APPROVAL_BYTES,
    "COMBINED_APPROVAL_JSON_INVALID",
    "The detached approval",
  );
  const manifestArtifact = rawJsonArtifact(
    request.rawChangeManifest,
    1_048_576,
    "COMBINED_CHANGE_MANIFEST_JSON_INVALID",
    "The combined change manifest",
  );
  const planArtifact = rawJsonArtifact(
    request.rawCombinedPlan,
    8_388_608,
    "COMBINED_PLAN_JSON_INVALID",
    "The combined plan",
  );
  const freshTargetArtifact = rawJsonArtifact(
    request.rawFreshAllSevenTargetPreflight,
    16_777_216,
    "ALL_SEVEN_TARGET_PREFLIGHT_JSON_INVALID",
    "The fresh all-seven target preflight",
  );

  if (approvalArtifact.value?.reviewerIdentity !== trustAnchor.reviewerIdentity) {
    fail(
      "SEVEN_BUCKET_TRUSTED_REVIEWER_IDENTITY_MISMATCH",
      "The detached approval reviewer does not match the checked-in trust anchor.",
    );
  }

  const changeManifest = validateCombinedChangeManifest(manifestArtifact.value);
  const recomputedManifestDigestSha256 = calculateSelfBoundDigest(
    changeManifest,
    "manifestDigestSha256",
  );
  if (recomputedManifestDigestSha256 !== changeManifest.manifestDigestSha256) {
    fail(
      "COMBINED_CHANGE_MANIFEST_RECOMPUTE_MISMATCH",
      "The combined change manifest did not survive independent recomputation.",
    );
  }

  const recomputedPlan = buildCombinedSevenBucketPlan({
    activation: SEVEN_BUCKET_ACTIVATION,
    changeManifest,
    changeManifestFileDigestSha256: manifestArtifact.fileDigestSha256,
    ...request.planInputs,
    reviewedCommitSha: changeManifest.reviewedCommitSha,
  });
  if (canonicalJson(planArtifact.value) !== canonicalJson(recomputedPlan)) {
    fail(
      "COMBINED_PLAN_RECOMPUTE_MISMATCH",
      "The supplied combined plan is not the exact independently recomputed plan.",
    );
  }

  const approvalValidation = validateCombinedSevenBucketApproval({
    approval: approvalArtifact.value,
    approvalFileDigestSha256: approvalArtifact.fileDigestSha256,
    plan: recomputedPlan,
    planFileDigestSha256: planArtifact.fileDigestSha256,
    zeroGrantPolicyEvidence: request.planInputs.zeroGrantPolicyEvidence,
    reviewerPublicKeyPem: request.reviewerPublicKeyPem,
    now,
  });
  const boundSources = bindCombinedPlanToExactSources({
    plan: recomputedPlan,
    knownSource: request.planInputs.knownSource,
    knownSourceFileDigestSha256: request.planInputs.knownSourceFileDigestSha256,
    knownSixPlan: request.planInputs.knownSixPlan,
    seventhSource: request.planInputs.seventhSource,
  });
  const freshTargetPreflight = validateFreshAllSevenTargetPreflight({
    artifact: freshTargetArtifact.value,
    fileDigestSha256: freshTargetArtifact.fileDigestSha256,
    plan: recomputedPlan,
    knownSource: request.planInputs.knownSource,
    now,
  });

  return {
    approval: approvalArtifact.value,
    approvalValidation,
    changeManifest,
    changeManifestFileDigestSha256: manifestArtifact.fileDigestSha256,
    plan: recomputedPlan,
    planFileDigestSha256: planArtifact.fileDigestSha256,
    boundSources,
    freshTargetPreflight,
  };
};

const executeSevenBucketCore = async ({
  request,
  trustAnchor,
  nowProvider,
  verifyLiveSource = verifyAllSevenLiveSource,
  collectLiveAllSevenTargetPreflight = collectConcreteAllSevenTargetPreflight,
}) => {
  if (
    request &&
    Object.prototype.hasOwnProperty.call(request, "approvalValidation")
  ) {
    fail(
      "CALLER_APPROVAL_VALIDATION_FORBIDDEN",
      "Caller-supplied approval validation is forbidden.",
    );
  }
  const prepared = validateDetachedSevenBucketExecution({
    request,
    trustAnchor,
    now: nowProvider(),
  });
  if (typeof request.createReadOnlyDependencies !== "function") {
    fail(
      "COMBINED_READ_DEPENDENCY_FACTORY_REQUIRED",
      "The combined execution requires a read-only dependency factory.",
    );
  }
  const readDependencies = await request.createReadOnlyDependencies({
    plan: prepared.plan,
    boundSources: prepared.boundSources,
  });
  requireExactKeys(
    readDependencies,
    READ_ONLY_DEPENDENCY_KEYS,
    "COMBINED_READ_DEPENDENCY_SCHEMA",
    "combined six-plus-one read-only dependencies",
  );
  if (
    typeof readDependencies.policySnapshotProvider !== "function"
  ) {
    fail(
      "COMBINED_READ_DEPENDENCY_SCHEMA",
      "The combined read-only dependencies are incomplete.",
    );
  }
  const policyBefore = validateZeroGrantPolicyEvidence(
    await readDependencies.policySnapshotProvider("before"),
  );
  if (
    policyBefore.projectPolicyCanonicalDigestSha256 !== prepared.plan.projectPolicyCanonicalDigestSha256 ||
    policyBefore.migrationServiceAccountPolicyCanonicalDigestSha256 !==
      prepared.plan.migrationServiceAccountPolicyCanonicalDigestSha256
  ) {
    fail("COMBINED_POLICY_APPROVAL_MISMATCH", "The fresh zero-grant policy evidence changed after approval.");
  }
  const sourceBefore = await verifyLiveSource({
    knownSource: request.planInputs.knownSource,
    seventhSource: request.planInputs.seventhSource,
    sourceClient: readDependencies.sourceClient,
  });
  const liveTargetRaw = await collectLiveAllSevenTargetPreflight({
    readDependencies,
    request,
    nowProvider,
  });
  const liveTargetArtifact = rawJsonArtifact(
    liveTargetRaw,
    16_777_216,
    "LIVE_ALL_SEVEN_TARGET_PREFLIGHT_JSON_INVALID",
    "The live all-seven target preflight",
  );
  const liveTargetPreflight = validateFreshAllSevenTargetPreflight({
    artifact: liveTargetArtifact.value,
    fileDigestSha256: liveTargetArtifact.fileDigestSha256,
    plan: prepared.plan,
    knownSource: request.planInputs.knownSource,
    now: nowProvider(),
    bindingMode: "live",
  });
  assertLiveAllSevenTargetMatchesApproval({
    approved: prepared.freshTargetPreflight,
    live: liveTargetPreflight,
  });
  if (typeof request.createWriteClients !== "function") {
    fail(
      "COMBINED_WRITE_CLIENT_FACTORY_REQUIRED",
      "The combined execution requires a delayed write-client factory.",
    );
  }
  const writeClients = await request.createWriteClients({
    plan: prepared.plan,
    boundSources: prepared.boundSources,
    liveTargetPreflight,
  });
  requireExactKeys(
    writeClients,
    WRITE_CLIENT_KEYS,
    "COMBINED_WRITE_CLIENT_SCHEMA",
    "combined six-plus-one write clients",
  );
  const knownSixResult = await executeActivatedKnownSixCreateOnly({
    activation: SEVEN_BUCKET_ACTIVATION,
    approvalValidation: prepared.approvalValidation,
    combinedApproval: prepared.approval,
    combinedPlan: prepared.plan,
    source: request.planInputs.knownSource,
    sourceFileDigestSha256: request.planInputs.knownSourceFileDigestSha256,
    preflight: request.planInputs.knownSixPreflight,
    preflightFileDigestSha256: request.planInputs.knownSixPreflightFileDigestSha256,
    plan: request.planInputs.knownSixPlan,
    planFileDigestSha256: request.planInputs.knownSixPlanFileDigestSha256,
    sourceClient: readDependencies.sourceClient,
    gcsClient: writeClients.knownSixGcsClient,
  });
  const seventhResult = await performSeventhCreateOnlyCopy({
    seventhSource: request.planInputs.seventhSource,
    seventhActions: prepared.plan.seventhActions,
    sourceClient: readDependencies.sourceClient,
    gcsClient: writeClients.seventhGcsClient,
  });
  const sourceAfter = await verifyLiveSource({
    knownSource: request.planInputs.knownSource,
    seventhSource: request.planInputs.seventhSource,
    sourceClient: readDependencies.sourceClient,
  });
  const policyAfter = validateZeroGrantPolicyEvidence(
    await readDependencies.policySnapshotProvider("after"),
  );
  return buildCombinedPostCopyEvidence({
    plan: prepared.plan,
    approval: prepared.approval,
    sourceBefore,
    sourceAfter,
    knownSixResult,
    seventhResult,
    policyBefore,
    policyAfter,
  });
};

export const executeSevenBucketWithDetachedApproval = async (request) =>
  executeSevenBucketCore({
    request,
    trustAnchor: SEVEN_BUCKET_REVIEWER_TRUST_ANCHOR,
    nowProvider: Date.now,
  });

export const __testing = Object.freeze({
  executeSevenBucketWithTrustAnchor: async ({
    request,
    trustAnchor,
    now,
    verifyLiveSource,
    collectLiveAllSevenTargetPreflight,
  }) => {
    if (process.env.NODE_ENV !== "test") {
      fail(
        "SEVEN_BUCKET_TEST_HARNESS_FORBIDDEN",
        "The injectable seven-bucket execution harness is test-only.",
      );
    }
    return executeSevenBucketCore({
      request,
      trustAnchor,
      nowProvider: () => now,
      verifyLiveSource,
      collectLiveAllSevenTargetPreflight,
    });
  },
});
