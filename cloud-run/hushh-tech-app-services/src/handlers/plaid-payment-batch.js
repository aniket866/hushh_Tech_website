import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

import { RuntimeError } from "../errors.js";

const JSON_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
  "content-type": "application/json",
});
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const PLAID_KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const FIREBASE_UID_PATTERN = /^[^\u0000-\u001f\u007f]{1,128}$/;
const GOOGLE_SERVICE_EMAIL_PATTERN =
  /^[a-z0-9][a-z0-9._-]{0,126}@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:+/-]{16,200}$/;
const FENCE_TOKEN_PATTERN = /^[A-Za-z0-9._~:+/-]{16,512}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPERATION_LEDGER_DURABILITY =
  "cloud_sql_serializable_fenced_operation_v1";
const RESULT_PROTECTION = "cloud_kms_envelope_v1";
const TRANSACTION_DURABILITY = "cloud_sql_serializable_transaction_v1";
const MAX_JSON_BYTES = 262_144;
const MAX_WEBHOOK_BYTES = 1_048_576;
const MAX_WEBHOOK_JWT_BYTES = 16_384;
const MAX_WEBHOOK_AGE_SECONDS = 300;
const MAX_WEBHOOK_CLOCK_SKEW_SECONDS = 30;
const MAX_FIRST_PAYMENT_CENTS = 10_000_000_000;
const MAX_DIAGNOSTIC_FIELD_BYTES = 16_000;
const MAX_DIAGNOSTIC_DEPTH = 6;
const MAX_DIAGNOSTIC_KEYS = 128;
const PLAID_DATA_PRODUCTS = Object.freeze([
  "accounts",
  "balance",
  "auth",
  "identity",
  "identity_match",
  "investments",
  "investment_transactions",
  "liabilities",
  "signal",
  "transactions",
  "assets",
  "statements",
  "income",
]);
const SENSITIVE_DIAGNOSTIC_KEY =
  /(?:access|public|refresh|service)[\s_-]*token|authorization|cookie|credential|secret|password|passcode|e[\s_-]*mail|phone|address|routing|account(?:[\s_-]*number)?|ssn|tax[\s_-]*id|holder|(?:first|last|full|legal|user)[\s_-]*name|balance/i;
const SENSITIVE_DIAGNOSTIC_VALUE =
  /(?:bearer\s+[A-Za-z0-9._~+/-]{16,}|(?:access|public|refresh|service)[_-](?:sandbox|development|production)[-_][A-Za-z0-9._~-]{8,}|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b\d{3}-?\d{2}-?\d{4}\b|(?:\+?\d[\s().-]*){9,})/i;
const FORBIDDEN_RESPONSE_KEY =
  /(?:access|public|refresh|service)[_-]?token|authorization|cookie|credential|secret|password|passcode|routing[_-]?number|account[_-]?number|ssn|tax[_-]?id/i;

const SOURCE_EVIDENCE = Object.freeze({
  sourceEvidenceFileSha256:
    "54d9535f80d3954902da8f99cf84c46609cd7d971d6344c16704bad5e0963703",
  sourceEvidenceDigest:
    "abce166ff5f1af61b1ff7fa8f3839b21ff55d8a255efdf520fd724cfa8bba219",
  canonicalSourceTreeDigest:
    "2f203e524b8749272f49ae9c4051fefe73e7a877458ac34c2a3cf7b9c322b7d0",
  currentMetadataDigest:
    "b15f57a658b2ae2a1e8399551ae9af92db1a652ade7401ad08b1a148567c798b",
  trafficEvidenceFileSha256:
    "5db78b99f880423c88528817ca422ab862aa1a42f93699e37b0e4ce03fc90ac0",
  trafficEvidenceDigest:
    "eade0ef6ae4fbd34009a481ddf5771c3338de7034f6fcaff4dfbb3b453a00d51",
  deploymentInventoryDigest:
    "f7ef842b42a08fccca969c4dc1e212ebe764f0ffe7c3c8a3c30df11934842981",
  terminalMatrixFileSha256:
    "d6331e9229ad3002cd5568c69d80d2c078ad3791b23fba7ccab50ef667b4b40f",
  terminalMatrixEvidenceDigest:
    "c39ce5b5b7b29193743a249cd37553ecbd948f4f45a49b10a541e9d8db8744e8",
});

const SOURCE_PINS = Object.freeze({
  "create-link-token": Object.freeze({
    source: "b44e00f84fb967a3afd172bcc950532c5b2afcf3a7f95cfe18ab1d9e1f92396c",
    live: "309d48df095fe93ec94fae01d2b06f243399b03f744a14cc39c590a7acc621af",
    functionId: "cf10c7ad-6d17-41d6-9a31-f62db2d13cc3",
    manifestVersion: 5752,
    sourceVersion: 5795,
    verifyJwt: true,
    deploymentBindingSha256:
      "fb18aa6d20f257b5e14c25147f94bd3f471b02106b462f2c89bd549c895d5b2d",
    requestCount30d: 36,
  }),
  "exchange-public-token": Object.freeze({
    source: "a84d98babd639fa4af3a2440f4b3b05c1b0096e13229fab9bd63cc545b9df02f",
    live: "274158d55ef75a5eec35c77447e5de1e5597ba8fd9f1719577422dfd81c11540",
    functionId: "2a3a9ec9-cc41-4ff1-ab05-2ddd20b3d1ab",
    manifestVersion: 5728,
    sourceVersion: 5771,
    verifyJwt: true,
    deploymentBindingSha256:
      "d607ac6f4e7ac8e0551f5912183dd977ad32f67bf97704bc28f69632a74d2548",
    requestCount30d: 8,
  }),
  "fund-coupon-redeem": Object.freeze({
    source: "08842c770d693845f7f7bca5b716e456a45515eaca3dd02995a6897bb1e987b6",
    live: "0b3572d9821038555d31687fc79f3819dadf40154ee1be042f7b6d00ef0c3b98",
    functionId: "9df94ee2-a0eb-4ae7-bb72-934148d0b377",
    manifestVersion: 3180,
    sourceVersion: 3223,
    verifyJwt: true,
    deploymentBindingSha256:
      "9ab0d962c6af024c5eb25ad9bfabaac1c122b6d62b1b117822fa7950e843a383",
    requestCount30d: 4,
  }),
  "fund-payment-request-create": Object.freeze({
    source: "7483162b728eb142455e5142f51b18eb4ac66dedeb8083b8dbb340e0ecbaa488",
    live: "74166d1f45fc1a634215fe8b7ff1c11cc08f0cd4ac32c435705d8810c5c27172",
    functionId: "cce8f22e-d4dc-46ae-820c-c26f51088656",
    manifestVersion: 4092,
    sourceVersion: 4135,
    verifyJwt: true,
    deploymentBindingSha256:
      "7ec36aa83f00dd7de134b98ea74ab93f18222d3274f85b5343dc746c930a3e7c",
    requestCount30d: 4,
  }),
  "fund-payment-status": Object.freeze({
    source: "bbb26b28fabad200380b63ba3e99bbd895e2f993ea11c1b6f452bb9b660ed443",
    live: "2e09a6cacecc5a5420e20a0eb8bd7acbea40cb015a9a0b6f7d4b2603f4991b7f",
    functionId: "09f29e73-a406-4886-9cf9-712e4a79fcb2",
    manifestVersion: 4087,
    sourceVersion: 4130,
    verifyJwt: true,
    deploymentBindingSha256:
      "16b45c57d835a73bdf7d33034093a52bb3e601fef278bb31d3553cd492dc57e7",
    requestCount30d: 55,
  }),
  "plaid-data-sync-start": Object.freeze({
    source: "9e202cd7e776be10588d2fd94a460da5fd609b9d719b63a3a1e133589ffb77c6",
    live: "ad13beb3712e1fa42eda83bc18d06650cee9844e08461ed63ce9d87a32057647",
    functionId: "be9f07d3-d9dd-4989-bb3d-98efd72751eb",
    manifestVersion: 4093,
    sourceVersion: 4136,
    verifyJwt: true,
    deploymentBindingSha256:
      "da45400a5b5408d0c3e0b3657c3a0295262d0f06161f94cfd23c2ad53c7d4446",
    requestCount30d: 8,
  }),
  "plaid-data-webhook": Object.freeze({
    source: "d83bb47d5cca4fcb560ad8bdc61b24de37c0a60b2a66271ac31fe82eeccf8ac2",
    live: "ef127f53865f8c36d0861cb684407b7b29ee3b4e78ce1caece658117734777e5",
    functionId: "78b486be-c2a4-4d80-b5a0-1dc59adc7967",
    manifestVersion: 4094,
    sourceVersion: 4137,
    verifyJwt: false,
    deploymentBindingSha256:
      "6a1dc1ac84a9aff459972b4206446b14d8c6a315104be33b0e74eed9d0b0d2ff",
    requestCount30d: 470,
  }),
  "plaid-diagnostics-log": Object.freeze({
    source: "fc4bf9865ea9bc7972a7dfe6342576128bc8f2f499148751fada165453b483c2",
    live: "3a2a2309233d4e3e965acb34f6030a650b038bd07aad92008624df7953b80bf8",
    functionId: "51dc3d49-0f7d-4ed3-b2fd-2e6eeb30e6e4",
    manifestVersion: 4023,
    sourceVersion: 4066,
    verifyJwt: false,
    deploymentBindingSha256:
      "d739f560f1bec2fef4acf314d43acc55ffdef0e35909f3e0c280f9e684e24424",
    requestCount30d: 173,
  }),
});

const AUTHORITATIVE_BLOCKER_CODES = Object.freeze([
  "SOURCE_BUNDLE_VERSION_UNBOUND",
  "SOURCE_METADATA_END_CHECK_MISSING",
  "SOURCE_REVISION_UNPROVEN",
  "SOURCE_VERSION_DRIFT",
  "TARGET_CONTRACT_MISSING",
  "TARGET_REGISTRY_NOT_ENABLED",
]);

function blockerEvidence(pin) {
  return Object.freeze([
    Object.freeze({
      code: "SOURCE_BUNDLE_VERSION_UNBOUND",
      evidence: "NOT_PROVEN_WITHOUT_END_METADATA_CHECK",
    }),
    Object.freeze({
      code: "SOURCE_METADATA_END_CHECK_MISSING",
      evidence: "NOT_PERFORMED_IN_V2_BLOCKING",
    }),
    Object.freeze({ code: "SOURCE_REVISION_UNPROVEN", evidence: "NOT_PROVEN" }),
    Object.freeze({
      code: "SOURCE_VERSION_DRIFT",
      evidence: `manifest=${pin.manifestVersion};current=${pin.sourceVersion}`,
    }),
    Object.freeze({
      code: "TARGET_CONTRACT_MISSING",
      evidence: "terminal contract entry absent",
    }),
    Object.freeze({
      code: "TARGET_REGISTRY_NOT_ENABLED",
      evidence: "INVENTORY_FROZEN",
    }),
  ]);
}

export const PLAID_PAYMENT_SOURCE_EVIDENCE = SOURCE_EVIDENCE;
export const PLAID_PAYMENT_SOURCE_PINS = SOURCE_PINS;
export const PLAID_PAYMENT_SLUGS = Object.freeze(Object.keys(SOURCE_PINS).sort());
export const PLAID_PAYMENT_AUTHORITATIVE_BLOCKERS = Object.freeze(
  Object.fromEntries(
    Object.entries(SOURCE_PINS).map(([slug, pin]) => [slug, blockerEvidence(pin)]),
  ),
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function decodeBase64Url(value, maxBytes) {
  if (
    typeof value !== "string" ||
    !BASE64URL_PATTERN.test(value) ||
    value.length > maxBytes * 2
  ) {
    return null;
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length < 1 ||
    decoded.length > maxBytes ||
    decoded.toString("base64url") !== value
  ) {
    return null;
  }
  return decoded;
}

function parseJwtObject(segment, maxBytes) {
  const bytes = decodeBase64Url(segment, maxBytes);
  if (!bytes) return null;
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function rejectPlaidSignature() {
  fail("WEBHOOK_SIGNATURE_INVALID", "Webhook rejected.", 401);
}

/**
 * Detached candidate verifier for Plaid's Plaid-Verification compact JWT.
 * The resolver owns the authenticated /webhook_verification_key/get call and
 * cache; this function receives only the public JWK and never provider secrets.
 */
export async function verifyPlaidWebhookSignature({
  rawBody,
  signedJwt,
  resolveVerificationKey,
  nowMs = Date.now(),
  signal,
} = {}) {
  throwIfAborted(signal);
  if (
    !Buffer.isBuffer(rawBody) ||
    rawBody.length < 2 ||
    rawBody.length > MAX_WEBHOOK_BYTES ||
    typeof signedJwt !== "string" ||
    Buffer.byteLength(signedJwt, "ascii") > MAX_WEBHOOK_JWT_BYTES
  ) {
    rejectPlaidSignature();
  }
  const segments = signedJwt.split(".");
  if (segments.length !== 3) rejectPlaidSignature();
  const [encodedHeader, encodedClaims, encodedSignature] = segments;
  const header = parseJwtObject(encodedHeader, 4_096);
  const claims = parseJwtObject(encodedClaims, 8_192);
  const signature = decodeBase64Url(encodedSignature, 128);
  if (
    !header ||
    !claims ||
    !signature ||
    signature.length !== 64 ||
    header.alg !== "ES256" ||
    header.typ !== "JWT" ||
    !PLAID_KEY_ID_PATTERN.test(String(header.kid ?? "")) ||
    !Number.isSafeInteger(claims.iat) ||
    !HASH_PATTERN.test(String(claims.request_body_sha256 ?? "")) ||
    !Number.isFinite(nowMs)
  ) {
    rejectPlaidSignature();
  }

  const nowSeconds = Math.floor(nowMs / 1_000);
  if (
    nowSeconds - claims.iat > MAX_WEBHOOK_AGE_SECONDS ||
    claims.iat - nowSeconds > MAX_WEBHOOK_CLOCK_SKEW_SECONDS
  ) {
    rejectPlaidSignature();
  }
  if (typeof resolveVerificationKey !== "function") rejectPlaidSignature();

  let verificationKey;
  try {
    verificationKey = await resolveVerificationKey({
      keyId: header.kid,
      signal,
    });
  } catch {
    rejectPlaidSignature();
  }
  throwIfAborted(signal);

  const x = decodeBase64Url(verificationKey?.x, 32);
  const y = decodeBase64Url(verificationKey?.y, 32);
  if (
    !verificationKey ||
    typeof verificationKey !== "object" ||
    Array.isArray(verificationKey) ||
    Object.prototype.hasOwnProperty.call(verificationKey, "d") ||
    verificationKey.kid !== header.kid ||
    verificationKey.alg !== "ES256" ||
    verificationKey.kty !== "EC" ||
    verificationKey.crv !== "P-256" ||
    verificationKey.use !== "sig" ||
    !x ||
    x.length !== 32 ||
    !y ||
    y.length !== 32 ||
    !Number.isSafeInteger(verificationKey.created_at) ||
    verificationKey.created_at > claims.iat + MAX_WEBHOOK_CLOCK_SKEW_SECONDS ||
    !(
      verificationKey.expired_at === null ||
      (Number.isSafeInteger(verificationKey.expired_at) &&
        claims.iat <= verificationKey.expired_at)
    )
  ) {
    rejectPlaidSignature();
  }

  let signatureValid = false;
  try {
    const publicKey = createPublicKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        x: verificationKey.x,
        y: verificationKey.y,
      },
    });
    signatureValid = verifySignature(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature,
    );
  } catch {
    rejectPlaidSignature();
  }
  if (!signatureValid) rejectPlaidSignature();

  const actualBodyHash = createHash("sha256").update(rawBody).digest();
  const claimedBodyHash = Buffer.from(claims.request_body_sha256, "hex");
  if (
    claimedBodyHash.length !== actualBodyHash.length ||
    !timingSafeEqual(actualBodyHash, claimedBodyHash)
  ) {
    rejectPlaidSignature();
  }

  const payloadHash = actualBodyHash.toString("hex");
  const eventKeyHash = sha256(
    Buffer.from(stableJson([1, "plaid-data-webhook", payloadHash]), "utf8"),
  );
  return Object.freeze({
    actor: Object.freeze({
      kind: "provider-webhook",
      provider: "plaid",
      eventId: payloadHash,
      eventKeyHash,
    }),
    signatureProof: Object.freeze({
      algorithm: "ES256",
      keyId: header.kid,
      issuedAt: claims.iat,
      payloadHash,
      eventKeyHash,
    }),
  });
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function fail(code, message = "Service unavailable.", status = 503) {
  throw new RuntimeError(code, message, status);
}

function json(status, body) {
  return Object.freeze({ status, headers: JSON_HEADERS, body });
}

function approvalMaterial(slug, row) {
  return stableJson({
    schemaVersion: 1,
    slug,
    checkedInSourceSha256: row.checkedInSourceSha256,
    liveV2BundleSha256: row.liveV2BundleSha256,
    functionId: row.functionId,
    manifestVersion: row.manifestVersion,
    sourceVersion: row.sourceVersion,
    verifyJwt: row.verifyJwt,
    requestCount30d: row.requestCount30d,
    metadataEndCheckPassed: row.metadataEndCheckPassed,
    metadataEndCheckDigestSha256: row.metadataEndCheckDigestSha256,
    deploymentBindingSha256: row.deploymentBindingSha256,
    sourceEvidenceFileSha256: row.sourceEvidenceFileSha256,
    sourceEvidenceDigest: row.sourceEvidenceDigest,
    canonicalSourceTreeDigest: row.canonicalSourceTreeDigest,
    currentMetadataDigest: row.currentMetadataDigest,
    trafficEvidenceFileSha256: row.trafficEvidenceFileSha256,
    trafficEvidenceDigest: row.trafficEvidenceDigest,
    deploymentInventoryDigest: row.deploymentInventoryDigest,
    terminalMatrixFileSha256: row.terminalMatrixFileSha256,
    terminalMatrixEvidenceDigest: row.terminalMatrixEvidenceDigest,
    authoritativeBlockers: row.authoritativeBlockers,
  });
}

export function calculatePlaidPaymentApprovalBinding(slug, row) {
  return sha256(approvalMaterial(slug, row));
}

export function calculatePlaidPaymentEndMetadataBinding(slug, row) {
  return sha256(
    stableJson({
      schemaVersion: 1,
      slug,
      functionId: row.functionId,
      sourceVersion: row.sourceVersion,
      liveV2BundleSha256: row.liveV2BundleSha256,
      metadataEndCheckPassed: row.metadataEndCheckPassed,
      currentMetadataDigest: row.currentMetadataDigest,
      deploymentBindingSha256: row.deploymentBindingSha256,
    }),
  );
}

function requireEvidence(evidence, slug) {
  const pin = SOURCE_PINS[slug];
  const row = evidence?.[slug];
  const blockers = PLAID_PAYMENT_AUTHORITATIVE_BLOCKERS[slug];
  const expectedFields = [
    "approved",
    "schemaVersion",
    "checkedInSourceSha256",
    "liveV2BundleSha256",
    "functionId",
    "manifestVersion",
    "sourceVersion",
    "verifyJwt",
    "requestCount30d",
    "metadataEndCheckPassed",
    "metadataEndCheckDigestSha256",
    "deploymentBindingSha256",
    "sourceEvidenceFileSha256",
    "sourceEvidenceDigest",
    "canonicalSourceTreeDigest",
    "currentMetadataDigest",
    "trafficEvidenceFileSha256",
    "trafficEvidenceDigest",
    "deploymentInventoryDigest",
    "terminalMatrixFileSha256",
    "terminalMatrixEvidenceDigest",
    "authoritativeBlockers",
    "bindingSha256",
  ];
  if (
    !pin ||
    !exactKeys(row, expectedFields) ||
    row.approved !== true ||
    row.schemaVersion !== 1 ||
    row.checkedInSourceSha256 !== pin.source ||
    row.liveV2BundleSha256 !== pin.live ||
    row.functionId !== pin.functionId ||
    row.manifestVersion !== pin.manifestVersion ||
    row.sourceVersion !== pin.sourceVersion ||
    row.verifyJwt !== pin.verifyJwt ||
    row.requestCount30d !== pin.requestCount30d ||
    row.metadataEndCheckPassed !== true ||
    row.deploymentBindingSha256 !== pin.deploymentBindingSha256 ||
    Object.entries(SOURCE_EVIDENCE).some(([key, value]) => row[key] !== value) ||
    row.authoritativeBlockers?.map(({ code }) => code).join("\0") !==
      AUTHORITATIVE_BLOCKER_CODES.join("\0") ||
    stableJson(row.authoritativeBlockers) !== stableJson(blockers) ||
    row.metadataEndCheckDigestSha256 !==
      calculatePlaidPaymentEndMetadataBinding(slug, row) ||
    row.bindingSha256 !== calculatePlaidPaymentApprovalBinding(slug, row) ||
    !HASH_PATTERN.test(row.bindingSha256)
  ) {
    fail("CANDIDATE_EVIDENCE_REQUIRED");
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new RuntimeError("HANDLER_ABORTED", "Service unavailable.", 503);
}

function requireUserActor(actor, expectedUid, allowedGoogleServiceCallers) {
  if (!FIREBASE_UID_PATTERN.test(String(expectedUid ?? ""))) {
    fail("ACCESS_DENIED", "Access denied.", 403);
  }
  if (
    actor?.kind === "firebase" &&
    FIREBASE_UID_PATTERN.test(String(actor.uid ?? "")) &&
    actor.uid === expectedUid &&
    actor.recentAuth === true
  ) {
    return Object.freeze({
      kind: "firebase",
      uid: expectedUid,
      email: email(actor.email),
      principalHash: sha256(
        Buffer.from(stableJson([1, "firebase", actor.uid]), "utf8"),
      ),
    });
  }
  const serviceEmail = String(actor?.email ?? "").trim().toLowerCase();
  const serviceSubject = String(actor?.subject ?? "").trim();
  if (
    actor?.kind !== "google-service" ||
    actor.email !== serviceEmail ||
    !GOOGLE_SERVICE_EMAIL_PATTERN.test(serviceEmail) ||
    !allowedGoogleServiceCallers.has(serviceEmail) ||
    serviceSubject.length < 1 ||
    serviceSubject.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(serviceSubject)
  ) {
    fail("ACCESS_DENIED", "Access denied.", 403);
  }
  return Object.freeze({
    kind: "google-service",
    uid: expectedUid,
    email: null,
    principalHash: sha256(
      Buffer.from(
        stableJson([1, "google-service", serviceEmail, serviceSubject]),
        "utf8",
      ),
    ),
  });
}

function operationActor(actor) {
  return Object.freeze({
    actorUid: actor.uid,
    callerKind: actor.kind,
    callerPrincipalHash: actor.principalHash,
  });
}

function requestBody(request) {
  if (!request?.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  return request.body;
}

function exactObject(value, allowed, required = []) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in value))
  ) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  return value;
}

function aliasedValue(value, keys) {
  const present = keys.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (
    present.length > 1 &&
    present.some((key) => stableJson(value[key]) !== stableJson(value[present[0]]))
  ) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  return present.length ? value[present[0]] : undefined;
}

function boundedText(value, max, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) fail("INVALID_REQUEST", "Invalid request.", 400);
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  const normalized = value.trim();
  if (required && !normalized) fail("INVALID_REQUEST", "Invalid request.", 400);
  return normalized || null;
}

function userId(body) {
  return boundedText(aliasedValue(body, ["userId", "user_id"]), 128, {
    required: true,
  });
}

function usdCents(value) {
  let cents;
  if (typeof value === "number") {
    const scaled = value * 100;
    if (!Number.isFinite(value) || Math.abs(scaled - Math.round(scaled)) > 1e-8) {
      fail("INVALID_REQUEST", "Invalid request.", 400);
    }
    cents = Math.round(scaled);
  } else if (typeof value === "string" && /^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(value)) {
    const [whole, fraction = ""] = value.split(".");
    cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  } else {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  if (
    !Number.isSafeInteger(cents) ||
    cents < 100 ||
    cents > MAX_FIRST_PAYMENT_CENTS
  ) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  return cents;
}

function email(value) {
  const normalized = boundedText(value, 320);
  if (normalized && !EMAIL_PATTERN.test(normalized)) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  return normalized?.toLowerCase() ?? null;
}

function safeRedirect(value, allowedRedirectOrigins) {
  const normalized = boundedText(value, 2_048);
  if (!normalized) return null;
  let url;
  try {
    url = new URL(normalized);
  } catch {
    fail("INVALID_REDIRECT", "Invalid redirect.", 400);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !allowedRedirectOrigins.has(url.origin)
  ) {
    fail("INVALID_REDIRECT", "Invalid redirect.", 400);
  }
  return url.toString();
}

function idempotencyKey(request) {
  const raw = request?.headers?.["idempotency-key"];
  const value = Array.isArray(raw) ? raw.join(",") : String(raw ?? "").trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    fail("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key required.", 400);
  }
  return value;
}

function requireLedger(operationLedger) {
  if (
    operationLedger?.configured !== true ||
    operationLedger.durability !== OPERATION_LEDGER_DURABILITY ||
    operationLedger.resultProtection !== RESULT_PROTECTION ||
    typeof operationLedger.run !== "function"
  ) {
    fail("OPERATION_LEDGER_UNAVAILABLE");
  }
  return operationLedger;
}

function requireOperations(operations) {
  const methods = [
    "processPlaidWebhook",
    "appendPlaidDiagnostic",
    "getFundPaymentStatus",
    "createLinkToken",
    "exchangePublicToken",
    "startPlaidDataSync",
    "redeemFundCoupon",
    "createFundPaymentRequest",
  ];
  if (
    operations?.configured !== true ||
    methods.some((method) => typeof operations[method] !== "function")
  ) {
    fail("PLAID_PAYMENT_ADAPTER_UNAVAILABLE");
  }
  return operations;
}

function validateTransaction(context) {
  if (
    !context ||
    typeof context !== "object" ||
    !FENCE_TOKEN_PATTERN.test(String(context.fenceToken ?? "")) ||
    context.transaction?.configured !== true ||
    context.transaction.durability !== TRANSACTION_DURABILITY
  ) {
    fail("OPERATION_LEDGER_UNAVAILABLE");
  }
  return context;
}

function assertResponseSafe(value, depth = 0) {
  if (depth > 8) fail("HANDLER_CONTRACT_INVALID");
  if (value === null || value === undefined) return;
  if (["string", "number", "boolean"].includes(typeof value)) return;
  if (Array.isArray(value)) {
    if (value.length > 256) fail("HANDLER_CONTRACT_INVALID");
    for (const item of value) assertResponseSafe(item, depth + 1);
    return;
  }
  if (typeof value !== "object") fail("HANDLER_CONTRACT_INVALID");
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RESPONSE_KEY.test(key)) fail("HANDLER_CONTRACT_INVALID");
    assertResponseSafe(child, depth + 1);
  }
}

function normalizeResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    fail("HANDLER_CONTRACT_INVALID");
  }
  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch {
    fail("HANDLER_CONTRACT_INVALID");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) {
    fail("HANDLER_CONTRACT_INVALID");
  }
  assertResponseSafe(result);
  return deepFreeze(JSON.parse(serialized));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function responseObject(value, allowed, required = []) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in value))
  ) {
    fail("HANDLER_CONTRACT_INVALID");
  }
  return value;
}

function responseBoolean(value) {
  if (typeof value !== "boolean") fail("HANDLER_CONTRACT_INVALID");
}

function responseInteger(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("HANDLER_CONTRACT_INVALID");
  }
}

function responseText(value, max, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("HANDLER_CONTRACT_INVALID");
  }
}

function responseRecords(value, max, allowed) {
  if (!Array.isArray(value) || value.length > max) {
    fail("HANDLER_CONTRACT_INVALID");
  }
  for (const row of value) responseObject(row, allowed);
}

function responseHttpsUrl(value, allowedOrigins) {
  responseText(value, 2_048);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("HANDLER_CONTRACT_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !allowedOrigins.has(url.origin)
  ) {
    fail("HANDLER_CONTRACT_INVALID");
  }
}

function validateProductMap(value) {
  responseObject(value, PLAID_DATA_PRODUCTS);
  for (const available of Object.values(value)) responseBoolean(available);
}

function validateFetchErrors(value) {
  responseObject(value, PLAID_DATA_PRODUCTS);
  for (const error of Object.values(value)) {
    responseObject(error, ["error", "error_code"], ["error", "error_code"]);
    responseText(error.error, 1_024);
    responseText(error.error_code, 128, { nullable: true });
  }
}

function projectCandidateResult(slug, result, allowedResponseOrigins) {
  const safe = normalizeResult(result);
  if (slug === "plaid-data-webhook") {
    responseObject(safe, ["accepted", "queued_products"], [
      "accepted",
      "queued_products",
    ]);
    responseBoolean(safe.accepted);
    responseInteger(safe.queued_products, 0, PLAID_DATA_PRODUCTS.length);
  } else if (slug === "plaid-diagnostics-log") {
    responseObject(safe, ["accepted"], ["accepted"]);
    responseBoolean(safe.accepted);
  } else if (slug === "fund-payment-status") {
    responseObject(safe, ["success", "latest_request", "payments", "reviews"], [
      "success",
      "latest_request",
      "payments",
      "reviews",
    ]);
    responseBoolean(safe.success);
    if (safe.latest_request !== null) {
      responseObject(safe.latest_request, [
        "id",
        "request_reference",
        "selected_fund",
        "class_a_units",
        "class_b_units",
        "class_c_units",
        "commitment_amount",
        "first_payment_amount",
        "recurring_selected",
        "recurring_amount",
        "recurring_frequency",
        "recurring_day_of_month",
        "status",
        "expires_at",
        "paid_at",
        "verified_at",
        "rejected_at",
        "risk_flags",
        "plaid_match_confidence",
        "created_at",
      ]);
    }
    responseRecords(safe.payments, 10, [
      "id",
      "amount_cents",
      "currency",
      "payment_kind",
      "status",
      "paid_at",
      "failed_at",
      "refunded_at",
      "disputed_at",
    ]);
    responseRecords(safe.reviews, 5, [
      "id",
      "status",
      "flags",
      "notes",
      "reviewed_at",
      "created_at",
    ]);
  } else if (slug === "create-link-token") {
    responseObject(safe, ["link_token", "expiration"], [
      "link_token",
      "expiration",
    ]);
    responseText(safe.link_token, 4_096);
    responseText(safe.expiration, 64);
  } else if (slug === "exchange-public-token") {
    responseObject(safe, ["item_id", "institution", "accounts"], [
      "item_id",
      "institution",
      "accounts",
    ]);
    responseText(safe.item_id, 256);
    responseObject(safe.institution, ["id", "name"], ["id", "name"]);
    responseRecords(safe.accounts, 32, [
      "account_id",
      "name",
      "official_name",
      "mask",
      "type",
      "subtype",
    ]);
  } else if (slug === "plaid-data-sync-start") {
    responseObject(
      safe,
      [
        "status",
        "item_id",
        "institution",
        "available_products",
        "products_available",
        "fetch_errors",
        "can_proceed",
        "sync_in_progress",
        "background_products",
        "background_sync_started",
      ],
      ["status", "available_products", "products_available", "can_proceed"],
    );
    responseText(safe.status, 32);
    validateProductMap(safe.available_products);
    responseInteger(safe.products_available, 0, PLAID_DATA_PRODUCTS.length);
    responseBoolean(safe.can_proceed);
    if (safe.fetch_errors !== undefined) validateFetchErrors(safe.fetch_errors);
    if (safe.background_products !== undefined) {
      if (
        !Array.isArray(safe.background_products) ||
        safe.background_products.length > PLAID_DATA_PRODUCTS.length ||
        safe.background_products.some(
          (product) => !PLAID_DATA_PRODUCTS.includes(product),
        )
      ) {
        fail("HANDLER_CONTRACT_INVALID");
      }
    }
    for (const field of ["sync_in_progress", "background_sync_started"]) {
      if (safe[field] !== undefined) responseBoolean(safe[field]);
    }
  } else if (slug === "fund-coupon-redeem") {
    responseObject(
      safe,
      [
        "success",
        "already_redeemed",
        "payment_request_id",
        "request_reference",
        "status",
        "manual_verification_status",
        "coins_awarded",
      ],
      ["success", "already_redeemed", "status", "coins_awarded"],
    );
    responseBoolean(safe.success);
    responseBoolean(safe.already_redeemed);
    responseInteger(safe.coins_awarded, 0, 10_000_000);
  } else if (slug === "fund-payment-request-create") {
    responseObject(
      safe,
      [
        "success",
        "reused",
        "payment_request_id",
        "request_reference",
        "payment_url",
        "expires_at",
        "status",
        "manual_verification_status",
        "recurring_selected",
        "risk_flags",
        "email_sent",
      ],
      [
        "success",
        "reused",
        "payment_request_id",
        "request_reference",
        "payment_url",
        "status",
      ],
    );
    responseBoolean(safe.success);
    responseBoolean(safe.reused);
    responseHttpsUrl(safe.payment_url, allowedResponseOrigins);
    if (safe.risk_flags !== undefined) {
      if (!Array.isArray(safe.risk_flags) || safe.risk_flags.length > 32) {
        fail("HANDLER_CONTRACT_INVALID");
      }
      for (const flag of safe.risk_flags) responseText(flag, 128);
    }
    for (const field of ["recurring_selected", "email_sent"]) {
      if (safe[field] !== undefined) responseBoolean(safe[field]);
    }
  } else {
    fail("HANDLER_CONTRACT_INVALID");
  }
  return safe;
}

async function runFenced({
  operationLedger,
  operations,
  slug,
  actorUid,
  key,
  payload,
  signal,
  execute,
  allowedResponseOrigins,
}) {
  const ledger = requireLedger(operationLedger);
  requireOperations(operations);
  const payloadHash = sha256(Buffer.from(stableJson(payload), "utf8"));
  const operationKeyHash = sha256(
    Buffer.from(stableJson([1, slug, actorUid, key]), "utf8"),
  );
  throwIfAborted(signal);
  let receipt;
  try {
    receipt = await ledger.run(
      Object.freeze({
        schemaVersion: 1,
        scope: slug,
        operationKeyHash,
        payloadHash,
        actorUidHash: sha256(Buffer.from(actorUid, "utf8")),
        signal,
      }),
      async (context) => {
        throwIfAborted(signal);
        const fenced = validateTransaction(context);
        const result = await execute(fenced);
        throwIfAborted(signal);
        return projectCandidateResult(slug, result, allowedResponseOrigins);
      },
    );
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    fail("OPERATION_LEDGER_UNAVAILABLE");
  }
  throwIfAborted(signal);
  if (
    !receipt ||
    receipt.state !== "COMPLETED" ||
    receipt.payloadHash !== payloadHash ||
    receipt.operationKeyHash !== operationKeyHash ||
    receipt.resultProtection !== RESULT_PROTECTION ||
    typeof receipt.replayed !== "boolean"
  ) {
    fail("OPERATION_LEDGER_UNAVAILABLE");
  }
  return json(
    200,
    projectCandidateResult(slug, receipt.result, allowedResponseOrigins),
  );
}

function sanitizeUrl(value) {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 2_048);
  } catch {
    return value.slice(0, 2_048);
  }
}

function sanitizeDiagnosticText(value) {
  const sanitized = sanitizeUrl(value).slice(0, 2_048);
  return SENSITIVE_DIAGNOSTIC_VALUE.test(sanitized)
    ? "[redacted]"
    : sanitized;
}

function sanitizeDiagnostic(value, state, depth = 0, key = "") {
  if (SENSITIVE_DIAGNOSTIC_KEY.test(key)) return "[redacted]";
  if (depth > MAX_DIAGNOSTIC_DEPTH || state.keys > MAX_DIAGNOSTIC_KEYS) {
    return "[truncated]";
  }
  if (value === null || ["boolean", "number"].includes(typeof value)) return value;
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => sanitizeDiagnostic(item, state, depth + 1));
  }
  if (!value || typeof value !== "object") return null;
  const output = Object.create(null);
  for (const [childKey, child] of Object.entries(value).slice(0, 64)) {
    state.keys += 1;
    output[childKey.slice(0, 128)] = sanitizeDiagnostic(
      child,
      state,
      depth + 1,
      childKey,
    );
  }
  return output;
}

function boundedDiagnostic(value) {
  const sanitized = sanitizeDiagnostic(value ?? {}, { keys: 0 });
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_DIAGNOSTIC_FIELD_BYTES) {
    return sanitized;
  }
  return Object.freeze({ truncated: true, sha256: sha256(Buffer.from(serialized, "utf8")) });
}

function parseWebhook(request, actor, webhookClaim) {
  if (
    actor?.kind !== "provider-webhook" ||
    actor.provider !== "plaid" ||
    !HASH_PATTERN.test(String(actor.eventId ?? "")) ||
    !HASH_PATTERN.test(String(actor.eventKeyHash ?? ""))
  ) {
    fail("WEBHOOK_SIGNATURE_INVALID", "Webhook rejected.", 401);
  }
  if (!Buffer.isBuffer(request?.rawBody) || request.rawBody.length < 2) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  const requestSearch = String(request.route?.search ?? request.search ?? "");
  if (
    (requestSearch && requestSearch !== "?") ||
    request.headers?.["x-webhook-secret"] !== undefined ||
    request.headers?.["x-plaid-webhook-secret"] !== undefined
  ) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  if (request.rawBody.length > MAX_WEBHOOK_BYTES) {
    fail("PAYLOAD_TOO_LARGE", "Request is too large.", 413);
  }
  const payloadHash = sha256(request.rawBody);
  if (
    actor.eventId !== payloadHash ||
    !webhookClaim ||
    webhookClaim.payloadHash !== payloadHash ||
    webhookClaim.eventKeyHash !== actor.eventKeyHash ||
    !HASH_PATTERN.test(String(webhookClaim.eventKeyHash ?? "")) ||
    !FENCE_TOKEN_PATTERN.test(String(webhookClaim.claimToken ?? ""))
  ) {
    fail("WEBHOOK_REPLAY_CONFLICT", "Webhook rejected.", 409);
  }
  let body;
  try {
    body = JSON.parse(request.rawBody.toString("utf8"));
  } catch {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) =>
      /secret|authorization|credential|password|cookie|(?:access|public|refresh|service)[\s_-]*token/i.test(
        key,
      ),
    )
  ) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  const event = {
    webhook_type: boundedText(body.webhook_type, 64, { required: true }),
    webhook_code: boundedText(body.webhook_code, 128, { required: true }),
  };
  const itemId = boundedText(
    aliasedValue(body, ["item_id", "plaid_item_id"]),
    256,
  );
  const product = boundedText(body.product, 64);
  const environment = boundedText(body.environment, 32);
  if (itemId) event.item_id = itemId;
  if (product) event.product = product;
  if (environment) event.environment = environment;
  if (body.new_transactions !== undefined) {
    if (
      !Number.isSafeInteger(body.new_transactions) ||
      body.new_transactions < 0 ||
      body.new_transactions > 10_000_000
    ) {
      fail("INVALID_REQUEST", "Invalid request.", 400);
    }
    event.new_transactions = body.new_transactions;
  }
  if (body.error !== undefined && body.error !== null) {
    if (!body.error || typeof body.error !== "object" || Array.isArray(body.error)) {
      fail("INVALID_REQUEST", "Invalid request.", 400);
    }
    const errorCode = boundedText(body.error.error_code, 128);
    if (errorCode) event.error_code = errorCode;
  }
  return Object.freeze({ body: Object.freeze(event), payloadHash });
}

function accountSelection(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    fail("INVALID_REQUEST", "Invalid request.", 400);
  }
  return value.map((row) => {
    exactObject(row, ["id", "account_id", "name", "mask", "subtype", "type"]);
    const accountId = boundedText(aliasedValue(row, ["id", "account_id"]), 256, {
      required: true,
    });
    return Object.freeze({
      accountId,
      name: boundedText(row.name, 256),
      mask: boundedText(row.mask, 8),
      subtype: boundedText(row.subtype, 64),
      type: boundedText(row.type, 64),
    });
  });
}

export function createPlaidPaymentCandidateHandlers({
  operationLedger,
  operations,
  allowedRedirectOrigins = [],
  allowedGoogleServiceCallers = [],
  approvedSourceEvidence,
} = {}) {
  const redirectOrigins = new Set(allowedRedirectOrigins);
  const googleServiceCallers = new Set(
    allowedGoogleServiceCallers.map((value) => String(value).trim().toLowerCase()),
  );
  const runCandidate = (input) =>
    runFenced({ ...input, allowedResponseOrigins: redirectOrigins });
  const invoke = (slug, handler) => async (context) => {
    requireEvidence(approvedSourceEvidence, slug);
    throwIfAborted(context?.signal);
    return handler(context);
  };

  return Object.freeze({
    "plaid-data-webhook": invoke("plaid-data-webhook", async (context) => {
      const { body, payloadHash } = parseWebhook(
        context.request,
        context.actor,
        context.webhookClaim,
      );
      return runCandidate({
        operationLedger,
        operations,
        slug: "plaid-data-webhook",
        actorUid: `plaid:${context.actor.eventId}`,
        key: context.actor.eventId,
        payload: { payloadHash, eventKeyHash: context.webhookClaim.eventKeyHash },
        signal: context.signal,
        execute: ({ fenceToken, transaction }) =>
          operations.processPlaidWebhook({
            eventId: context.actor.eventId,
            eventKeyHash: context.webhookClaim.eventKeyHash,
            payloadHash,
            event: body,
            outerFenceToken: context.webhookClaim.claimToken,
            fenceToken,
            transaction,
            signal: context.signal,
          }),
      });
    }),

    "plaid-diagnostics-log": invoke("plaid-diagnostics-log", async (context) => {
      const body = exactObject(
        requestBody(context.request),
        [
          "session_id",
          "user_id",
          "event_type",
          "plaid_step",
          "page_state",
          "plaid_metadata",
          "error_details",
          "browser_context",
        ],
        ["event_type"],
      );
      const claimedUid = boundedText(body.user_id, 128);
      const expectedUid =
        claimedUid ?? (context.actor?.kind === "firebase" ? context.actor.uid : null);
      const actor = requireUserActor(
        context.actor,
        expectedUid,
        googleServiceCallers,
      );
      const payload = Object.freeze({
        sessionId:
          body.session_id === undefined || body.session_id === null
            ? null
            : UUID_PATTERN.test(String(body.session_id))
              ? String(body.session_id)
              : fail("INVALID_REQUEST", "Invalid request.", 400),
        eventType: boundedText(body.event_type, 64, { required: true }),
        plaidStep: boundedText(body.plaid_step, 32),
        pageState: boundedDiagnostic(body.page_state),
        plaidMetadata: boundedDiagnostic(body.plaid_metadata),
        errorDetails: boundedDiagnostic(body.error_details),
        browserContext: boundedDiagnostic(body.browser_context),
      });
      return runCandidate({
        operationLedger,
        operations,
        slug: "plaid-diagnostics-log",
        actorUid: actor.uid,
        key: idempotencyKey(context.request),
        payload,
        signal: context.signal,
        execute: ({ fenceToken, transaction }) =>
          operations.appendPlaidDiagnostic({
            ...operationActor(actor),
            diagnostic: payload,
            fenceToken,
            transaction,
            signal: context.signal,
          }),
      });
    }),

    "fund-payment-status": invoke("fund-payment-status", async (context) => {
      const body = exactObject(requestBody(context.request), ["userId", "user_id"]);
      const uid = userId(body);
      const actor = requireUserActor(context.actor, uid, googleServiceCallers);
      requireOperations(operations);
      const result = await operations.getFundPaymentStatus({
        ...operationActor(actor),
        signal: context.signal,
      });
      throwIfAborted(context.signal);
      return json(
        200,
        projectCandidateResult("fund-payment-status", result, redirectOrigins),
      );
    }),

    "create-link-token": invoke("create-link-token", async (context) => {
      const body = exactObject(
        requestBody(context.request),
        ["userId", "user_id", "userEmail", "redirectUri", "receivedRedirectUri"],
      );
      const uid = userId(body);
      const actor = requireUserActor(context.actor, uid, googleServiceCallers);
      const requestedEmail = email(body.userEmail);
      const verifiedEmail = email(actor.email);
      if (requestedEmail && requestedEmail !== verifiedEmail) {
        fail("ACCESS_DENIED", "Access denied.", 403);
      }
      const payload = Object.freeze({
        userId: uid,
        userEmail: verifiedEmail,
        redirectUri: safeRedirect(body.redirectUri, redirectOrigins),
        receivedRedirectUri: safeRedirect(body.receivedRedirectUri, redirectOrigins),
      });
      return runCandidate({
        operationLedger,
        operations,
        slug: "create-link-token",
        actorUid: actor.uid,
        key: idempotencyKey(context.request),
        payload,
        signal: context.signal,
        execute: ({ fenceToken, transaction }) =>
          operations.createLinkToken({
            ...payload,
            ...operationActor(actor),
            fenceToken,
            transaction,
            signal: context.signal,
          }),
      });
    }),

    "exchange-public-token": invoke("exchange-public-token", async (context) => {
      const body = exactObject(
        requestBody(context.request),
        [
          "publicToken",
          "public_token",
          "userId",
          "user_id",
          "institutionName",
          "institution_name",
          "institutionId",
          "institution_id",
          "accounts",
        ],
      );
      const uid = userId(body);
      const actor = requireUserActor(context.actor, uid, googleServiceCallers);
      const payload = Object.freeze({
        publicToken: boundedText(
          aliasedValue(body, ["publicToken", "public_token"]),
          1_024,
          { required: true },
        ),
        userId: uid,
        institutionName: boundedText(
          aliasedValue(body, ["institutionName", "institution_name"]),
          256,
        ),
        institutionId: boundedText(
          aliasedValue(body, ["institutionId", "institution_id"]),
          128,
        ),
        accounts: accountSelection(body.accounts),
      });
      return runCandidate({
        operationLedger,
        operations,
        slug: "exchange-public-token",
        actorUid: actor.uid,
        key: idempotencyKey(context.request),
        payload,
        signal: context.signal,
        execute: ({ fenceToken, transaction }) =>
          operations.exchangePublicToken({
            ...payload,
            ...operationActor(actor),
            fenceToken,
            transaction,
            signal: context.signal,
          }),
      });
    }),

    "plaid-data-sync-start": invoke("plaid-data-sync-start", async (context) => {
      const body = exactObject(
        requestBody(context.request),
        ["userId", "user_id", "itemId", "item_id", "plaid_item_id"],
      );
      const uid = userId(body);
      const actor = requireUserActor(context.actor, uid, googleServiceCallers);
      const payload = Object.freeze({
        userId: uid,
        itemId: boundedText(
          aliasedValue(body, ["itemId", "item_id", "plaid_item_id"]),
          256,
        ),
      });
      return runCandidate({
        operationLedger,
        operations,
        slug: "plaid-data-sync-start",
        actorUid: actor.uid,
        key: idempotencyKey(context.request),
        payload,
        signal: context.signal,
        execute: ({ fenceToken, transaction }) =>
          operations.startPlaidDataSync({
            ...payload,
            ...operationActor(actor),
            fenceToken,
            transaction,
            signal: context.signal,
          }),
      });
    }),

    "fund-coupon-redeem": invoke("fund-coupon-redeem", async (context) => {
      const body = exactObject(
        requestBody(context.request),
        ["userId", "user_id", "couponCode", "coupon_code"],
      );
      const uid = userId(body);
      const actor = requireUserActor(context.actor, uid, googleServiceCallers);
      const payload = Object.freeze({
        userId: uid,
        couponCode: boundedText(
          aliasedValue(body, ["couponCode", "coupon_code"]),
          128,
          { required: true },
        ).toLowerCase(),
      });
      return runCandidate({
        operationLedger,
        operations,
        slug: "fund-coupon-redeem",
        actorUid: actor.uid,
        key: idempotencyKey(context.request),
        payload,
        signal: context.signal,
        execute: ({ fenceToken, transaction }) =>
          operations.redeemFundCoupon({
            ...payload,
            ...operationActor(actor),
            fenceToken,
            transaction,
            signal: context.signal,
          }),
      });
    }),

    "fund-payment-request-create": invoke(
      "fund-payment-request-create",
      async (context) => {
        const body = exactObject(
          requestBody(context.request),
          [
            "userId",
            "user_id",
            "firstPaymentAmount",
            "first_payment_amount",
            "amount",
          ],
        );
        const uid = userId(body);
        const actor = requireUserActor(context.actor, uid, googleServiceCallers);
        const firstPaymentCents = usdCents(
          aliasedValue(body, [
            "firstPaymentAmount",
            "first_payment_amount",
            "amount",
          ]),
        );
        const payload = Object.freeze({ userId: uid, firstPaymentCents });
        return runCandidate({
          operationLedger,
          operations,
          slug: "fund-payment-request-create",
          actorUid: actor.uid,
          key: idempotencyKey(context.request),
          payload,
          signal: context.signal,
          execute: ({ fenceToken, transaction }) =>
            operations.createFundPaymentRequest({
              ...payload,
              ...operationActor(actor),
              fenceToken,
              transaction,
              signal: context.signal,
            }),
        });
      },
    ),
  });
}

export const PLAID_PAYMENT_LEDGER_CONTRACT = Object.freeze({
  durability: OPERATION_LEDGER_DURABILITY,
  transactionDurability: TRANSACTION_DURABILITY,
  resultProtection: RESULT_PROTECTION,
  rawPayloadPersistence: "forbidden",
  rawCredentialPersistence: "forbidden",
  uniqueClaim: "scope_actor_uid_hash_operation_key_hash",
  conflict: "same_key_different_payload_returns_409",
  replay: "same_key_same_payload_returns_kms_sealed_prior_result",
  fencing: "monotonic_fence_token_required_for_every_write",
});
