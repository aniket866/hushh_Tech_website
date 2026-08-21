import { createHmac, randomBytes } from "node:crypto";

const LEGACY_PROJECT = "hushh-tech-uat-synthetic";
const PROOF_PREFIX = "synthetic-v1";
const SIGNING_CONTEXT = Buffer.from(
  "hushh-tech-uat-legacy-proof-signing-v1",
  "utf8",
);
const PROOF_TTL_MS = 5 * 60 * 1000;

const SYNTHETIC_FIXTURES = Object.freeze({
  "hushh-tech-uat-synthetic-ada-001": Object.freeze({
    legacyUserUuid: "00000000-0000-4000-8000-000000000101",
    sourceHash: "97cf5576a8a636295214bac1f23c3b900769cb76b59fb2a5c58e6b5f3e4430d7",
  }),
  "hushh-tech-uat-synthetic-grace-001": Object.freeze({
    legacyUserUuid: "00000000-0000-4000-8000-000000000102",
    sourceHash: "f47ebd39d651529aef44d63146b22d496bd24b170314696b9fc08a0de7e03d3a",
  }),
});

const SYNTHETIC_UIDS = Object.freeze(Object.keys(SYNTHETIC_FIXTURES));

function canonicalJson(value) {
  return JSON.stringify(
    Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])),
  );
}

export function createHushhResearchSyntheticProof({
  uid,
  appId,
  audience,
  developerToken,
  now = Date.now,
  randomBytesImpl = randomBytes,
}) {
  const fixture = SYNTHETIC_FIXTURES[uid];
  if (!fixture || typeof developerToken !== "string" || developerToken.length < 32) {
    return null;
  }
  const issuedAtMs = now();
  const payload = {
    app_id: appId,
    audience,
    expires_at_ms: issuedAtMs + PROOF_TTL_MS,
    firebase_uid: uid,
    issued_at_ms: issuedAtMs,
    legacy_project: LEGACY_PROJECT,
    legacy_user_uuid: fixture.legacyUserUuid,
    session_id: randomBytesImpl(24).toString("base64url"),
    source_hash: fixture.sourceHash,
  };
  const encodedPayload = Buffer.from(canonicalJson(payload), "utf8").toString(
    "base64url",
  );
  const derivedKey = createHmac("sha256", Buffer.from(developerToken, "utf8"))
    .update(SIGNING_CONTEXT)
    .digest();
  const signature = createHmac("sha256", derivedKey)
    .update(`${PROOF_PREFIX}.${encodedPayload}`, "ascii")
    .digest("base64url");
  return `${PROOF_PREFIX}.${encodedPayload}.${signature}`;
}

export { SYNTHETIC_FIXTURES, SYNTHETIC_UIDS };
