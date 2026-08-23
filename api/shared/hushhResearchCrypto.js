import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
} from "node:crypto";

const PRIVATE_KEY_DER_PREFIX = Buffer.from(
  "302e020100300506032b656e04220420",
  "hex",
);
const PUBLIC_KEY_DER_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const ENVELOPE_KEYS = [
  "aad",
  "aad_sha256",
  "ciphertext_bytes",
  "ciphertext_sha256",
  "export_id",
  "version",
];
const AAD_KEYS = [
  "app_id",
  "expires_at_ms",
  "export_id",
  "grant_id",
  "machine_scope",
  "payload_algorithm",
  "recipient_key_fingerprint",
  "revision",
  "scope_handle",
  "version",
];

export class HushhResearchCryptoError extends Error {
  constructor(code, message = "Encrypted Research data could not be verified.") {
    super(message);
    this.name = "HushhResearchCryptoError";
    this.code = code;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, code) {
  if (!isRecord(value)) throw new HushhResearchCryptoError(code);
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new HushhResearchCryptoError(code);
  }
}

function decodeBase64(value, field, expectedLength) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw) || raw.length % 4 === 1) {
    throw new HushhResearchCryptoError(`invalid_${field}`);
  }
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = Buffer.from(padded, "base64");
  if (!decoded.length || (expectedLength && decoded.length !== expectedLength)) {
    throw new HushhResearchCryptoError(`invalid_${field}`);
  }
  return decoded;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function canonicalHushhResearchJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function readPrivateKey(value) {
  const raw = String(value ?? "").trim();
  let key;
  try {
    if (raw.startsWith("-----BEGIN PRIVATE KEY-----")) {
      key = createPrivateKey(raw);
    } else {
      const decoded = decodeBase64(raw, "connector_private_key");
      const der =
        decoded.length === 32
          ? Buffer.concat([PRIVATE_KEY_DER_PREFIX, decoded])
          : decoded;
      key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    }
  } catch (error) {
    if (error instanceof HushhResearchCryptoError) throw error;
    throw new HushhResearchCryptoError("invalid_connector_private_key");
  }
  if (key.asymmetricKeyType !== "x25519") {
    throw new HushhResearchCryptoError("invalid_connector_private_key");
  }
  return key;
}

function connectorFingerprint(privateKey) {
  const publicDer = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });
  if (
    publicDer.length !== PUBLIC_KEY_DER_PREFIX.length + 32 ||
    !publicDer.subarray(0, PUBLIC_KEY_DER_PREFIX.length).equals(PUBLIC_KEY_DER_PREFIX)
  ) {
    throw new HushhResearchCryptoError("invalid_connector_public_key");
  }
  return sha256Digest(publicDer.subarray(PUBLIC_KEY_DER_PREFIX.length));
}

function decryptAesGcm({ key, iv, ciphertext, tag, aad, code }) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: 16,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new HushhResearchCryptoError(code);
  }
}

export class HushhResearchExportReplayGuard {
  constructor(maxEntries = 2048) {
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  consume(key, expiresAtMs, nowMs = Date.now()) {
    for (const [entry, expiry] of this.entries) {
      if (expiry <= nowMs) this.entries.delete(entry);
    }
    if (this.entries.has(key)) {
      throw new HushhResearchCryptoError(
        "export_replay_detected",
        "This encrypted Research export was already consumed.",
      );
    }
    while (this.entries.size >= this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    this.entries.set(key, expiresAtMs);
  }
}

function validateEnvelope(scopedExport, config, expected, nowMs) {
  const envelope = scopedExport?.export_envelope;
  const aad = envelope?.aad;
  assertExactKeys(envelope, ENVELOPE_KEYS, "invalid_export_envelope");
  assertExactKeys(aad, AAD_KEYS, "invalid_export_aad");

  if (
    envelope.version !== 2 ||
    aad.version !== 2 ||
    typeof envelope.export_id !== "string" ||
    envelope.export_id.length < 32 ||
    envelope.export_id.length > 64 ||
    aad.export_id !== envelope.export_id ||
    aad.app_id !== config.developerAppId ||
    aad.payload_algorithm !== "AES-256-GCM" ||
    !Number.isSafeInteger(aad.revision) ||
    aad.revision < 1 ||
    !Number.isSafeInteger(aad.expires_at_ms) ||
    aad.expires_at_ms <= nowMs ||
    typeof aad.grant_id !== "string" ||
    !aad.grant_id ||
    typeof aad.scope_handle !== "string" ||
    !/^(?:s|scope)_[A-Za-z0-9_-]{6,128}$/.test(aad.scope_handle) ||
    scopedExport.user_id !== expected.uid ||
    scopedExport.expected_scope !== expected.scope ||
    scopedExport.granted_scope !== expected.scope ||
    scopedExport.coverage_kind !== "exact" ||
    aad.machine_scope !== expected.scope ||
    scopedExport.export_revision !== aad.revision
  ) {
    throw new HushhResearchCryptoError("export_context_mismatch");
  }

  const aadBytes = Buffer.from(canonicalHushhResearchJson(aad), "utf8");
  if (envelope.aad_sha256 !== sha256Digest(aadBytes)) {
    throw new HushhResearchCryptoError("export_aad_digest_mismatch");
  }

  const ciphertext = decodeBase64(
    scopedExport.encrypted_data,
    "export_ciphertext",
  );
  if (
    !Number.isSafeInteger(envelope.ciphertext_bytes) ||
    envelope.ciphertext_bytes !== ciphertext.length ||
    envelope.ciphertext_sha256 !== sha256Digest(ciphertext)
  ) {
    throw new HushhResearchCryptoError("export_ciphertext_digest_mismatch");
  }
  if (
    Number.isSafeInteger(scopedExport.maximum_raw_bytes) &&
    ciphertext.length > scopedExport.maximum_raw_bytes
  ) {
    throw new HushhResearchCryptoError("export_too_large");
  }
  if (
    Number.isSafeInteger(scopedExport.expires_at) &&
    scopedExport.expires_at !== aad.expires_at_ms
  ) {
    throw new HushhResearchCryptoError("export_expiry_mismatch");
  }

  return { envelope, aad, aadBytes, ciphertext };
}

export function decryptHushhResearchExport(
  scopedExport,
  config,
  expected,
  { now = Date.now, replayGuard = null } = {},
) {
  const nowMs = now();
  const { envelope, aad, aadBytes, ciphertext } = validateEnvelope(
    scopedExport,
    config,
    expected,
    nowMs,
  );
  const bundle = scopedExport?.wrapped_key_bundle;
  if (
    !isRecord(bundle) ||
    bundle.connector_key_id !== config.connectorKeyId ||
    bundle.wrapping_alg !== "X25519-AES256-GCM"
  ) {
    throw new HushhResearchCryptoError("connector_key_mismatch");
  }

  const privateKey = readPrivateKey(config.connectorPrivateKey);
  if (aad.recipient_key_fingerprint !== connectorFingerprint(privateKey)) {
    throw new HushhResearchCryptoError("connector_fingerprint_mismatch");
  }
  const senderRaw = decodeBase64(bundle.sender_public_key, "sender_public_key", 32);
  let senderPublicKey;
  try {
    senderPublicKey = createPublicKey({
      key: Buffer.concat([PUBLIC_KEY_DER_PREFIX, senderRaw]),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new HushhResearchCryptoError("invalid_sender_public_key");
  }

  let sharedSecret;
  try {
    sharedSecret = diffieHellman({ privateKey, publicKey: senderPublicKey });
  } catch {
    throw new HushhResearchCryptoError("connector_key_exchange_failed");
  }
  const wrappingKey = createHash("sha256").update(sharedSecret).digest();
  const exportKey = decryptAesGcm({
    key: wrappingKey,
    iv: decodeBase64(bundle.wrapped_key_iv, "wrapped_key_iv", 12),
    ciphertext: decodeBase64(
      bundle.wrapped_export_key,
      "wrapped_export_key",
      32,
    ),
    tag: decodeBase64(bundle.wrapped_key_tag, "wrapped_key_tag", 16),
    aad: Buffer.from(canonicalHushhResearchJson(envelope), "utf8"),
    code: "wrapped_export_key_authentication_failed",
  });
  if (exportKey.length !== 32) {
    throw new HushhResearchCryptoError("invalid_export_key");
  }

  const plaintext = decryptAesGcm({
    key: exportKey,
    iv: decodeBase64(scopedExport.iv, "export_iv", 12),
    ciphertext,
    tag: decodeBase64(scopedExport.tag, "export_tag", 16),
    aad: aadBytes,
    code: "export_payload_authentication_failed",
  });
  let data;
  try {
    data = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new HushhResearchCryptoError("invalid_export_plaintext");
  }
  if (!isRecord(data)) {
    throw new HushhResearchCryptoError("invalid_export_plaintext");
  }

  replayGuard?.consume(
    `${expected.uid}:${envelope.export_id}:${aad.revision}:${envelope.ciphertext_sha256}`,
    aad.expires_at_ms,
    nowMs,
  );
  return {
    data,
    exportId: envelope.export_id,
    revision: aad.revision,
    scope: aad.machine_scope,
    expiresAt: aad.expires_at_ms,
  };
}
