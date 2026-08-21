import {
  createCipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  canonicalHushhResearchJson,
  decryptHushhResearchExport,
  HushhResearchCryptoError,
  HushhResearchExportReplayGuard,
} from "../api/shared/hushhResearchCrypto.js";

const UID = "hushh-tech-uat-synthetic-ada-001";
const APP_ID = "app_hushh-technologies_cd1895ef";
const KEY_ID = "hushh-tech-uat-x25519-1";
const SCOPE = "attr.identity.name";
const NOW = 1_787_000_000_000;

function sha256(value: Buffer) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function rawPublicKey(key: ReturnType<typeof createPublicKey>) {
  return Buffer.from(key.export({ format: "der", type: "spki" })).subarray(-32);
}

function encryptAesGcm(key: Buffer, plaintext: Buffer, iv: Buffer, aad: Buffer) {
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  return {
    ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
    tag: cipher.getAuthTag(),
  };
}

function encryptedFixture() {
  const connector = generateKeyPairSync("x25519");
  const sender = generateKeyPairSync("x25519");
  const connectorPublicRaw = rawPublicKey(connector.publicKey);
  const senderPublicRaw = rawPublicKey(sender.publicKey);
  const aad = {
    version: 2,
    app_id: APP_ID,
    grant_id: "grant_hushh_tech_uat_001",
    export_id: "export_hushh_tech_uat_000000000001",
    revision: 1,
    machine_scope: SCOPE,
    scope_handle: "scope_profile_basic",
    recipient_key_fingerprint: sha256(connectorPublicRaw),
    payload_algorithm: "AES-256-GCM",
    expires_at_ms: NOW + 600_000,
  };
  const plaintext = Buffer.from(
    JSON.stringify({ profile: { displayName: "Synthetic Ada" } }),
    "utf8"
  );
  const exportKey = randomBytes(32);
  const payloadIv = randomBytes(12);
  const payload = encryptAesGcm(
    exportKey,
    plaintext,
    payloadIv,
    Buffer.from(canonicalHushhResearchJson(aad), "utf8")
  );
  const envelope = {
    version: 2,
    export_id: aad.export_id,
    aad,
    aad_sha256: sha256(Buffer.from(canonicalHushhResearchJson(aad), "utf8")),
    ciphertext_sha256: sha256(payload.ciphertext),
    ciphertext_bytes: payload.ciphertext.length,
  };
  const sharedSecret = diffieHellman({
    privateKey: sender.privateKey,
    publicKey: connector.publicKey,
  });
  const wrappingKey = createHash("sha256").update(sharedSecret).digest();
  const wrappingIv = randomBytes(12);
  const wrapped = encryptAesGcm(
    wrappingKey,
    exportKey,
    wrappingIv,
    Buffer.from(canonicalHushhResearchJson(envelope), "utf8")
  );
  const scopedExport = {
    status: "success",
    user_id: UID,
    consent_token: "consent-token-never-returned",
    granted_scope: SCOPE,
    expected_scope: SCOPE,
    coverage_kind: "exact",
    expires_at: aad.expires_at_ms,
    export_revision: 1,
    encrypted_data: payload.ciphertext.toString("base64"),
    iv: payloadIv.toString("base64"),
    tag: payload.tag.toString("base64"),
    wrapped_key_bundle: {
      wrapped_export_key: wrapped.ciphertext.toString("base64"),
      wrapped_key_iv: wrappingIv.toString("base64"),
      wrapped_key_tag: wrapped.tag.toString("base64"),
      sender_public_key: senderPublicRaw.toString("base64"),
      wrapping_alg: "X25519-AES256-GCM",
      connector_key_id: KEY_ID,
    },
    export_envelope: envelope,
    maximum_raw_bytes: 1_000_000,
  };
  const config = {
    developerAppId: APP_ID,
    connectorKeyId: KEY_ID,
    connectorPrivateKey: connector.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  };
  return { scopedExport, config };
}

describe("Hushh Research connector decrypt", () => {
  it("authenticates both envelope AAD layers before returning JSON", () => {
    const { scopedExport, config } = encryptedFixture();
    const decrypted = decryptHushhResearchExport(
      scopedExport,
      config,
      { uid: UID, scope: SCOPE },
      { now: () => NOW, replayGuard: new HushhResearchExportReplayGuard() }
    );

    expect(decrypted).toEqual({
      data: { profile: { displayName: "Synthetic Ada" } },
      exportId: "export_hushh_tech_uat_000000000001",
      revision: 1,
      scope: SCOPE,
      expiresAt: NOW + 600_000,
    });
  });

  it("rejects altered ciphertext, AAD, connector key, scope, and replay", () => {
    const { scopedExport, config } = encryptedFixture();
    const replayGuard = new HushhResearchExportReplayGuard();
    const decrypt = (value = scopedExport, settings = config) =>
      decryptHushhResearchExport(
        value,
        settings,
        { uid: UID, scope: SCOPE },
        { now: () => NOW, replayGuard }
      );

    decrypt();
    expect(() => decrypt()).toThrowError(
      expect.objectContaining({ code: "export_replay_detected" })
    );

    const alteredCiphertext = structuredClone(scopedExport);
    alteredCiphertext.encrypted_data = Buffer.from("altered").toString("base64");
    expect(() =>
      decryptHushhResearchExport(
        alteredCiphertext,
        config,
        { uid: UID, scope: SCOPE },
        { now: () => NOW }
      )
    ).toThrowError(HushhResearchCryptoError);

    const alteredAad = structuredClone(scopedExport);
    alteredAad.export_envelope.aad.revision = 2;
    expect(() =>
      decryptHushhResearchExport(
        alteredAad,
        config,
        { uid: UID, scope: SCOPE },
        { now: () => NOW }
      )
    ).toThrowError(HushhResearchCryptoError);

    const wrongKeyId = structuredClone(scopedExport);
    wrongKeyId.wrapped_key_bundle.connector_key_id = "another-connector";
    expect(() =>
      decryptHushhResearchExport(
        wrongKeyId,
        config,
        { uid: UID, scope: SCOPE },
        { now: () => NOW }
      )
    ).toThrowError(HushhResearchCryptoError);

    const legacySecondsExpiry = structuredClone(scopedExport);
    legacySecondsExpiry.expires_at = Math.trunc(
      scopedExport.expires_at / 1000,
    );
    expect(() =>
      decryptHushhResearchExport(
        legacySecondsExpiry,
        config,
        { uid: UID, scope: SCOPE },
        { now: () => NOW }
      )
    ).toThrowError(
      expect.objectContaining({ code: "export_expiry_mismatch" })
    );

    expect(() =>
      decryptHushhResearchExport(
        scopedExport,
        config,
        { uid: UID, scope: "another.scope" },
        { now: () => NOW }
      )
    ).toThrowError(HushhResearchCryptoError);
  });
});
