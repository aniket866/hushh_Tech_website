import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  validateLiveFunctionBundleEvidence,
  validateManifest,
} from "../../ci/check-supabase-retirement-manifest.mjs";
import { validateCurrentFunctionBundleEvidence } from "../../ci/check-supabase-current-function-bundle-evidence.mjs";
import { validateFunctionTrafficEvidence } from "../../ci/check-supabase-function-traffic-evidence.mjs";

export const CONTRACT = Object.freeze({
  schema_version: 1,
  classifier_id: "hushh-tech-supabase-retirement-candidate-classifier",
  mode: "MACHINE_ONLY_DEFAULT_OFF",
  required_flag: "--machine-evaluate",
  base_commit: "9ffd789b236165bcd2c0559411fe02c6a1d2b719",
  base_tree: "6a0310560dec5a4b7dcdc6401b1504c37acc93be",
  expected_functions: 112,
  evaluation_time_utc: "2026-08-21T18:03:38.344Z",
  maximum_traffic_lag_hours: 24,
  caller_non_runtime_exclusions: Object.freeze([
    "scripts/ci/generate-no-hybrid-route-inventory.mjs",
  ]),
  inputs: Object.freeze({
    manifest: Object.freeze({
      path: "migration/manifests/supabase-retirement.v1.json",
      sha256:
        "5047e3140bce74bf1a8702208488ecc3867467b15dc7318272145888e83db3d5",
    }),
    historical_source: Object.freeze({
      path: "migration/evidence/supabase-live-function-bundles.v1.json",
      sha256:
        "3ae1b5b8225347cee63cb8e42fdfe744e8f905ee7b3a9d2c4eccee3ae2c81bd4",
    }),
    current_source: Object.freeze({
      path: "migration/evidence/supabase-current-live-function-bundles.v2.json",
      sha256:
        "54d9535f80d3954902da8f99cf84c46609cd7d971d6344c16704bad5e0963703",
    }),
    traffic: Object.freeze({
      path: "migration/evidence/supabase-function-traffic-30d.v1.json",
      sha256:
        "5db78b99f880423c88528817ca422ab862aa1a42f93699e37b0e4ce03fc90ac0",
    }),
    runtime_policy: Object.freeze({
      path: "scripts/ci/no-hybrid-runtime-policy.json",
      sha256:
        "7e6240c341c3a388e63e43e5d7459de722f339b19a1610d1216ac73a40ccbb4f",
    }),
    retirement_checker: Object.freeze({
      path: "scripts/ci/check-supabase-retirement-manifest.mjs",
      sha256:
        "5e2cc953debe0c54cfbe69fc2fa563548475c7202e1e362440072f7ecbe01457",
    }),
    current_source_checker: Object.freeze({
      path: "scripts/ci/check-supabase-current-function-bundle-evidence.mjs",
      sha256:
        "5b48ac2bf58f6ad36acd183aad177ab53acf8f86dafdd9f956f231dcc0515e3f",
    }),
    traffic_checker: Object.freeze({
      path: "scripts/ci/check-supabase-function-traffic-evidence.mjs",
      sha256:
        "fd4171160826c0b157bd0a066b3043b61c30069a5d28f34033a85e1542dfe2a4",
    }),
    historical_generator: Object.freeze({
      path: "scripts/ci/generate-supabase-live-function-bundle-evidence.mjs",
      sha256:
        "35eb33b00a1dd79ef8da6ee35cd5480123dc037c1c444e47e4eb78f54a07ac43",
    }),
  }),
  caller_corpus_sha256:
    "b6961373852d774b4b490785d751c22ec25fce48ae1e7d3fe7ca56b7dc768bf6",
  caller_graph_sha256:
    "ab8087f28e134b73c1d9b5977ae92055c7c581be0dee409faec3a18bbd0d7a29",
});

const MUST_PORT = "MUST_PORT";
const BLOCKED = "BLOCKED";
const ELIGIBLE = "ELIGIBLE_FOR_OWNER_AND_LEGAL_REVIEW";
const APPROVALS = Object.freeze({
  owner: "REQUIRED_NOT_GRANTED",
  legal: "REQUIRED_NOT_GRANTED",
});
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".dart",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".kt",
  ".kts",
  ".mjs",
  ".py",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const compareUtf8 = (left, right) =>
  Buffer.compare(
    Buffer.from(String(left), "utf8"),
    Buffer.from(String(right), "utf8"),
  );

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareUtf8)
      .map((key) => [key, stableValue(value[key])]),
  );
};

export const stableJson = (value) => JSON.stringify(stableValue(value));
export const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

function git(root, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: root,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readGitObject(root, relativePath) {
  return git(root, ["show", `${CONTRACT.base_commit}:${relativePath}`], null);
}

function assertDigest(label, bytes, expected) {
  const observed = sha256(bytes);
  if (observed !== expected) {
    throw new Error(
      `${label} digest mismatch: expected ${expected}, observed ${observed}.`,
    );
  }
  return observed;
}

function uniqueIndex(entries, label, slugOf = (entry) => entry.slug) {
  if (!Array.isArray(entries)) throw new Error(`${label} must be an array.`);
  const index = new Map();
  for (const entry of entries) {
    const slug = slugOf(entry);
    if (typeof slug !== "string" || !slug || index.has(slug)) {
      throw new Error(`${label} contains a missing or duplicate slug.`);
    }
    index.set(slug, entry);
  }
  return index;
}

function exactSlugSet(expected, actual, label) {
  const left = [...expected].sort(compareUtf8);
  const right = [...actual].sort(compareUtf8);
  if (stableJson(left) !== stableJson(right)) {
    throw new Error(
      `${label} does not match the exact frozen 112-function registry.`,
    );
  }
}

function isWithin(candidate, prefix) {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function runtimeFilesAtBase(root, policy) {
  const sourceRoots = policy.source_surfaces.map((entry) => entry.path);
  const excluded = [
    ...policy.generated_artifact_roots,
    ...policy.classified_non_runtime.map((entry) => entry.path),
    ...CONTRACT.caller_non_runtime_exclusions,
  ];
  const output = git(root, [
    "ls-tree",
    "-r",
    CONTRACT.base_commit,
    "--",
    ...sourceRoots,
  ]);
  const records = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\w+)\s+([a-f0-9]+)\t(.+)$/.exec(line);
      if (!match) throw new Error(`Unexpected git tree record: ${line}`);
      return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
    })
    .filter((entry) => entry.type === "blob")
    .filter((entry) => !excluded.some((prefix) => isWithin(entry.path, prefix)))
    .filter((entry) =>
      SOURCE_EXTENSIONS.has(path.extname(entry.path).toLowerCase()),
    )
    .sort((left, right) => compareUtf8(left.path, right.path));
  return records;
}

function lineNumberAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function addUnique(target, value) {
  const key = stableJson(value);
  if (!target.some((entry) => stableJson(entry) === key)) target.push(value);
}

function scanCallerFile({ file, source, slugSet, callers, unresolved }) {
  const staticPath =
    /\/functions\/v1\/([a-z0-9][a-z0-9-]*)(?=[/?#`'"\s)\]}]|$)/giu;
  for (const match of source.matchAll(staticPath)) {
    const slug = match[1].toLowerCase();
    if (!slugSet.has(slug)) continue;
    addUnique(callers.get(slug), {
      path: file.path,
      line: lineNumberAt(source, match.index),
      kind: "STATIC_FUNCTION_ROUTE",
    });
  }

  const staticInvoke =
    /\.functions\s*\.invoke\s*\(\s*([`'"])([a-z0-9][a-z0-9-]*)\1/giu;
  for (const match of source.matchAll(staticInvoke)) {
    const slug = match[2].toLowerCase();
    if (!slugSet.has(slug)) continue;
    addUnique(callers.get(slug), {
      path: file.path,
      line: lineNumberAt(source, match.index),
      kind: "STATIC_SDK_INVOKE",
    });
  }

  const dynamicPatterns = [
    { kind: "DYNAMIC_FUNCTION_ROUTE", regex: /\/functions\/v1\/\s*\$\{/giu },
    {
      kind: "DYNAMIC_FUNCTION_ROUTE_CONCATENATION",
      regex: /\/functions\/v1\/?[`'"]\s*\+/giu,
    },
    {
      kind: "DYNAMIC_SDK_INVOKE",
      regex:
        /\.functions\s*\.invoke\s*\(\s*(?![`'"][a-z0-9][a-z0-9-]*[`'"])/giu,
    },
  ];
  for (const pattern of dynamicPatterns) {
    for (const match of source.matchAll(pattern.regex)) {
      addUnique(unresolved, {
        path: file.path,
        line: lineNumberAt(source, match.index),
        kind: pattern.kind,
        expression_sha256: sha256(source.slice(match.index, match.index + 160)),
      });
    }
  }
}

function positiveSurfaceFlags(registryEntry, reachableCallers) {
  const text = [
    registryEntry.source.slug,
    registryEntry.auth_mode,
    registryEntry.owner_group,
    registryEntry.gcp_owner,
    registryEntry.migration_method,
    ...reachableCallers.map((entry) => entry.path),
  ]
    .join(" ")
    .toLowerCase();
  return {
    webhook: /webhook|signed[_-]callback/.test(text),
    schedule: /schedule|scheduler|cron|periodic/.test(text),
    admin: /(^|[^a-z])admin([^a-z]|$)/.test(text),
  };
}

export function buildPinnedCallerGraph({ root, policy, registryEntries }) {
  const files = runtimeFilesAtBase(root, policy);
  const slugs = registryEntries.map((entry) => entry.source.slug);
  const slugSet = new Set(slugs);
  const callers = new Map(slugs.map((slug) => [slug, []]));
  const unresolved = [];
  for (const file of files) {
    const source = readGitObject(root, file.path).toString("utf8");
    scanCallerFile({ file, source, slugSet, callers, unresolved });
  }
  for (const values of callers.values()) {
    values.sort((left, right) =>
      compareUtf8(
        `${left.path}:${left.line}:${left.kind}`,
        `${right.path}:${right.line}:${right.kind}`,
      ),
    );
  }
  unresolved.sort((left, right) =>
    compareUtf8(
      `${left.path}:${left.line}:${left.kind}`,
      `${right.path}:${right.line}:${right.kind}`,
    ),
  );
  const corpus = files.map(({ mode, oid, path: filePath }) => ({
    mode,
    oid,
    path: filePath,
  }));
  const entries = registryEntries
    .map((entry) => {
      const slug = entry.source.slug;
      const reachableCallers = callers.get(slug);
      const surfaceFlags = positiveSurfaceFlags(entry, reachableCallers);
      return {
        slug,
        reachable_callers: reachableCallers,
        unresolved_dynamic_callers: [],
        resolution_status:
          unresolved.length === 0 ? "COMPLETE" : "INCOMPLETE_DYNAMIC_CALLERS",
        surface_flags: surfaceFlags,
        surface_analysis_status: Object.values(surfaceFlags).some(Boolean)
          ? "POSITIVE_MATCH"
          : "INCOMPLETE_NO_NEGATIVE_PROOF",
        side_effect_status: "UNKNOWN_NO_AUTHORITATIVE_SEMANTIC_EVIDENCE",
        side_effects: [],
      };
    })
    .sort((left, right) => compareUtf8(left.slug, right.slug));
  const graph = {
    schema_version: 1,
    base_commit: CONTRACT.base_commit,
    runtime_policy_sha256: CONTRACT.inputs.runtime_policy.sha256,
    corpus_sha256: sha256(stableJson(corpus)),
    resolution_status:
      unresolved.length === 0 ? "COMPLETE" : "INCOMPLETE_DYNAMIC_CALLERS",
    unresolved_dynamic_callers: unresolved,
    entries,
  };
  return {
    corpus,
    graph,
    corpus_sha256: graph.corpus_sha256,
    graph_sha256: sha256(stableJson(graph)),
  };
}

export function deriveGlobalEvidenceBlockers({
  currentEvidence,
  trafficEvidence,
  currentValidation,
  trafficValidation,
}) {
  const blockers = [];
  if (!currentValidation.valid)
    blockers.push("CURRENT_SOURCE_EVIDENCE_INVALID");
  if (!trafficValidation.valid) blockers.push("TRAFFIC_EVIDENCE_INVALID");
  const assessment = currentEvidence.cutover_assessment ?? {};
  if (assessment.status !== "CUTOVER_READY_EXACT")
    blockers.push("SOURCE_CAPTURE_NOT_STABLE");
  if (assessment.metadata_end_check_status !== "PASSED_EXACT") {
    blockers.push("SOURCE_END_METADATA_CHECK_NOT_PASSED");
  }
  if (assessment.bundle_to_metadata_version_binding_status !== "PROVEN_EXACT") {
    blockers.push("SOURCE_BUNDLE_VERSION_BINDING_NOT_PROVEN");
  }
  if (
    assessment.source_revision_status !== "PROVEN" ||
    !/^[a-f0-9]{40}$/.test(assessment.source_revision ?? "")
  ) {
    blockers.push("SOURCE_REVISION_NOT_PROVEN");
  }
  if (
    trafficEvidence.unattributed_traffic_status !==
    "ZERO_UNATTRIBUTED_TRAFFIC_OBSERVED"
  ) {
    blockers.push("UNATTRIBUTED_TRAFFIC_NOT_ZERO");
  }
  const windowEnd = Date.parse(trafficEvidence.capture?.window_end_utc ?? "");
  const evaluationTime = Date.parse(CONTRACT.evaluation_time_utc);
  const lag = evaluationTime - windowEnd;
  if (
    !Number.isFinite(windowEnd) ||
    lag < 0 ||
    lag > CONTRACT.maximum_traffic_lag_hours * 60 * 60 * 1000
  ) {
    blockers.push("TRAFFIC_WINDOW_STALE_OR_FUTURE");
  }
  return [...new Set(blockers)].sort(compareUtf8);
}

function pushIf(target, condition, code) {
  if (condition) target.push(code);
}

export function classifyCandidateEntry({
  registryEntry,
  currentEntry,
  trafficEntry,
  callerEntry,
  globalBlockers = [],
}) {
  const slug = registryEntry?.source?.slug ?? null;
  if (
    !slug ||
    currentEntry?.slug !== slug ||
    trafficEntry?.slug !== slug ||
    callerEntry?.slug !== slug
  ) {
    throw new Error(
      "Candidate entry inputs must bind to the same non-empty slug.",
    );
  }
  const trafficCount = trafficEntry.request_count;
  const reachableCallerSetValid = Array.isArray(callerEntry.reachable_callers);
  const reachableCallers = reachableCallerSetValid
    ? callerEntry.reachable_callers
    : [];
  const mustPortReasons = [];
  if (Number.isInteger(trafficCount) && trafficCount > 0) {
    mustPortReasons.push("ACTIVE_30_DAY_TRAFFIC");
  }
  if (reachableCallers.length > 0)
    mustPortReasons.push("REACHABLE_CALLER_PRESENT");
  if (mustPortReasons.length > 0) {
    return {
      slug,
      classification: MUST_PORT,
      reason_codes: mustPortReasons,
      traffic_request_count: trafficCount,
      reachable_callers: reachableCallers,
      approvals: APPROVALS,
      retirement_authorized: false,
    };
  }

  const blockers = [...globalBlockers];
  pushIf(blockers, trafficCount !== 0, "TRAFFIC_COUNT_NOT_PROVEN_ZERO");
  pushIf(
    blockers,
    trafficEntry.terminal_traffic_status !== "ZERO_TRAFFIC_OBSERVED",
    "ZERO_TRAFFIC_STATUS_NOT_PROVEN",
  );
  pushIf(
    blockers,
    !Array.isArray(trafficEntry.nonzero_utc_buckets) ||
      trafficEntry.nonzero_utc_buckets.length !== 0,
    "ZERO_TRAFFIC_BUCKETS_NOT_PROVEN",
  );
  pushIf(
    blockers,
    trafficEntry.deployment_manifest_match_status !== "EXACT_MANIFEST_MATCH",
    "TRAFFIC_DEPLOYMENT_SOURCE_DRIFT",
  );
  pushIf(
    blockers,
    currentEntry.capture_status !== "EXTRACTED",
    "CURRENT_SOURCE_CAPTURE_INCOMPLETE",
  );
  pushIf(
    blockers,
    currentEntry.current_version !== registryEntry.source.version ||
      currentEntry.manifest_version !== registryEntry.source.version,
    "CURRENT_SOURCE_VERSION_DRIFT",
  );
  pushIf(
    blockers,
    callerEntry.resolution_status !== "COMPLETE",
    "CALLER_GRAPH_INCOMPLETE",
  );
  pushIf(blockers, !reachableCallerSetValid, "REACHABLE_CALLER_SET_INVALID");
  pushIf(
    blockers,
    !Array.isArray(callerEntry.unresolved_dynamic_callers) ||
      callerEntry.unresolved_dynamic_callers.length > 0,
    "DYNAMIC_CALLER_UNRESOLVED",
  );
  pushIf(
    blockers,
    callerEntry.surface_analysis_status !== "COMPLETE",
    "SURFACE_ANALYSIS_INCOMPLETE",
  );
  pushIf(
    blockers,
    callerEntry.surface_flags?.webhook === true,
    "WEBHOOK_SURFACE_PRESENT",
  );
  pushIf(
    blockers,
    typeof callerEntry.surface_flags?.webhook !== "boolean",
    "WEBHOOK_ABSENCE_NOT_PROVEN",
  );
  pushIf(
    blockers,
    callerEntry.surface_flags?.schedule === true,
    "SCHEDULE_SURFACE_PRESENT",
  );
  pushIf(
    blockers,
    typeof callerEntry.surface_flags?.schedule !== "boolean",
    "SCHEDULE_ABSENCE_NOT_PROVEN",
  );
  pushIf(
    blockers,
    callerEntry.surface_flags?.admin === true,
    "ADMIN_SURFACE_PRESENT",
  );
  pushIf(
    blockers,
    typeof callerEntry.surface_flags?.admin !== "boolean",
    "ADMIN_ABSENCE_NOT_PROVEN",
  );
  pushIf(
    blockers,
    callerEntry.side_effect_status !== "NONE",
    "SIDE_EFFECT_STATUS_NOT_NONE",
  );
  pushIf(
    blockers,
    !Array.isArray(callerEntry.side_effects) ||
      callerEntry.side_effects.length > 0,
    "SIDE_EFFECT_PRESENT",
  );
  pushIf(
    blockers,
    registryEntry.migration_state !== "INVENTORY_FROZEN",
    "REGISTRY_STATE_NOT_FROZEN",
  );

  const reasonCodes = [...new Set(blockers)].sort(compareUtf8);
  return {
    slug,
    classification: reasonCodes.length === 0 ? ELIGIBLE : BLOCKED,
    reason_codes: reasonCodes,
    traffic_request_count: trafficCount,
    reachable_callers: reachableCallers,
    approvals: APPROVALS,
    retirement_authorized: false,
  };
}

export function verifyPinnedBytes(inputBytes) {
  for (const [name, pin] of Object.entries(CONTRACT.inputs)) {
    if (!Buffer.isBuffer(inputBytes[name]))
      throw new Error(`Missing pinned bytes for ${name}.`);
    assertDigest(name, inputBytes[name], pin.sha256);
  }
  return true;
}

export function verifyPinnedCallerGraph(callerGraphResult) {
  const observedCorpusDigest = sha256(stableJson(callerGraphResult.corpus));
  const observedGraphDigest = sha256(stableJson(callerGraphResult.graph));
  if (
    observedCorpusDigest !== callerGraphResult.corpus_sha256 ||
    observedCorpusDigest !== CONTRACT.caller_corpus_sha256 ||
    callerGraphResult.graph?.corpus_sha256 !== observedCorpusDigest
  ) {
    throw new Error("Pinned caller corpus digest mismatch.");
  }
  if (
    observedGraphDigest !== callerGraphResult.graph_sha256 ||
    observedGraphDigest !== CONTRACT.caller_graph_sha256
  ) {
    throw new Error("Pinned caller graph digest mismatch.");
  }
  return true;
}

export function classifyPinnedInputs({ inputBytes, callerGraphResult }) {
  verifyPinnedBytes(inputBytes);
  verifyPinnedCallerGraph(callerGraphResult);
  const manifest = JSON.parse(inputBytes.manifest.toString("utf8"));
  const historicalEvidence = JSON.parse(
    inputBytes.historical_source.toString("utf8"),
  );
  const currentEvidence = JSON.parse(
    inputBytes.current_source.toString("utf8"),
  );
  const trafficEvidence = JSON.parse(inputBytes.traffic.toString("utf8"));

  const manifestValidation = validateManifest(manifest);
  const historicalValidation = validateLiveFunctionBundleEvidence(
    manifest,
    historicalEvidence,
  );
  const currentValidation = validateCurrentFunctionBundleEvidence({
    manifest,
    historicalEvidence,
    evidence: currentEvidence,
    manifestBytes: inputBytes.manifest,
    historicalEvidenceBytes: inputBytes.historical_source,
    canonicalCheckerBytes: inputBytes.retirement_checker,
    historicalGeneratorBytes: inputBytes.historical_generator,
  });
  const trafficValidation = validateFunctionTrafficEvidence(
    manifest,
    historicalEvidence,
    trafficEvidence,
  );
  const validationErrors = [
    ...(manifestValidation.errors ?? []),
    ...(historicalValidation.errors ?? []),
    ...(currentValidation.errors ?? []),
    ...(trafficValidation.errors ?? []),
  ];
  if (validationErrors.length > 0) {
    throw new Error(
      `Authoritative evidence validation failed: ${validationErrors.join(" | ")}`,
    );
  }

  const registryEntries = manifest.functions;
  if (registryEntries.length !== CONTRACT.expected_functions) {
    throw new Error(
      `Expected ${CONTRACT.expected_functions} frozen functions.`,
    );
  }
  const registrySlugs = registryEntries.map((entry) => entry.source.slug);
  const currentIndex = uniqueIndex(
    currentEvidence.entries,
    "current source evidence",
  );
  const trafficIndex = uniqueIndex(trafficEvidence.entries, "traffic evidence");
  const callerIndex = uniqueIndex(
    callerGraphResult.graph.entries,
    "caller graph",
  );
  exactSlugSet(registrySlugs, currentIndex.keys(), "Current source evidence");
  exactSlugSet(registrySlugs, trafficIndex.keys(), "Traffic evidence");
  exactSlugSet(registrySlugs, callerIndex.keys(), "Caller graph");

  const globalBlockers = deriveGlobalEvidenceBlockers({
    currentEvidence,
    trafficEvidence,
    currentValidation,
    trafficValidation,
  });
  if (callerGraphResult.graph.resolution_status !== "COMPLETE") {
    globalBlockers.push("CALLER_GRAPH_GLOBAL_INCOMPLETE");
  }
  const entries = registryEntries
    .map((registryEntry) =>
      classifyCandidateEntry({
        registryEntry,
        currentEntry: currentIndex.get(registryEntry.source.slug),
        trafficEntry: trafficIndex.get(registryEntry.source.slug),
        callerEntry: callerIndex.get(registryEntry.source.slug),
        globalBlockers,
      }),
    )
    .sort((left, right) => compareUtf8(left.slug, right.slug));
  const counts = Object.fromEntries(
    [MUST_PORT, BLOCKED, ELIGIBLE].map((classification) => [
      classification,
      entries.filter((entry) => entry.classification === classification).length,
    ]),
  );
  return {
    schema_version: CONTRACT.schema_version,
    classifier_id: CONTRACT.classifier_id,
    mode: CONTRACT.mode,
    state: "EVALUATED_NO_ACTION",
    base_commit: CONTRACT.base_commit,
    base_tree: CONTRACT.base_tree,
    evaluation_time_utc: CONTRACT.evaluation_time_utc,
    input_pins: Object.fromEntries(
      Object.entries(CONTRACT.inputs).map(([name, pin]) => [
        name,
        { path: pin.path, sha256: pin.sha256 },
      ]),
    ),
    caller_graph: {
      corpus_sha256: callerGraphResult.corpus_sha256,
      graph_sha256: callerGraphResult.graph_sha256,
      unresolved_dynamic_callers:
        callerGraphResult.graph.unresolved_dynamic_callers,
    },
    global_blockers: [...new Set(globalBlockers)].sort(compareUtf8),
    counts,
    entries,
    owner_approval_required: true,
    legal_approval_required: true,
    serving_registry_mutated: false,
    retirement_authorized: false,
    provider_calls_performed: 0,
    files_written: 0,
  };
}

export function loadPinnedInputs(root) {
  const observedCommit = git(root, [
    "rev-parse",
    `${CONTRACT.base_commit}^{commit}`,
  ]).trim();
  const observedTree = git(root, [
    "rev-parse",
    `${CONTRACT.base_commit}^{tree}`,
  ]).trim();
  if (
    observedCommit !== CONTRACT.base_commit ||
    observedTree !== CONTRACT.base_tree
  ) {
    throw new Error(
      "Pinned classifier base commit or tree is unavailable or forged.",
    );
  }
  return Object.fromEntries(
    Object.entries(CONTRACT.inputs).map(([name, pin]) => [
      name,
      readGitObject(root, pin.path),
    ]),
  );
}

function verifyLoadedCheckerModules(root) {
  for (const name of [
    "retirement_checker",
    "current_source_checker",
    "traffic_checker",
  ]) {
    const pin = CONTRACT.inputs[name];
    assertDigest(
      `loaded ${name}`,
      fs.readFileSync(path.join(root, pin.path)),
      pin.sha256,
    );
  }
}

export function runPinnedClassifier(root) {
  verifyLoadedCheckerModules(root);
  const inputBytes = loadPinnedInputs(root);
  verifyPinnedBytes(inputBytes);
  const policy = JSON.parse(inputBytes.runtime_policy.toString("utf8"));
  const manifest = JSON.parse(inputBytes.manifest.toString("utf8"));
  const callerGraphResult = buildPinnedCallerGraph({
    root,
    policy,
    registryEntries: manifest.functions,
  });
  return classifyPinnedInputs({ inputBytes, callerGraphResult });
}

const isDirectExecution =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  if (process.argv.includes("--inspect-pins")) {
    const inputBytes = loadPinnedInputs(root);
    verifyPinnedBytes(inputBytes);
    const caller = buildPinnedCallerGraph({
      root,
      policy: JSON.parse(inputBytes.runtime_policy.toString("utf8")),
      registryEntries: JSON.parse(inputBytes.manifest.toString("utf8"))
        .functions,
    });
    process.stdout.write(
      `${JSON.stringify({ corpus_sha256: caller.corpus_sha256, graph_sha256: caller.graph_sha256 }, null, 2)}\n`,
    );
  } else if (!process.argv.includes(CONTRACT.required_flag)) {
    process.stdout.write(
      `${JSON.stringify({
        schema_version: CONTRACT.schema_version,
        classifier_id: CONTRACT.classifier_id,
        state: "DISABLED_BY_DEFAULT",
        required_flag: CONTRACT.required_flag,
        serving_registry_mutated: false,
        retirement_authorized: false,
      })}\n`,
    );
  } else {
    try {
      process.stdout.write(
        `${JSON.stringify(runPinnedClassifier(root), null, 2)}\n`,
      );
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          schema_version: CONTRACT.schema_version,
          classifier_id: CONTRACT.classifier_id,
          state: "BLOCKED",
          error_code: "PINNED_CLASSIFIER_FAILURE",
          error_sha256: sha256(
            error instanceof Error ? error.message : String(error),
          ),
          serving_registry_mutated: false,
          retirement_authorized: false,
        })}\n`,
      );
      process.exitCode = 1;
    }
  }
}
