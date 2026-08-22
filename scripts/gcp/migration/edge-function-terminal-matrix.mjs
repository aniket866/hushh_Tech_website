import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PATHS = Object.freeze({
  manifest: "migration/manifests/supabase-retirement.v1.json",
  registry: "cloud-run/hushh-tech-app-services/registry/functions.v1.json",
  current: "migration/evidence/supabase-current-live-function-bundles.v2.json",
  traffic: "migration/evidence/supabase-function-traffic-30d.v1.json",
  contracts: "migration/functions/edge-function-terminal-contracts.v1.json",
  live: "migration/evidence/gcp-edge-function-uat-live.v1.json",
  output: "migration/evidence/edge-function-terminal-matrix.v1.json",
});
const TERMINAL_STATES = new Set(["PORTED_AND_VERIFIED", "RETIRED"]);
const CONTRACT_FIELDS = Object.freeze([
  "auth",
  "body",
  "cache",
  "cors",
  "desired_terminal_state",
  "idempotency",
  "request",
  "response",
  "route",
  "service_owner",
  "side_effects",
  "target_dependencies",
]);

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
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
const digestRecord = (value) => sha256(stableJson(value));

function uniqueIndex(entries, label, slugOf = (entry) => entry.slug) {
  if (!Array.isArray(entries)) throw new Error(`${label} must be an array.`);
  const output = new Map();
  for (const entry of entries) {
    const slug = slugOf(entry);
    if (typeof slug !== "string" || !slug || output.has(slug)) {
      throw new Error(`${label} contains a missing or duplicate slug.`);
    }
    output.set(slug, entry);
  }
  return output;
}

function assertExactSet(label, expected, actual) {
  const left = [...expected].sort(compareUtf8);
  const right = [...actual].sort(compareUtf8);
  if (stableJson(left) !== stableJson(right)) {
    throw new Error(`${label} slug set does not match the frozen 112-function inventory.`);
  }
}

function validateContract(slug, contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error(`Terminal contract ${slug} must be an object.`);
  }
  const fields = Object.keys(contract).sort(compareUtf8);
  if (stableJson(fields) !== stableJson([...CONTRACT_FIELDS].sort(compareUtf8))) {
    throw new Error(`Terminal contract ${slug} has a missing or unknown surface.`);
  }
  if (!TERMINAL_STATES.has(contract.desired_terminal_state)) {
    throw new Error(`Terminal contract ${slug} has an invalid desired state.`);
  }
  for (const name of ["auth", "body", "cache", "cors", "idempotency", "request", "response", "route"]) {
    if (!contract[name] || typeof contract[name] !== "object" || Array.isArray(contract[name])) {
      throw new Error(`Terminal contract ${slug}.${name} is incomplete.`);
    }
  }
  if (!Array.isArray(contract.side_effects) || !Array.isArray(contract.target_dependencies)) {
    throw new Error(`Terminal contract ${slug} side effects or dependencies are incomplete.`);
  }
}

function blocker(code, evidence) {
  return Object.freeze({ code, evidence });
}

function liveEntryFor(live, slug) {
  if (!live) return null;
  if (live.schema_version !== 1 || live.target?.project_id !== "hushh-tech-uat") {
    throw new Error("Live UAT evidence targets an unexpected project.");
  }
  const entries = uniqueIndex(live.entries, "live UAT evidence");
  return entries.get(slug) ?? null;
}

function completeLiveProof(slug, desiredState, proof, contractDigest) {
  if (!proof || proof.contract_digest !== contractDigest) return false;
  if (
    proof.project_id !== "hushh-tech-uat" ||
    proof.region !== "us-central1" ||
    proof.private_ingress_verified !== true ||
    proof.public_invoker_absent !== true ||
    !/^sha256:[a-f0-9]{64}$/.test(proof.image_digest ?? "") ||
    typeof proof.revision !== "string" ||
    !proof.revision
  ) {
    return false;
  }
  if (desiredState === "RETIRED") {
    return proof.status_code === 410 && proof.response_code === "FEATURE_RETIRED";
  }
  return (
    proof.status_code >= 200 &&
    proof.status_code < 300 &&
    proof.parity_status === "PASS" &&
    proof.auth_status === "PASS" &&
    proof.side_effect_status === "PASS"
  );
}

export function buildTerminalMatrix({ manifest, registry, current, traffic, contracts, live = null, fileDigests }) {
  if (
    manifest?.expected_counts?.active_edge_functions !== 112 ||
    current?.observed_counts?.active_functions !== 112 ||
    traffic?.expected_counts?.active_functions !== 112 ||
    contracts?.target?.project_id !== "hushh-tech-uat"
  ) {
    throw new Error("The edge-function inventory or UAT target is not the frozen 112-function contract.");
  }
  const manifestIndex = uniqueIndex(manifest.functions, "manifest", (entry) => entry?.source?.slug);
  const registryIndex = uniqueIndex(registry, "runtime registry");
  const currentIndex = uniqueIndex(current.entries, "current bundle evidence");
  const trafficIndex = uniqueIndex(traffic.entries, "traffic evidence");
  for (const candidate of [registryIndex, currentIndex, trafficIndex]) {
    assertExactSet("Upstream evidence", manifestIndex.keys(), candidate.keys());
  }
  if (manifestIndex.size !== 112) throw new Error("Manifest must contain exactly 112 functions.");

  const contractEntries = contracts.entries ?? {};
  for (const [slug, contract] of Object.entries(contractEntries)) {
    if (!manifestIndex.has(slug)) throw new Error(`Terminal contract has unknown slug ${slug}.`);
    validateContract(slug, contract);
  }

  const entries = [...manifestIndex.keys()].sort(compareUtf8).map((slug) => {
    const planned = manifestIndex.get(slug);
    const runtime = registryIndex.get(slug);
    const source = currentIndex.get(slug);
    const observedTraffic = trafficIndex.get(slug);
    if (
      runtime.owner_group !== planned.owner_group ||
      runtime.auth_mode !== planned.auth_mode ||
      runtime.final_disposition !== planned.final_disposition ||
      runtime.migration_state !== planned.migration_state ||
      source.function_id !== planned.source.function_id ||
      source.manifest_version !== planned.source.version ||
      source.verify_jwt !== planned.source.verify_jwt
    ) {
      throw new Error(`Frozen identity or runtime registry drift for ${slug}.`);
    }

    const desiredState = planned.final_disposition === "RETIRE_WITH_410"
      ? "RETIRED"
      : "PORTED_AND_VERIFIED";
    const contract = contractEntries[slug] ?? null;
    const contractDigest = contract ? digestRecord(contract) : null;
    const proof = liveEntryFor(live, slug);
    const blockers = [];

    if (!contract) blockers.push(blocker("TARGET_CONTRACT_MISSING", "terminal contract entry absent"));
    if (contract && contract.desired_terminal_state !== desiredState) {
      blockers.push(blocker("TARGET_DISPOSITION_MISMATCH", contract.desired_terminal_state));
    }

    if (desiredState === "PORTED_AND_VERIFIED") {
      if (source.version_delta !== 0) {
        blockers.push(blocker("SOURCE_VERSION_DRIFT", `manifest=${source.manifest_version};current=${source.current_version}`));
      }
      if (source.capture_status !== "EXTRACTED" || !source.bundle_evidence?.canonical_digest) {
        blockers.push(blocker("SOURCE_BUNDLE_UNAVAILABLE", source.capture_status));
      }
      if (observedTraffic.source_reconstruction_status.startsWith("CUTOVER_BLOCKING_")) {
        blockers.push(blocker("SOURCE_CONTRACT_UNPROVEN", observedTraffic.source_reconstruction_status));
      }
      if (current.cutover_assessment?.metadata_end_check_status !== "PASS") {
        blockers.push(blocker("SOURCE_METADATA_END_CHECK_MISSING", current.cutover_assessment?.metadata_end_check_status));
      }
      if (current.cutover_assessment?.bundle_to_metadata_version_binding_status !== "PROVEN") {
        blockers.push(blocker("SOURCE_BUNDLE_VERSION_UNBOUND", current.cutover_assessment?.bundle_to_metadata_version_binding_status));
      }
      if (current.cutover_assessment?.source_revision_status !== "PROVEN") {
        blockers.push(blocker("SOURCE_REVISION_UNPROVEN", current.cutover_assessment?.source_revision_status));
      }
    } else {
      if (observedTraffic.terminal_traffic_status !== "ZERO_TRAFFIC_OBSERVED") {
        blockers.push(blocker("RETIREMENT_TRAFFIC_PRESENT", observedTraffic.request_count));
      }
      if (source.current_version !== source.manifest_version) {
        blockers.push(blocker("RETIREMENT_SOURCE_VERSION_DRIFT", `manifest=${source.manifest_version};current=${source.current_version}`));
      }
    }

    if (contract && !completeLiveProof(slug, desiredState, proof, contractDigest)) {
      blockers.push(blocker("UAT_LIVE_TERMINAL_PROOF_MISSING", proof ? "incomplete_or_stale" : "absent"));
    }

    const state = blockers.length === 0 ? desiredState : "BLOCKED";
    return {
      slug,
      owner_group: planned.owner_group,
      auth_mode: planned.auth_mode,
      desired_terminal_state: desiredState,
      observed_state: state,
      source: {
        function_id: source.function_id,
        status: source.status,
        manifest_version: source.manifest_version,
        current_version: source.current_version,
        verify_jwt: source.verify_jwt,
        capture_status: source.capture_status,
        bundle_digest: source.bundle_evidence?.canonical_digest ?? null,
        deployment_binding_sha256: observedTraffic.deployment_binding_sha256,
        traffic_status: observedTraffic.terminal_traffic_status,
        request_count_30d: observedTraffic.request_count,
      },
      target: {
        project_id: "hushh-tech-uat",
        region: "us-central1",
        service_owner: contract?.service_owner ?? planned.owner_group,
        contract_digest: contractDigest,
        live_evidence_digest: proof ? digestRecord(proof) : null,
      },
      blockers: blockers.sort((left, right) => compareUtf8(left.code, right.code)),
    };
  });

  const stateCounts = Object.fromEntries(
    ["BLOCKED", "PORTED_AND_VERIFIED", "RETIRED"].map((state) => [
      state.toLowerCase(),
      entries.filter((entry) => entry.observed_state === state).length,
    ]),
  );
  const blockerCounts = {};
  for (const entry of entries) {
    for (const item of entry.blockers) blockerCounts[item.code] = (blockerCounts[item.code] ?? 0) + 1;
  }
  const output = {
    schema_version: 1,
    evidence_id: "hushh-tech-edge-function-terminal-matrix",
    target: contracts.target,
    source_write_mode: "LOCAL_READ_ONLY_NO_PROVIDER_IO",
    required_terminal_states: ["PORTED_AND_VERIFIED", "RETIRED"],
    bindings: fileDigests,
    source_capture: {
      completed_at_utc: current.capture.capture_completed_at_utc,
      status: current.cutover_assessment.status,
      traffic_window_end_utc: traffic.capture.window_end_utc,
    },
    summary: {
      total: entries.length,
      desired_ported_and_verified: entries.filter((entry) => entry.desired_terminal_state === "PORTED_AND_VERIFIED").length,
      desired_retired: entries.filter((entry) => entry.desired_terminal_state === "RETIRED").length,
      observed: stateCounts,
      all_terminal: entries.every((entry) => TERMINAL_STATES.has(entry.observed_state)),
      blocker_code_counts: Object.fromEntries(Object.entries(blockerCounts).sort(([left], [right]) => compareUtf8(left, right))),
    },
    entries,
  };
  return { ...output, evidence_digest: sha256(stableJson(output)) };
}

export function readInputs(root = process.cwd()) {
  const bytes = {};
  for (const [name, relativePath] of Object.entries(PATHS)) {
    if (["output", "live"].includes(name)) continue;
    bytes[name] = fs.readFileSync(path.join(root, relativePath));
  }
  const livePath = path.join(root, PATHS.live);
  const liveBytes = fs.existsSync(livePath) ? fs.readFileSync(livePath) : null;
  const parse = (name) => JSON.parse(bytes[name].toString("utf8"));
  return {
    manifest: parse("manifest"),
    registry: parse("registry"),
    current: parse("current"),
    traffic: parse("traffic"),
    contracts: parse("contracts"),
    live: liveBytes ? JSON.parse(liveBytes.toString("utf8")) : null,
    fileDigests: Object.fromEntries(
      Object.entries(bytes).map(([name, value]) => [name, { path: PATHS[name], sha256: sha256(value) }]),
    ),
  };
}

function render(matrix) {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) {
  const matrix = buildTerminalMatrix(readInputs());
  const outputPath = path.resolve(PATHS.output);
  const expected = render(matrix);
  if (process.argv.includes("--write")) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, expected);
  } else if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== expected) {
    console.error("Edge-function terminal matrix is stale or missing; run with --write.");
    process.exitCode = 1;
  }
  console.log(JSON.stringify(matrix.summary));
  if (process.argv.includes("--require-terminal") && !matrix.summary.all_terminal) {
    console.error(`Edge-function cutover blocked: ${matrix.summary.observed.blocked} of 112 functions are not terminal.`);
    process.exitCode = 1;
  }
}
