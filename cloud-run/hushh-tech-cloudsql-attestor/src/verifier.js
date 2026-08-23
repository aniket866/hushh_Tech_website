import { canonicalJson, sha256 } from "./canonical.js";
import {
  EXPECTED_BOUNDS_QUERY_SHA256,
  EXPECTED_CATALOG_QUERY_SHA256,
  EXPECTED_EXECUTION_CONTRACT_SHA256,
  EXPECTED_QUERY_SET_SHA256,
  EXPECTED_SOURCE_SHA256,
  TARGET,
} from "./constants.js";
import { validateEvidence } from "./evidence.js";
import { AttestorError } from "./errors.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const EXPECTED_SERVICE_IDENTITY_SHA256 = sha256(
  Buffer.from(TARGET.runtimeServiceAccount, "utf8"),
);

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function evidenceCanonicalSha256(evidence) {
  return sha256(Buffer.from(canonicalJson(evidence), "utf8"));
}

export function verifyExternalContext({ evidence, trustedContext }) {
  validateEvidence(evidence);
  if (
    evidence.status !== "CAPTURED" ||
    evidence.execution.hardProcessSupervisor !== true ||
    !exactKeys(trustedContext, [
      "actualImageDigest",
      "serviceIdentitySha256",
      "cloudRunExecutionSha256",
      "immutableLogEntrySha256",
      "loggedEvidenceSha256",
      "executionContractSha256",
      "querySetSha256",
      "boundsQuerySha256",
      "catalogQuerySha256",
      "sourceSha256",
    ]) ||
    !IMAGE_DIGEST_PATTERN.test(trustedContext.actualImageDigest ?? "") ||
    trustedContext.actualImageDigest !== evidence.bindings.imageDigest ||
    trustedContext.serviceIdentitySha256 !== EXPECTED_SERVICE_IDENTITY_SHA256 ||
    !SHA256_PATTERN.test(trustedContext.cloudRunExecutionSha256 ?? "") ||
    !SHA256_PATTERN.test(trustedContext.immutableLogEntrySha256 ?? "") ||
    trustedContext.loggedEvidenceSha256 !== evidenceCanonicalSha256(evidence) ||
    trustedContext.executionContractSha256 !== EXPECTED_EXECUTION_CONTRACT_SHA256 ||
    trustedContext.querySetSha256 !== EXPECTED_QUERY_SET_SHA256 ||
    trustedContext.boundsQuerySha256 !== EXPECTED_BOUNDS_QUERY_SHA256 ||
    trustedContext.catalogQuerySha256 !== EXPECTED_CATALOG_QUERY_SHA256 ||
    trustedContext.sourceSha256 !== EXPECTED_SOURCE_SHA256
  ) {
    throw new AttestorError("EXTERNAL_CONTEXT_INVALID");
  }
  return Object.freeze({
    valid: true,
    status: "CAPTURE_CONTEXT_VERIFIED",
    evidenceSha256: evidence.evidenceSha256,
    imageDigest: trustedContext.actualImageDigest,
    cloudRunExecutionSha256: trustedContext.cloudRunExecutionSha256,
    immutableLogEntrySha256: trustedContext.immutableLogEntrySha256,
  });
}

export { EXPECTED_SERVICE_IDENTITY_SHA256 };
