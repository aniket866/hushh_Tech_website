import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHushhResearchHandler } from "../api/hushh-research-client.js";

const UID = "hushh-tech-uat-synthetic-ada-001";
const GRACE_UID = "hushh-tech-uat-synthetic-grace-001";
const DEVELOPER_APP_ID = "app_hushh-technologies_cd1895ef";
const LINK_ID = `htl_${"a".repeat(32)}`;
const REQUEST_ID = `req_${"b".repeat(28)}`;
const CONSENT_SCOPE = "attr.identity.name";
const DEVELOPER_TOKEN = `uat-developer-${"x".repeat(48)}`;
const { privateKey } = generateKeyPairSync("x25519");
const CONNECTOR_PRIVATE_KEY = privateKey
  .export({ format: "der", type: "pkcs8" })
  .toString("base64");

type TestBody = {
  [key: string]: unknown;
  consent_token?: string;
  enabled?: boolean;
  expires_in?: number;
  launch_url?: string;
  message?: string;
  state?: string;
};

const enabledEnv = () => ({
  NODE_ENV: "staging",
  GOOGLE_CLOUD_PROJECT: "hushh-tech-uat",
  HUSHH_RESEARCH_CLIENT_ENABLED: "true",
  HUSHH_RESEARCH_API_BASE_URL: "https://api.uat.hushh.ai",
  HUSHH_RESEARCH_WEB_BASE_URL: "https://uat.one.hushh.ai",
  HUSHH_RESEARCH_AUDIENCE: "hushh-tech-uat",
  HUSHH_RESEARCH_REDIRECT_URI:
    "https://uat.hushhtech.com/auth/hushh-research/callback",
  HUSHH_RESEARCH_FIREBASE_PROJECT_ID: "hushh-pda-uat",
  HUSHH_RESEARCH_FIREBASE_AUTH_DOMAIN: "hushh-pda-uat.firebaseapp.com",
  HUSHH_RESEARCH_FIREBASE_API_KEY: "public-firebase-api-key",
  HUSHH_RESEARCH_FIREBASE_APP_ID: "1:123:web:abc",
  HUSHH_RESEARCH_DEVELOPER_APP_ID: DEVELOPER_APP_ID,
  HUSHH_RESEARCH_DEVELOPER_TOKEN: DEVELOPER_TOKEN,
  HUSHH_RESEARCH_CONNECTOR_PRIVATE_KEY: CONNECTOR_PRIVATE_KEY,
  HUSHH_RESEARCH_UAT_FIREBASE_UID_ALLOWLIST: `${UID},${GRACE_UID}`,
});

const createResponse = () => {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let body: TestBody = {};
  return {
    headers,
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
      body = payload as TestBody;
      return this;
    },
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
  };
};

const jsonResponse = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => payload,
});

const request = (
  path: string,
  {
    method = "GET",
    body,
    cookie,
    query = {},
    token = "firebase-id-token",
  }: {
    method?: string;
    body?: unknown;
    cookie?: string;
    query?: Record<string, string>;
    token?: string;
  } = {}
) => ({
  path,
  method,
  body,
  query,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { cookie } : {}),
  },
});

const verifiedActor = async (idToken: string) => ({
  uid: UID,
  authTime: 1_787_000_000,
  idToken,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Hushh Research compatibility gateway", () => {
  it("registers the gateway before the SPA fallback", () => {
    const server = fs.readFileSync("server.js", "utf8");
    expect(server).toContain("app.all('/api/hushh-research/config'");
    expect(server).toContain("app.all('/api/hushh-research/*'");
    expect(server.indexOf("app.all('/api/hushh-research/*'")).toBeLessThan(
      server.indexOf("app.get('*'")
    );
  });

  it("returns exactly disabled and never reads Research secrets in production", async () => {
    const env = { ...enabledEnv(), NODE_ENV: "production" };
    const fetchImpl = vi.fn();
    const handler = createHushhResearchHandler({ env, fetchImpl });
    const res = createResponse();

    await handler(request("/api/hushh-research/config"), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ enabled: false });
    expect(JSON.stringify(res.body)).not.toContain(DEVELOPER_TOKEN);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires the exact UAT project and returns only public enabled config", async () => {
    const env = enabledEnv();
    const handler = createHushhResearchHandler({ env, fetchImpl: vi.fn() });
    const res = createResponse();

    await handler(request("/api/hushh-research/config"), res);

    expect(res.body).toEqual({
      enabled: true,
      firebase: {
        apiKey: "public-firebase-api-key",
        authDomain: "hushh-pda-uat.firebaseapp.com",
        projectId: "hushh-pda-uat",
        appId: "1:123:web:abc",
      },
      launch: {
        audience: "hushh-tech-uat",
        redirectUri:
          "https://uat.hushhtech.com/auth/hushh-research/callback",
        startPath: "/api/hushh-research/launch/start",
      },
    });
    expect(JSON.stringify(res.body)).not.toContain(DEVELOPER_TOKEN);

    const wrongProject = createHushhResearchHandler({
      env: { ...env, GOOGLE_CLOUD_PROJECT: "hushh-tech-website" },
      fetchImpl: vi.fn(),
    });
    const disabled = createResponse();
    await wrongProject(request("/api/hushh-research/config"), disabled);
    expect(disabled.body).toEqual({ enabled: false });

    for (const allowlist of [
      UID,
      GRACE_UID,
      `${UID},${GRACE_UID},arbitrary-third-user`,
    ]) {
      const cohortMismatch = createHushhResearchHandler({
        env: {
          ...env,
          HUSHH_RESEARCH_UAT_FIREBASE_UID_ALLOWLIST: allowlist,
        },
        fetchImpl: vi.fn(),
      });
      const cohortDisabled = createResponse();
      await cohortMismatch(
        request("/api/hushh-research/config"),
        cohortDisabled
      );
      expect(cohortDisabled.body).toEqual({ enabled: false });
    }
  });

  it("creates a strict signed 60-second PKCE launch cookie", async () => {
    const handler = createHushhResearchHandler({
      env: enabledEnv(),
      fetchImpl: vi.fn(),
      now: () => 1_787_000_000_000,
    });
    const rejected = createResponse();
    await handler(
      request("/api/hushh-research/launch/start", {
        method: "POST",
        body: {},
        token: "",
      }),
      rejected
    );
    expect(rejected.statusCode).toBe(400);

    const res = createResponse();
    await handler(
      request("/api/hushh-research/launch/start", {
        method: "POST",
        body: { source: "hushh-research" },
        token: "",
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.expires_in).toBe(60);
    const launch = new URL(res.body.launch_url!);
    expect(launch.origin).toBe("https://uat.one.hushh.ai");
    expect(launch.pathname).toBe("/products/hushh-tech/launch");
    expect(launch.searchParams.get("audience")).toBe("hushh-tech-uat");
    expect(launch.searchParams.get("redirect_uri")).toBe(
      "https://uat.hushhtech.com/auth/hushh-research/callback"
    );
    expect(launch.searchParams.get("code_challenge_method")).toBe("S256");
    expect(launch.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(launch.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    expect(res.headers.get("Set-Cookie")).toMatch(
      /^__Host-hushh_research_launch=[\w.-]+; Max-Age=60; Path=\/; HttpOnly; Secure; SameSite=Lax$/
    );
  });

  it("consumes launch state once, keeps the verifier server-side, and echoes callback state", async () => {
    const upstream = vi.fn().mockResolvedValue(
      jsonResponse({
        firebase_custom_token: "custom-token",
        expires_in: 3600,
        canonical_user_id: UID,
        audience: "hushh-tech-uat",
        state: "LINK_REQUIRED",
      })
    );
    const handler = createHushhResearchHandler({
      env: enabledEnv(),
      fetchImpl: upstream,
      now: () => 1_787_000_000_000,
    });
    const start = createResponse();
    await handler(
      request("/api/hushh-research/launch/start", {
        method: "POST",
        body: { source: "hushh-research" },
        token: "",
      }),
      start
    );
    const launchUrl = new URL(start.body.launch_url!);
    const state = launchUrl.searchParams.get("state")!;
    const cookie = start.headers.get("Set-Cookie")!.split(";")[0];
    expect(JSON.stringify(start.body)).not.toContain("verifier");

    const exchange = createResponse();
    await handler(
      request("/api/hushh-research/launch/exchange", {
        method: "POST",
        body: { code: "c".repeat(32), state, source: "hushh-research" },
        cookie,
        token: "",
      }),
      exchange
    );

    expect(exchange.statusCode).toBe(200);
    expect(exchange.body).toEqual({
      firebase_custom_token: "custom-token",
      expires_in: 3600,
      canonical_user_id: UID,
      audience: "hushh-tech-uat",
      state,
      link_state: "LINK_REQUIRED",
    });
    expect(exchange.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const [url, options] = upstream.mock.calls[0];
    expect(url).toBe(
      "https://api.uat.hushh.ai/api/v1/products/hushh-tech/launch/exchange"
    );
    const sent = JSON.parse(options.body);
    expect(sent).toMatchObject({
      code: "c".repeat(32),
      audience: "hushh-tech-uat",
      redirect_uri:
        "https://uat.hushhtech.com/auth/hushh-research/callback",
    });
    expect(sent.verifier).toMatch(/^[\w-]{43}$/);
    expect(options.headers["X-Hushh-Developer-Token"]).toBeUndefined();

    const replay = createResponse();
    await handler(
      request("/api/hushh-research/launch/exchange", {
        method: "POST",
        body: { code: "d".repeat(32), state, source: "hushh-research" },
        cookie,
        token: "",
      }),
      replay
    );
    expect(replay.statusCode).toBe(401);
    expect(replay.body.state).toBe("UNAUTHENTICATED");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("derives a one-time synthetic link proof on the server", async () => {
    const upstream = vi.fn().mockResolvedValue(
      jsonResponse({
        state: "READY",
        linked: true,
        reused: false,
        recovered: false,
        link_id: LINK_ID,
        legacy_project: "hushh-tech-uat-synthetic",
        owner_token: "must-not-pass",
      })
    );
    const handler = createHushhResearchHandler({
      env: enabledEnv(),
      fetchImpl: upstream,
      verifyFirebase: verifiedActor,
      now: () => 1_787_000_000_000,
    });
    const res = createResponse();

    await handler(
      request("/api/hushh-research/link/verify", {
        method: "POST",
        body: {},
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      state: "READY",
      linked: true,
      reused: false,
      recovered: false,
      link_id: LINK_ID,
      legacy_project: "hushh-tech-uat-synthetic",
    });
    expect(Object.isFrozen(res.body)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("must-not-pass");
    const [, options] = upstream.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer firebase-id-token");
    expect(options.headers["X-Hushh-Developer-Token"]).toBe(DEVELOPER_TOKEN);
    const proof = JSON.parse(options.body).legacy_session_proof;
    expect(proof).toMatch(/^synthetic-v1\.[\w-]+\.[\w-]+$/);
    const payload = JSON.parse(
      Buffer.from(proof.split(".")[1], "base64url").toString("utf8")
    );
    expect(payload).toMatchObject({
      firebase_uid: UID,
      app_id: DEVELOPER_APP_ID,
      audience: "hushh-tech-uat",
      legacy_project: "hushh-tech-uat-synthetic",
      legacy_user_uuid: "00000000-0000-4000-8000-000000000101",
      source_hash:
        "97cf5576a8a636295214bac1f23c3b900769cb76b59fb2a5c58e6b5f3e4430d7",
      issued_at_ms: 1_787_000_000_000,
      expires_at_ms: 1_787_000_300_000,
    });

    const injected = createResponse();
    await handler(
      request("/api/hushh-research/link/verify", {
        method: "POST",
        body: { legacy_session_proof: proof },
      }),
      injected
    );
    expect(injected.statusCode).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("enforces cohort auth, endpoint allowlists, and typed upstream errors", async () => {
    const upstream = vi.fn();
    const nonCohort = createHushhResearchHandler({
      env: enabledEnv(),
      fetchImpl: upstream,
      verifyFirebase: async (idToken: string) => ({
        uid: "not-in-cohort",
        authTime: 1,
        idToken,
      }),
    });
    const denied = createResponse();
    await nonCohort(request("/api/hushh-research/link/status"), denied);
    expect(denied.statusCode).toBe(404);
    expect(denied.body.state).toBe("FEATURE_DISABLED");
    expect(upstream).not.toHaveBeenCalled();

    const invalidRecord = createHushhResearchHandler({
      env: enabledEnv(),
      fetchImpl: upstream,
      verifyFirebase: verifiedActor,
    });
    const invalid = createResponse();
    await invalidRecord(
      request("/api/hushh-research/compatibility/payments"),
      invalid
    );
    expect(invalid.statusCode).toBe(404);
    expect(upstream).not.toHaveBeenCalled();

    upstream.mockResolvedValueOnce(
      jsonResponse(
        { detail: { code: "LINK_CONFLICT", message: "Account already linked." } },
        409
      )
    );
    const conflict = createResponse();
    await invalidRecord(request("/api/hushh-research/link/status"), conflict);
    expect(conflict.body).toMatchObject({
      state: "LINK_CONFLICT",
      message: "This product account has a link conflict.",
    });
    expect(JSON.stringify(conflict.body)).not.toContain("Account already linked.");

    upstream.mockResolvedValueOnce(
      jsonResponse(
        {
          detail: {
            code: "OWNER_TOKEN_EXPOSED",
            message: "owner_token=must-not-pass",
          },
        },
        418
      )
    );
    const unknown = createResponse();
    await invalidRecord(request("/api/hushh-research/link/status"), unknown);
    expect(unknown.statusCode).toBe(502);
    expect(unknown.body).toMatchObject({
      state: "UPSTREAM_UNAVAILABLE",
      message: "Research service unavailable.",
    });
    expect(JSON.stringify(unknown.body)).not.toContain("OWNER_TOKEN_EXPOSED");
    expect(JSON.stringify(unknown.body)).not.toContain("must-not-pass");
  });

  it("projects link status and revocation into frozen gateway shapes", async () => {
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          state: "READY",
          linked: true,
          link_id: LINK_ID,
          legacy_project: "hushh-tech-uat-synthetic",
          linked_at_ms: 1_787_000_000_000,
          owner_token: "must-not-pass",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          state: "LINK_REQUIRED",
          linked: false,
          revoked: true,
          raw_message: "must-not-pass",
        })
      );
    const handler = createHushhResearchHandler({
      env: enabledEnv(),
      fetchImpl: upstream,
      verifyFirebase: verifiedActor,
    });

    const status = createResponse();
    await handler(request("/api/hushh-research/link/status"), status);
    expect(status.body).toEqual({
      state: "READY",
      linked: true,
      link_id: LINK_ID,
      legacy_project: "hushh-tech-uat-synthetic",
      linked_at_ms: 1_787_000_000_000,
    });
    expect(Object.isFrozen(status.body)).toBe(true);

    const revoked = createResponse();
    await handler(
      request("/api/hushh-research/link/revoke", {
        method: "POST",
        body: {},
      }),
      revoked
    );
    expect(revoked.body).toEqual({
      state: "LINK_REQUIRED",
      linked: false,
      revoked: true,
    });
    expect(Object.isFrozen(revoked.body)).toBe(true);
    expect(JSON.stringify([status.body, revoked.body])).not.toContain(
      "must-not-pass"
    );
  });

  it("preserves only the frozen compatibility response schema", async () => {
    const valid = {
      state: "READY",
      record_type: "profile",
      payload: {
        display_name: "Synthetic Ada",
        avatar_asset_id: "synthetic-avatar-101",
        locale: "en-US",
      },
      source_hash:
        "97cf5576a8a636295214bac1f23c3b900769cb76b59fb2a5c58e6b5f3e4430d7",
      updated_at_ms: 1_787_227_200_000,
    };
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(valid))
      .mockResolvedValueOnce(
        jsonResponse({ ...valid, owner_token: "must-not-pass" })
      );
    const handler = createHushhResearchHandler({
      env: enabledEnv(),
      fetchImpl: upstream,
      verifyFirebase: verifiedActor,
    });
    const accepted = createResponse();
    await handler(
      request("/api/hushh-research/compatibility/profile"),
      accepted
    );
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).toEqual(valid);

    const rejected = createResponse();
    await handler(
      request("/api/hushh-research/compatibility/profile"),
      rejected
    );
    expect(rejected.statusCode).toBe(502);
    expect(rejected.body.state).toBe("UPSTREAM_UNAVAILABLE");
    expect(JSON.stringify(rejected.body)).not.toContain("must-not-pass");
  });

  it("keeps developer and consent tokens server-side in a frozen consent shape", async () => {
    const upstream = vi.fn().mockResolvedValue(
      jsonResponse({
        status: "granted",
        user_id: UID,
        app_id: DEVELOPER_APP_ID,
        scope: CONSENT_SCOPE,
        requested_scope: CONSENT_SCOPE,
        granted_scope: CONSENT_SCOPE,
        request_id: REQUEST_ID,
        expires_at: 1_787_086_400_000,
        approval_timeout_at: null,
        export_revision: 3,
        consent_token: "app-bound-consent-token",
        owner_token: "must-not-pass",
        message: "raw upstream message must-not-pass",
      })
    );
    const handler = createHushhResearchHandler({
      env: enabledEnv(),
      fetchImpl: upstream,
      verifyFirebase: verifiedActor,
    });
    const res = createResponse();

    await handler(
      request("/api/hushh-research/consent/status", {
        query: { scope: CONSENT_SCOPE },
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      state: "READY",
      status: "granted",
      scope: CONSENT_SCOPE,
      request_id: REQUEST_ID,
      expires_at: 1_787_086_400_000,
      approval_timeout_at: null,
      export_revision: 3,
    });
    expect(Object.isFrozen(res.body)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(DEVELOPER_TOKEN);
    expect(JSON.stringify(res.body)).not.toContain("must-not-pass");
    const [url, options] = upstream.mock.calls[0];
    expect(url).toContain(`user_id=${encodeURIComponent(UID)}`);
    expect(options.headers.Authorization).toBe(`Bearer ${DEVELOPER_TOKEN}`);
  });

  it("projects consent requests and request-id status without upstream prose", async () => {
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "pending",
          app_id: DEVELOPER_APP_ID,
          scope: CONSENT_SCOPE,
          requested_scope: CONSENT_SCOPE,
          request_id: REQUEST_ID,
          approval_timeout_at: 1_787_003_600_000,
          message: "owner_token=must-not-pass",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "granted",
          user_id: UID,
          app_id: DEVELOPER_APP_ID,
          scope: CONSENT_SCOPE,
          requested_scope: CONSENT_SCOPE,
          granted_scope: CONSENT_SCOPE,
          request_id: REQUEST_ID,
          expires_at: 1_787_086_400_000,
          consent_token: "must-not-pass",
          message: "must-not-pass",
        })
      );
    const handler = createHushhResearchHandler({
      env: enabledEnv(),
      fetchImpl: upstream,
      verifyFirebase: verifiedActor,
    });

    const requested = createResponse();
    await handler(
      request("/api/hushh-research/consent/request", {
        method: "POST",
        body: { scope: CONSENT_SCOPE },
      }),
      requested
    );
    expect(requested.body).toEqual({
      state: "CONSENT_REQUIRED",
      status: "pending",
      scope: CONSENT_SCOPE,
      request_id: REQUEST_ID,
      expires_at: null,
      approval_timeout_at: 1_787_003_600_000,
      export_revision: null,
    });
    expect(Object.isFrozen(requested.body)).toBe(true);

    const status = createResponse();
    await handler(
      request("/api/hushh-research/consent/status", {
        query: { request_id: REQUEST_ID },
      }),
      status
    );
    expect(status.body).toEqual({
      state: "READY",
      status: "granted",
      scope: CONSENT_SCOPE,
      request_id: REQUEST_ID,
      expires_at: 1_787_086_400_000,
      approval_timeout_at: null,
      export_revision: null,
    });
    expect(Object.isFrozen(status.body)).toBe(true);
    expect(JSON.stringify([requested.body, status.body])).not.toContain(
      "must-not-pass"
    );
  });

  it("rejects every consent scope except the exact identity-name scope", async () => {
    const upstream = vi.fn();
    const handler = createHushhResearchHandler({
      env: enabledEnv(),
      fetchImpl: upstream,
      verifyFirebase: verifiedActor,
    });

    for (const [path, method, body, query] of [
      [
        "/api/hushh-research/consent/request",
        "POST",
        { scope: "attr.identity.*" },
        {},
      ],
      [
        "/api/hushh-research/consent/status",
        "GET",
        undefined,
        { scope: "attr.financial.*" },
      ],
      [
        "/api/hushh-research/export/decrypt",
        "POST",
        { scope: "attr.identity.email" },
        {},
      ],
    ] as const) {
      const res = createResponse();
      await handler(request(path, { method, body, query }), res);
      expect(res.statusCode).toBe(404);
      expect(res.body.state).toBe("FEATURE_DISABLED");
    }

    expect(upstream).not.toHaveBeenCalled();

    const invalidRequestId = createResponse();
    await handler(
      request("/api/hushh-research/consent/status", {
        query: { request_id: "../another-request" },
      }),
      invalidRequestId
    );
    expect(invalidRequestId.statusCode).toBe(400);
    expect(invalidRequestId.body.state).toBe("INVALID_REQUEST");
    expect(upstream).not.toHaveBeenCalled();
  });
});
