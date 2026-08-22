import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

import {
  buildGcpFunctionRegistry,
  createGcpFunctionGateway,
} from "../api/shared/gcpFunctionGateway.js";
import {
  buildGcpFunctionContracts,
  GCP_FUNCTION_CONTRACTS,
} from "../api/shared/gcpFunctionContracts.js";
import {
  createLegacyFunctionRawBodyParser,
  legacyFunctionParserError,
  preserveLegacyFunctionRawBody,
} from "../api/shared/legacyFunctionRawBody.js";
import { createMetadataIdentityTokenProvider } from "../api/shared/gcpServiceIdentity.js";
import {
  createLegacyFunctionsHandler,
  readGcpFunctionFirebaseConfig,
} from "../api/legacy-functions.js";
import { GCP_BACKEND_RETIREMENT_FUNCTIONS } from "../api/shared/supabaseRetirementFunctionRegistry.js";

const baseEntry = {
  source: { slug: "stock-quotes" },
  owner_group: "investor-api",
  auth_mode: "firebase_bearer",
  migration_state: "PORTED_AND_VERIFIED",
  final_disposition: "PORT_TO_GCP",
};

function contractsFor(
  slug = "stock-quotes",
  overrides: Record<string, unknown> = {},
) {
  return buildGcpFunctionContracts([
    {
      slug,
      methods: ["POST"],
      subpaths: ["", "/price"],
      queryKeys: ["symbol"],
      contentTypes: ["application/json"],
      ...overrides,
    },
  ]);
}

function responseRecorder() {
  const headers = new Map<string, string>();
  return {
    statusCode: 0,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), String(value));
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
    header(name: string) {
      return headers.get(name.toLowerCase());
    },
  };
}

const enabledEnv = {
  GOOGLE_CLOUD_PROJECT: "hushh-tech-uat",
  HUSHH_TECH_GCP_FUNCTIONS_ENABLED: "true",
  HUSHH_TECH_INVESTOR_API_URL:
    "https://hushh-tech-investor-api-175298245599.us-central1.run.app",
  HUSHH_TECH_WEBHOOKS_URL:
    "https://hushh-tech-webhooks-175298245599.us-central1.run.app",
};

describe("GCP function registry", () => {
  it("enables geocode while stock and NDA remain frozen", () => {
    expect([...GCP_FUNCTION_CONTRACTS.keys()].sort()).toEqual([
      "hushh-location-geocode",
      "stock-quotes",
    ]);
    expect(
      GCP_BACKEND_RETIREMENT_FUNCTIONS.find(
        (entry) => entry.slug === "hushh-location-geocode",
      )?.migration_state,
    ).toBe("PORTED_AND_VERIFIED");
    expect(
      GCP_BACKEND_RETIREMENT_FUNCTIONS.find(
        (entry) => entry.slug === "stock-quotes",
      )?.migration_state,
    ).toBe("INVENTORY_FROZEN");
    expect(
      GCP_BACKEND_RETIREMENT_FUNCTIONS.find(
        (entry) => entry.slug === "nda-admin-fetch",
      )?.migration_state,
    ).toBe("INVENTORY_FROZEN");
    expect(GCP_FUNCTION_CONTRACTS.get("hushh-location-geocode")).toMatchObject({
      methods: ["POST"],
      contentTypes: ["application/json"],
      maxRequestBytes: 16_384,
      timeoutMs: 25_000,
      publicCache: false,
    });
    expect(GCP_FUNCTION_CONTRACTS.get("stock-quotes")).toMatchObject({
      methods: ["GET", "POST"],
      contentTypes: ["application/json"],
      maxRequestBytes: 8_192,
      timeoutMs: 25_000,
      publicCache: false,
    });
    expect(GCP_FUNCTION_CONTRACTS.has("get-locations")).toBe(false);
    expect(GCP_FUNCTION_CONTRACTS.has("hushh-dob-inference")).toBe(false);
    expect(GCP_FUNCTION_CONTRACTS.has("investor-og-image")).toBe(false);
  });

  it("rejects duplicates and non-explicit owners", () => {
    expect(() => buildGcpFunctionRegistry([baseEntry, baseEntry])).toThrow(
      /Duplicate legacy function slug/,
    );
    expect(() =>
      buildGcpFunctionRegistry([
        { ...baseEntry, owner_group: "generic-proxy" },
      ]),
    ).toThrow(/Invalid GCP function owner/);
  });

  it("allows only get-secrets to use the retired contract", () => {
    expect(() =>
      buildGcpFunctionRegistry([
        {
          ...baseEntry,
          auth_mode: "none_feature_retired",
          final_disposition: "RETIRE_WITH_410",
        },
      ]),
    ).toThrow(/Only get-secrets/);
  });
});

describe("GCP legacy function compatibility gateway", () => {
  it("retires get-secrets with a typed 410 and never calls an upstream", async () => {
    const registry = buildGcpFunctionRegistry([
      {
        source: { slug: "get-secrets" },
        owner_group: "security-retirement",
        auth_mode: "none_feature_retired",
        migration_state: "INVENTORY_FROZEN",
        final_disposition: "RETIRE_WITH_410",
      },
    ]);
    const fetchImpl = vi.fn();
    const handler = createGcpFunctionGateway({
      registry,
      contracts: new Map(),
      fetchImpl,
    });
    const res = responseRecorder();

    await handler(
      { method: "GET", url: "/functions/v1/get-secrets", headers: {} },
      res,
    );

    expect(res.statusCode).toBe(410);
    expect(res.body).toEqual({
      detail: {
        code: "FEATURE_RETIRED",
        message: "This feature is no longer available.",
      },
    });
    expect(res.header("cache-control")).toBe("private, no-store");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed until a function is explicitly ported and verified", async () => {
    const registry = buildGcpFunctionRegistry([
      { ...baseEntry, migration_state: "INVENTORY_FROZEN" },
    ]);
    const fetchImpl = vi.fn();
    const res = responseRecorder();

    await createGcpFunctionGateway({
      registry,
      contracts: new Map(),
      fetchImpl,
    })(
      { method: "POST", url: "/functions/v1/stock-quotes", headers: {} },
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({
      detail: { code: "FUNCTION_NOT_MIGRATED" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("routes an allowlisted function with verified Firebase and service identity", async () => {
    const registry = buildGcpFunctionRegistry([baseEntry]);
    const fetchImpl = vi.fn(async (_url, init) => {
      const headers = init?.headers as Headers;
      expect(headers.get("authorization")).toBe("Bearer service-token");
      expect(headers.get("x-hushh-firebase-authorization")).toBe(
        "Bearer firebase-token",
      );
      expect(headers.get("x-hushh-firebase-uid")).toBe("firebase-user-1");
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("apikey")).toBeNull();
      return new Response(JSON.stringify({ price: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const handler = createGcpFunctionGateway({
      registry,
      contracts: contractsFor(),
      env: enabledEnv,
      fetchImpl,
      now: () => 1_000_000,
      requestId: () => "request-1",
      verifyFirebaseToken: vi.fn(async () => ({
        uid: "firebase-user-1",
        authTime: 999,
      })),
      getServiceIdentityToken: vi.fn(async () => "service-token"),
    });
    const res = responseRecorder();

    await handler(
      {
        method: "POST",
        url: "/functions/v1/stock-quotes/price?symbol=HUSHH",
        headers: {
          authorization: "Bearer firebase-token",
          cookie: "legacy-session=must-not-forward",
          apikey: "must-not-forward",
          "content-type": "application/json",
        },
        body: { symbol: "HUSHH" },
      },
      res,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hushh-tech-investor-api-175298245599.us-central1.run.app/api/v1/legacy-functions/stock-quotes/price?symbol=HUSHH",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.header("x-hushh-compatibility-source")).toBe("gcp");
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.header("cache-control")).toBe("private, no-store");
  });

  it("requires an exact method, subpath, and query contract before authentication", async () => {
    const registry = buildGcpFunctionRegistry([baseEntry]);
    const fetchImpl = vi.fn();
    const verifyFirebaseToken = vi.fn();
    const handler = createGcpFunctionGateway({
      registry,
      contracts: contractsFor(),
      env: enabledEnv,
      fetchImpl,
      verifyFirebaseToken,
      getServiceIdentityToken: async () => "service-token",
    });

    const cases = [
      ["GET", "/functions/v1/stock-quotes", 405, "METHOD_NOT_ALLOWED"],
      ["POST", "/functions/v1/stock-quotes/admin", 404, "INVALID_ROUTE"],
      ["POST", "/functions/v1/stock-quotes?secret=value", 400, "INVALID_QUERY"],
      ["POST", "/functions/v1/stock-quotes?unknown=value", 400, "INVALID_QUERY"],
    ] as const;
    for (const [method, url, status, code] of cases) {
      const res = responseRecorder();
      await handler({ method, url, headers: {} }, res);
      expect(res.statusCode).toBe(status);
      expect(res.body).toMatchObject({ detail: { code } });
    }
    expect(verifyFirebaseToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON without changing or forwarding it", async () => {
    const fetchImpl = vi.fn();
    const res = responseRecorder();
    await createGcpFunctionGateway({
      registry: buildGcpFunctionRegistry([baseEntry]),
      contracts: contractsFor(),
      env: enabledEnv,
      fetchImpl,
      verifyFirebaseToken: async () => ({ uid: "firebase-user-1", authTime: 1 }),
      getServiceIdentityToken: async () => "service-token",
    })(
      {
        method: "POST",
        url: "/functions/v1/stock-quotes",
        headers: {
          authorization: "Bearer firebase-token",
          "content-type": "application/json",
        },
        rawBody: Buffer.from('{"broken":', "utf8"),
      },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ detail: { code: "INVALID_BODY" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pins each owner to the expected project service hostname", async () => {
    const fetchImpl = vi.fn();
    const res = responseRecorder();
    await createGcpFunctionGateway({
      registry: buildGcpFunctionRegistry([baseEntry]),
      contracts: contractsFor(),
      env: {
        ...enabledEnv,
        HUSHH_TECH_INVESTOR_API_URL:
          "https://hushh-tech-investor-api-attacker-uc.a.run.app",
      },
      fetchImpl,
      verifyFirebaseToken: async () => ({ uid: "firebase-user-1", authTime: 1 }),
      getServiceIdentityToken: async () => "service-token",
    })(
      {
        method: "POST",
        url: "/functions/v1/stock-quotes",
        headers: {
          authorization: "Bearer firebase-token",
          "content-type": "application/json",
        },
        rawBody: Buffer.from("{}"),
      },
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ detail: { code: "UPSTREAM_UNAVAILABLE" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("overrides public caching and preserves only contract response headers", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("event", {
        status: 200,
        headers: {
          "cache-control": "public, max-age=86400",
          "x-calendar-event": "created",
          "x-upstream-secret": "must-not-forward",
        },
      }),
    );
    const res = responseRecorder();
    await createGcpFunctionGateway({
      registry: buildGcpFunctionRegistry([baseEntry]),
      contracts: contractsFor("stock-quotes", {
        responseHeaders: ["x-calendar-event"],
      }),
      env: enabledEnv,
      fetchImpl,
      verifyFirebaseToken: async () => ({ uid: "firebase-user-1", authTime: 1 }),
      getServiceIdentityToken: async () => "service-token",
    })(
      {
        method: "POST",
        url: "/functions/v1/stock-quotes",
        headers: {
          authorization: "Bearer firebase-token",
          "content-type": "application/json",
        },
        rawBody: Buffer.from("{}"),
      },
      res,
    );

    expect(res.header("cache-control")).toBe("private, no-store");
    expect(res.header("pragma")).toBe("no-cache");
    expect(res.header("x-calendar-event")).toBe("created");
    expect(res.header("x-upstream-secret")).toBeUndefined();
  });

  it("propagates client aborts to the upstream fetch", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url, init) => {
      upstreamSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const listeners = new Map<string, () => void>();
    const req = {
      method: "POST",
      url: "/functions/v1/stock-quotes",
      headers: {
        authorization: "Bearer firebase-token",
        "content-type": "application/json",
      },
      rawBody: Buffer.from("{}"),
      once(event: string, listener: () => void) {
        listeners.set(event, listener);
      },
      off(event: string) {
        listeners.delete(event);
      },
    };
    const res = responseRecorder();
    const result = createGcpFunctionGateway({
      registry: buildGcpFunctionRegistry([baseEntry]),
      contracts: contractsFor(),
      env: enabledEnv,
      fetchImpl,
      verifyFirebaseToken: async () => ({ uid: "firebase-user-1", authTime: 1 }),
      getServiceIdentityToken: async () => "service-token",
    })(req, res);

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    listeners.get("aborted")?.();
    await result;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(res.statusCode).toBe(503);
  });

  it("aborts upstream work when the response socket closes", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url, init) => {
      upstreamSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const responseListeners = new Map<string, () => void>();
    const res = Object.assign(responseRecorder(), {
      writableEnded: false,
      once(event: string, listener: () => void) {
        responseListeners.set(event, listener);
      },
      off(event: string) {
        responseListeners.delete(event);
      },
    });
    const result = createGcpFunctionGateway({
      registry: buildGcpFunctionRegistry([baseEntry]),
      contracts: contractsFor(),
      env: enabledEnv,
      fetchImpl,
      verifyFirebaseToken: async () => ({ uid: "firebase-user-1", authTime: 1 }),
      getServiceIdentityToken: async () => "service-token",
    })(
      {
        method: "POST",
        url: "/functions/v1/stock-quotes",
        headers: {
          authorization: "Bearer firebase-token",
          "content-type": "application/json",
        },
        rawBody: Buffer.from("{}"),
      },
      res,
    );

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    responseListeners.get("close")?.();
    await result;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(res.statusCode).toBe(503);
  });

  it("terminates a connected client that never drains before the deadline", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Map<string, () => void>();
      const write = vi.fn(() => false);
      const destroy = vi.fn();
      const res = {
        headersSent: false,
        writableEnded: false,
        setHeader: vi.fn(),
        status: vi.fn(function status() {
          return this;
        }),
        write(chunk: Buffer) {
          this.headersSent = true;
          return write(chunk);
        },
        end: vi.fn(),
        destroy,
        once(event: string, listener: () => void) {
          listeners.set(event, listener);
        },
        off(event: string) {
          listeners.delete(event);
        },
      };
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
        }),
        { status: 200 },
      );
      const result = createGcpFunctionGateway({
        registry: buildGcpFunctionRegistry([baseEntry]),
        contracts: contractsFor("stock-quotes", { timeoutMs: 1000 }),
        env: enabledEnv,
        fetchImpl: vi.fn(async () => response),
        verifyFirebaseToken: async () => ({ uid: "firebase-user-1", authTime: 1 }),
        getServiceIdentityToken: async () => "service-token",
      })(
        {
          method: "POST",
          url: "/functions/v1/stock-quotes",
          headers: {
            authorization: "Bearer firebase-token",
            "content-type": "application/json",
          },
          rawBody: Buffer.from("{}"),
        },
        res,
      );

      for (let attempt = 0; attempt < 10 && write.mock.calls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      expect(write).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1001);
      await result;
      expect(destroy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires recent Firebase authentication for sensitive functions", async () => {
    const registry = buildGcpFunctionRegistry([
      {
        ...baseEntry,
        source: { slug: "delete-user-account" },
        owner_group: "identity-api",
        auth_mode: "firebase_bearer_recent_auth",
      },
    ]);
    const fetchImpl = vi.fn();
    const res = responseRecorder();

    await createGcpFunctionGateway({
      registry,
      contracts: contractsFor("delete-user-account", {
        subpaths: [""],
        queryKeys: [],
        contentTypes: [],
      }),
      env: {
        ...enabledEnv,
        HUSHH_TECH_IDENTITY_API_URL:
          "https://hushh-tech-identity-api-175298245599.us-central1.run.app",
      },
      fetchImpl,
      now: () => 1_000_000,
      verifyFirebaseToken: async () => ({ uid: "firebase-user-1", authTime: 600 }),
      getServiceIdentityToken: async () => "service-token",
    })(
      {
        method: "POST",
        url: "/functions/v1/delete-user-account",
        headers: { authorization: "Bearer firebase-token" },
      },
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({
      detail: { code: "RECENT_AUTH_REQUIRED" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves raw signed webhook bytes through its explicit owner", async () => {
    const registry = buildGcpFunctionRegistry([
      {
        ...baseEntry,
        source: { slug: "fund-stripe-webhook" },
        owner_group: "signed-webhook-service",
        auth_mode: "provider_signature_raw_body",
      },
    ]);
    const rawBody = Buffer.from('{"id":"evt_1"}', "utf8");
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init?.body).toEqual(rawBody);
      expect((init?.headers as Headers).get("stripe-signature")).toBe(
        "signed-value",
      );
      return new Response("ok", { status: 202 });
    });
    const verifyFirebaseToken = vi.fn();
    const res = responseRecorder();

    await createGcpFunctionGateway({
      registry,
      contracts: contractsFor("fund-stripe-webhook", {
        subpaths: [""],
        queryKeys: [],
      }),
      env: enabledEnv,
      fetchImpl,
      verifyFirebaseToken,
      getServiceIdentityToken: async () => "service-token",
    })(
      {
        method: "POST",
        url: "/functions/v1/fund-stripe-webhook",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "signed-value",
        },
        rawBody,
      },
      res,
    );

    expect(res.statusCode).toBe(202);
    expect(verifyFirebaseToken).not.toHaveBeenCalled();
  });

  it("rejects traversal and unknown slugs without an upstream call", async () => {
    const registry = buildGcpFunctionRegistry([baseEntry]);
    const fetchImpl = vi.fn();
    const handler = createGcpFunctionGateway({
      registry,
      contracts: contractsFor(),
      fetchImpl,
    });

    for (const url of [
      "/functions/v1/unknown",
      "/functions/v1/stock-quotes/%2e%2e/admin",
      "/functions/v1/stock-quotes/%2Fadmin",
    ]) {
      const res = responseRecorder();
      await handler({ method: "GET", url, headers: {} }, res);
      expect(res.statusCode).toBe(404);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("legacy function raw-body parser", () => {
  it("preserves exact non-JSON bytes and types parser failures", async () => {
    const app = express();
    app.use("/functions/v1", createLegacyFunctionRawBodyParser({ limit: "16b" }));
    app.use("/functions/v1", preserveLegacyFunctionRawBody);
    app.use(legacyFunctionParserError);
    app.post("/functions/v1/webhook", (req, res) => {
      const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
      res.json({ hex: rawBody?.toString("hex") });
    });
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      const exact = Buffer.from([0, 1, 2, 127, 128, 255]);
      const accepted = await fetch(`${origin}/functions/v1/webhook`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: exact,
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ hex: exact.toString("hex") });

      const rejected = await fetch(`${origin}/functions/v1/webhook`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.alloc(17, 1),
      });
      expect(rejected.status).toBe(413);
      expect(rejected.headers.get("cache-control")).toBe("private, no-store");
      expect(await rejected.json()).toEqual({
        detail: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Request is too large.",
        },
      });

      const encoded = await fetch(`${origin}/functions/v1/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        body: gzipSync(Buffer.from("{}")),
      });
      expect(encoded.status).toBe(415);
      expect(await encoded.json()).toMatchObject({
        detail: { code: "UNSUPPORTED_MEDIA_TYPE" },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("Cloud Run service identity", () => {
  it("requests and caches an audience-bound metadata token", async () => {
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(2_000_000 / 1000) }),
    ).toString("base64url");
    const token = `header.${payload}.signature`;
    const fetchImpl = vi.fn(async (url: URL, init) => {
      expect(url.searchParams.get("audience")).toBe(
        "https://service-example-uc.a.run.app",
      );
      expect(init?.headers).toEqual({ "Metadata-Flavor": "Google" });
      return new Response(token, { status: 200 });
    });
    const provider = createMetadataIdentityTokenProvider({
      fetchImpl,
      now: () => 1_000_000,
    });

    expect(await provider("https://service-example-uc.a.run.app")).toBe(token);
    expect(await provider("https://service-example-uc.a.run.app/")).toBe(token);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("generated retirement registry integration", () => {
  it("loads exactly 112 explicit function dispositions", () => {
    expect(GCP_BACKEND_RETIREMENT_FUNCTIONS).toHaveLength(112);
    expect(
      GCP_BACKEND_RETIREMENT_FUNCTIONS.filter(
        (entry) => entry.final_disposition === "RETIRE_WITH_410",
      ).map((entry) => entry.slug),
    ).toEqual(["get-secrets"]);
  });

  it("pins the compatibility gateway to the isolated UAT Firebase authority", () => {
    expect(
      readGcpFunctionFirebaseConfig({
        GOOGLE_CLOUD_PROJECT: "hushh-tech-uat",
        FIREBASE_PROJECT_ID: "hushh-tech-uat",
      }),
    ).toMatchObject({
      firebase: { projectId: "hushh-tech-uat" },
      audience: "hushh-tech-uat",
      issuer: "https://securetoken.google.com/hushh-tech-uat",
    });
    expect(
      readGcpFunctionFirebaseConfig({
        GOOGLE_CLOUD_PROJECT: "hushh-tech-prod",
        FIREBASE_PROJECT_ID: "hushh-tech-prod",
      }),
    ).toBeNull();
    expect(
      readGcpFunctionFirebaseConfig({
        GOOGLE_CLOUD_PROJECT: "hushh-tech-uat",
        FIREBASE_PROJECT_ID: "hushh-pda",
        HUSHH_RESEARCH_FIREBASE_PROJECT_ID: "hushh-pda",
      }),
    ).toBeNull();
  });

  it("routes the generated geocode entry through the real same-origin contract", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe(
        "https://hushh-tech-investor-api-175298245599.us-central1.run.app/api/v1/legacy-functions/hushh-location-geocode",
      );
      const headers = init?.headers as Headers;
      expect(headers.get("authorization")).toBe("Bearer website-service-token");
      expect(headers.get("x-hushh-firebase-authorization")).toBe(
        "Bearer firebase-user-token",
      );
      expect(headers.get("x-hushh-firebase-uid")).toBe("firebase-user-1");
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            latitude: 37.7749,
            longitude: -122.4194,
            countryCode: "US",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const handler = createLegacyFunctionsHandler({
      env: enabledEnv,
      fetchImpl,
      now: () => 1_000_000,
      requestId: () => "same-origin-request-1",
      verifyFirebaseToken: async () => ({
        uid: "firebase-user-1",
        authTime: 999,
      }),
      getServiceIdentityToken: async () => "website-service-token",
    });
    const res = responseRecorder();

    await handler(
      {
        method: "POST",
        url: "/functions/v1/hushh-location-geocode",
        headers: {
          authorization: "Bearer firebase-user-token",
          "content-type": "application/json",
        },
        rawBody: Buffer.from(
          JSON.stringify({ latitude: 37.7749, longitude: -122.4194 }),
        ),
      },
      res,
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(res.header("x-hushh-compatibility-source")).toBe("gcp");
    expect(res.header("cache-control")).toBe("private, no-store");
  });

  it("keeps generated NDA and stock routes frozen without auth or metadata calls", async () => {
    const fetchImpl = vi.fn();
    const verifyFirebaseToken = vi.fn();
    const getServiceIdentityToken = vi.fn();
    const handler = createLegacyFunctionsHandler({
      env: enabledEnv,
      fetchImpl,
      verifyFirebaseToken,
      getServiceIdentityToken,
    });

    for (const slug of ["nda-admin-fetch", "stock-quotes"]) {
      const res = responseRecorder();
      await handler(
        { method: "POST", url: `/functions/v1/${slug}`, headers: {} },
        res,
      );
      expect(res.statusCode).toBe(503);
      expect(res.body).toMatchObject({
        detail: { code: "FUNCTION_NOT_MIGRATED" },
      });
    }
    expect(verifyFirebaseToken).not.toHaveBeenCalled();
    expect(getServiceIdentityToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("serves the generated get-secrets retirement without Firebase or metadata", async () => {
    const fetchImpl = vi.fn();
    const res = responseRecorder();

    await createLegacyFunctionsHandler({ fetchImpl })(
      { method: "GET", url: "/functions/v1/get-secrets", headers: {} },
      res,
    );

    expect(res.statusCode).toBe(410);
    expect(res.body).toMatchObject({ detail: { code: "FEATURE_RETIRED" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
