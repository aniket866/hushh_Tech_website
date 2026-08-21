import {
  createCipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createHushhResearchHandler } from "../api/hushh-research-client.js";
import { canonicalHushhResearchJson } from "../api/shared/hushhResearchCrypto.js";
import {
  createHushhResearchExportReplayStore,
  HushhResearchReplayStoreError,
} from "../api/shared/hushhResearchReplayStore.js";

const UID = "hushh-tech-uat-synthetic-ada-001";
const APP_ID = "app_hushh-technologies_cd1895ef";
const KEY_ID = "hushh-tech-uat-x25519-1";
const SCOPE = "attr.identity.name";
const NOW = 1_787_000_000_000;

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: Buffer) {
  return `sha256:${sha256(value)}`;
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
    recipient_key_fingerprint: digest(connectorPublicRaw),
    payload_algorithm: "AES-256-GCM",
    expires_at_ms: NOW + 600_000,
  };
  const plaintext = Buffer.from(
    JSON.stringify({ profile: { displayName: "Synthetic Ada" } }),
    "utf8",
  );
  const exportKey = randomBytes(32);
  const payloadIv = randomBytes(12);
  const aadBytes = Buffer.from(canonicalHushhResearchJson(aad), "utf8");
  const payload = encryptAesGcm(exportKey, plaintext, payloadIv, aadBytes);
  const envelope = {
    version: 2,
    export_id: aad.export_id,
    aad,
    aad_sha256: digest(aadBytes),
    ciphertext_sha256: digest(payload.ciphertext),
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
    Buffer.from(canonicalHushhResearchJson(envelope), "utf8"),
  );

  return {
    connectorPrivateKey: connector.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    scopedExport: {
      status: "success",
      user_id: UID,
      app_id: APP_ID,
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
    },
  };
}

function enabledEnv(connectorPrivateKey = "test-connector-private-key") {
  return {
    NODE_ENV: "staging",
    GOOGLE_CLOUD_PROJECT: "hushh-tech-uat",
    HUSHH_RESEARCH_CLIENT_ENABLED: "true",
    HUSHH_RESEARCH_API_BASE_URL: "https://api.uat.hushh.ai",
    HUSHH_RESEARCH_WEB_BASE_URL: "https://uat.one.hushh.ai",
    HUSHH_RESEARCH_AUDIENCE: "hushh-tech-uat",
    HUSHH_RESEARCH_REDIRECT_URI:
      "https://uat.hushhtech.com/auth/hushh-research/callback",
    HUSHH_RESEARCH_FIREBASE_PROJECT_ID: "hushh-pda",
    HUSHH_RESEARCH_FIREBASE_AUTH_DOMAIN: "hushh-pda.firebaseapp.com",
    HUSHH_RESEARCH_FIREBASE_API_KEY: "public-firebase-api-key",
    HUSHH_RESEARCH_FIREBASE_APP_ID: "1:123:web:abc",
    HUSHH_RESEARCH_DEVELOPER_APP_ID: APP_ID,
    HUSHH_RESEARCH_DEVELOPER_TOKEN: `uat-developer-${"x".repeat(48)}`,
    HUSHH_RESEARCH_CONNECTOR_PRIVATE_KEY: connectorPrivateKey,
    HUSHH_RESEARCH_UAT_FIREBASE_UID_ALLOWLIST:
      `${UID},hushh-tech-uat-synthetic-grace-001`,
  };
}

function response(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => payload,
  };
}

function request() {
  return {
    path: "/api/hushh-research/export/decrypt",
    method: "POST",
    body: { scope: SCOPE },
    query: {},
    headers: { authorization: "Bearer firebase-id-token" },
  };
}

function handlerResponse() {
  let statusCode = 200;
  let body: Record<string, unknown> = {};
  return {
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload as Record<string, unknown>;
      return this;
    },
    setHeader: vi.fn(),
  };
}

function researchUpstream(scopedExport: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    if (url.includes("/api/v1/consent-status?")) {
      return response({
        status: "granted",
        user_id: UID,
        app_id: APP_ID,
        scope: SCOPE,
        consent_token: "consent-token-never-returned",
      });
    }
    if (url.endsWith("/api/v1/scoped-export")) return response(scopedExport);
    throw new Error(`Unexpected Research URL: ${url}`);
  });
}

const verifiedActor = async (idToken: string) => ({
  uid: UID,
  authTime: 1_787_000_000,
  idToken,
});

describe("Hushh Research durable export replay store", () => {
  it("atomically consumes once across separate store and handler instances", async () => {
    const { connectorPrivateKey, scopedExport } = encryptedFixture();
    const env = enabledEnv(connectorPrivateKey);
    const documents = new Set<string>();
    const ledgerBodies: string[] = [];
    const firestore = vi.fn(async (url: string, options: RequestInit) => {
      const parsed = new URL(url);
      const documentId = parsed.searchParams.get("documentId")!;
      ledgerBodies.push(String(options.body));
      if (documents.has(documentId)) return response({}, 409);
      documents.add(documentId);
      return response({ name: `consumptions/${documentId}` });
    });
    const makeStore = () =>
      createHushhResearchExportReplayStore({
        env,
        fetchImpl: firestore,
        getAccessToken: async () => "adc-access-token",
      });
    const makeHandler = () =>
      createHushhResearchHandler({
        env,
        fetchImpl: researchUpstream(scopedExport),
        verifyFirebase: verifiedActor,
        replayStore: makeStore(),
        now: () => NOW,
      });

    const first = handlerResponse();
    await makeHandler()(request(), first);
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({
      state: "READY",
      data: { profile: { displayName: "Synthetic Ada" } },
    });

    const replay = handlerResponse();
    await makeHandler()(request(), replay);
    expect(replay.statusCode).toBe(409);
    expect(replay.body).toMatchObject({ state: "STALE_SHADOW" });
    expect(JSON.stringify(replay.body)).not.toContain("Synthetic Ada");
    expect(documents.size).toBe(1);

    const [firestoreUrl, firestoreOptions] = firestore.mock.calls[0];
    const expectedReplayHash = sha256(
      JSON.stringify([
        UID,
        scopedExport.export_envelope.export_id,
        scopedExport.export_envelope.aad.revision,
        scopedExport.export_envelope.ciphertext_sha256,
      ]),
    );
    expect(firestoreUrl).toMatch(
      /^https:\/\/firestore\.googleapis\.com\/v1\/projects\/hushh-tech-uat\/databases\/\(default\)\/documents\/hushh_research_export_consumptions\?documentId=[a-f0-9]{64}$/,
    );
    expect(new URL(firestoreUrl).searchParams.get("documentId")).toBe(
      expectedReplayHash,
    );
    expect(firestoreOptions).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer adc-access-token",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(ledgerBodies[0])).toEqual({
      fields: {
        replay_key_sha256: { stringValue: expectedReplayHash },
        consumed_at: { timestampValue: new Date(NOW).toISOString() },
        expires_at: {
          timestampValue: new Date(NOW + 600_000).toISOString(),
        },
      },
    });
    expect(ledgerBodies[0]).not.toContain(UID);
    expect(ledgerBodies[0]).not.toContain("consent-token-never-returned");
    expect(ledgerBodies[0]).not.toContain("Synthetic Ada");
    expect(ledgerBodies[0]).not.toContain(
      "export_hushh_tech_uat_000000000001",
    );
  });

  it.each([
    {
      name: "ADC authentication",
      getAccessToken: async () => {
        throw new Error("ADC unavailable");
      },
      fetchImpl: vi.fn(),
    },
    {
      name: "network",
      getAccessToken: async () => "adc-access-token",
      fetchImpl: async () => {
        throw new Error("network unavailable");
      },
    },
    {
      name: "non-conflict Firestore response",
      getAccessToken: async () => "adc-access-token",
      fetchImpl: async () => response({}, 503),
    },
  ])("fails closed when $name is unavailable", async ({ getAccessToken, fetchImpl }) => {
    const store = createHushhResearchExportReplayStore({
      env: enabledEnv(),
      getAccessToken,
      fetchImpl,
    });

    await expect(
      store.consume(`sensitive:${UID}:export-id`, NOW + 60_000, NOW),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "HushhResearchReplayStoreError",
        code: "replay_store_unavailable",
      }),
    );
  });

  it("does not return decrypted plaintext when the durable store is unavailable", async () => {
    const { connectorPrivateKey, scopedExport } = encryptedFixture();
    const env = enabledEnv(connectorPrivateKey);
    const store = createHushhResearchExportReplayStore({
      env,
      getAccessToken: async () => {
        throw new Error("ADC unavailable");
      },
      fetchImpl: vi.fn(),
    });
    const handler = createHushhResearchHandler({
      env,
      fetchImpl: researchUpstream(scopedExport),
      verifyFirebase: verifiedActor,
      replayStore: store,
      now: () => NOW,
    });
    const res = handlerResponse();

    await handler(request(), res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ state: "UPSTREAM_UNAVAILABLE" });
    expect(JSON.stringify(res.body)).not.toContain("Synthetic Ada");
    expect(JSON.stringify(res.body)).not.toContain("consent-token-never-returned");
  });

  it("refuses non-UAT and production runtimes before calling Firestore", async () => {
    const fetchImpl = vi.fn();
    const getAccessToken = vi.fn();
    for (const env of [
      { ...enabledEnv(), GOOGLE_CLOUD_PROJECT: "another-project" },
      { ...enabledEnv(), NODE_ENV: "production" },
    ]) {
      const store = createHushhResearchExportReplayStore({
        env,
        fetchImpl,
        getAccessToken,
      });
      await expect(
        store.consume("replay-key", NOW + 60_000, NOW),
      ).rejects.toBeInstanceOf(HushhResearchReplayStoreError);
    }
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
