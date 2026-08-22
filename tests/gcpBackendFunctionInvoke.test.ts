import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  fetch: vi.fn(),
  getIdToken: vi.fn().mockResolvedValue("firebase-id-token"),
}));

vi.mock("firebase/app", () => ({
  getApp: vi.fn(),
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(() => ({ name: "hushh-tech-gcp" })),
}));

vi.mock("firebase/auth", () => ({
  browserLocalPersistence: {},
  getAuth: vi.fn(() => ({
    authStateReady: vi.fn().mockResolvedValue(undefined),
    currentUser: { getIdToken: harness.getIdToken },
  })),
  getIdTokenResult: vi.fn(),
  getRedirectResult: vi.fn(),
  GoogleAuthProvider: class {},
  OAuthProvider: class {},
  onIdTokenChanged: vi.fn(),
  setPersistence: vi.fn().mockResolvedValue(undefined),
  signInWithEmailAndPassword: vi.fn(),
  signInWithRedirect: vi.fn(),
  signOut: vi.fn(),
}));

import { createGcpBackendClient } from "../src/services/gcpBackend/client";

const clientConfig = {
  apiKey: "public-firebase-config-key",
  appId: "1:175298245599:web:test",
  authDomain: "hushh-tech-uat.firebaseapp.com",
  projectId: "hushh-tech-uat",
};

describe("GCP function invocation client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", harness.fetch);
    harness.fetch.mockReset().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: vi.fn().mockResolvedValue({ success: true }),
    });
    harness.getIdToken.mockClear();
  });

  it("uses the Firebase ID token and canonicalizes bounded GET paths", async () => {
    const client = createGcpBackendClient(clientConfig);
    await client.functions.invoke("get-locations", {
      method: "GET",
      query: { type: "states", country: "IN" },
      subpath: ["v1"],
    });

    expect(harness.fetch).toHaveBeenCalledOnce();
    const [url, init] = harness.fetch.mock.calls[0];
    expect(url).toBe("/functions/v1/get-locations/v1?country=IN&type=states");
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer firebase-id-token",
      },
    });
    expect(init.headers).not.toHaveProperty("apikey");
    expect(JSON.stringify(init)).not.toContain(clientConfig.apiKey);
  });

  it("rejects traversal, malformed query names, and GET bodies before fetch", async () => {
    const client = createGcpBackendClient(clientConfig);
    const results = await Promise.all([
      client.functions.invoke("get-locations", { subpath: [".."] }),
      client.functions.invoke("get-locations", { method: "GET", query: { "bad key": "x" } }),
      client.functions.invoke("get-locations", { method: "GET", body: { type: "states" } }),
    ]);

    expect(results.map((result) => result.status)).toEqual([400, 400, 400]);
    expect(harness.fetch).not.toHaveBeenCalled();
  });
});
