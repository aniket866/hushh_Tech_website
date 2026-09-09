// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  addScope: vi.fn(),
  getIdTokenResult: vi.fn(),
  getRedirectResult: vi.fn(),
  setCustomParameters: vi.fn(),
  signInWithRedirect: vi.fn().mockResolvedValue(undefined),
  currentUser: null as unknown,
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
    currentUser: harness.currentUser,
  })),
  getIdTokenResult: harness.getIdTokenResult,
  getRedirectResult: harness.getRedirectResult,
  GoogleAuthProvider: class {
    setCustomParameters = harness.setCustomParameters;
  },
  OAuthProvider: class {
    addScope = harness.addScope;
  },
  onIdTokenChanged: vi.fn(),
  setPersistence: vi.fn().mockResolvedValue(undefined),
  signInWithEmailAndPassword: vi.fn(),
  signInWithRedirect: harness.signInWithRedirect,
  signOut: vi.fn(),
}));

vi.mock("../src/resources/config/config", () => ({ default: {} }));

import { createGcpBackendClient } from "../src/services/gcpBackend/client";
import { getValidatedSession, validateSessionCandidate } from "../src/auth/session";

const clientConfig = {
  apiKey: "public-firebase-config-key",
  appId: "1:175298245599:web:test",
  authDomain: "hushh-tech-uat.firebaseapp.com",
  projectId: "hushh-tech-uat",
};

describe("GCP Firebase auth adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.getIdTokenResult.mockReset();
    harness.getRedirectResult.mockReset();
    harness.currentUser = null;
    window.history.replaceState({}, "", "/login?redirect=%2Fprofile");
  });

  it("applies the Google provider parameters and stages the callback route", async () => {
    const client = createGcpBackendClient(clientConfig);

    await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: "http://localhost:3000/auth/callback?redirect=%2Fprofile",
        queryParams: { access_type: "offline", prompt: "consent" },
      },
    });

    expect(window.location.pathname).toBe("/auth/callback");
    expect(window.location.search).toBe("?redirect=%2Fprofile");
    expect(harness.setCustomParameters).toHaveBeenCalledWith({
      access_type: "offline",
      prompt: "consent",
    });
    expect(harness.signInWithRedirect).toHaveBeenCalledOnce();
  });

  it("applies the Apple scopes and exposes Firebase redirect-result handling", async () => {
    const client = createGcpBackendClient(clientConfig);

    await client.auth.signInWithOAuth({
      provider: "apple",
      options: {
        redirectTo: "http://localhost:3000/auth/callback",
        scopes: "name email",
      },
    });

    expect(harness.addScope).toHaveBeenNthCalledWith(1, "name");
    expect(harness.addScope).toHaveBeenNthCalledWith(2, "email");

    harness.getRedirectResult.mockResolvedValueOnce(null);
    await client.auth.getRedirectResult();
    expect(harness.getRedirectResult).toHaveBeenCalledOnce();
  });

  it("turns the Firebase redirect user into the existing session shape", async () => {
    const user = {
      uid: "firebase-user",
      email: "uat@example.com",
      phoneNumber: null,
      displayName: "UAT User",
      photoURL: null,
      providerData: [{
        uid: "google-user",
        providerId: "google.com",
        email: "uat@example.com",
        displayName: "UAT User",
        photoURL: null,
      }],
      metadata: {
        creationTime: "2026-01-01T00:00:00.000Z",
        lastRefreshTime: "2026-01-02T00:00:00.000Z",
        lastSignInTime: "2026-01-02T00:00:00.000Z",
      },
      isAnonymous: false,
      refreshToken: "firebase-refresh-token",
    };
    harness.getRedirectResult.mockResolvedValueOnce({ user });
    harness.getIdTokenResult.mockResolvedValueOnce({
      token: "firebase-id-token",
      expirationTime: "2026-01-02T01:00:00.000Z",
      issuedAtTime: "2026-01-02T00:00:00.000Z",
      claims: {},
    });

    const client = createGcpBackendClient(clientConfig);
    const result = await client.auth.getRedirectResult();

    expect(result).toMatchObject({
      error: null,
      data: {
        session: {
          access_token: "firebase-id-token",
          user: { id: "firebase-user", email: "uat@example.com" },
        },
      },
    });
  });

  describe("post-redirect session revalidation", () => {
    function restoredUser(providerId = "google.com") {
      return {
        uid: "restored-user",
        email: "uat@example.test",
        displayName: "UAT User",
        providerData: [{ providerId, uid: "provider-user" }],
        metadata: { creationTime: "2026-01-01T00:00:00.000Z" },
        refreshToken: "test-refresh-token",
        isAnonymous: false,
      };
    }

    beforeEach(() => {
      harness.getIdTokenResult.mockResolvedValue({
        token: "test-id-token",
        expirationTime: "2099-01-01T01:00:00.000Z",
        issuedAtTime: "2099-01-01T00:00:00.000Z",
        claims: { fund_admin: true, deployment_admin: false },
      });
    });

    it.each([
      ["google.com", "credential"],
      ["google.com", "restored currentUser"],
      ["apple.com", "credential"],
      ["apple.com", "restored currentUser"],
    ])("keeps %s authenticated after a %s redirect result", async (providerId, resultKind) => {
      const user = restoredUser(providerId);
      harness.currentUser = user;
      harness.getRedirectResult.mockResolvedValueOnce(
        resultKind === "credential" ? { user } : null,
      );
      const client = createGcpBackendClient(clientConfig);

      // Use the real adapter and validator called by AuthCallback's
      // revalidateSession(), not a mocked authenticated provider snapshot.
      const redirect = await client.auth.getRedirectResult();
      expect(redirect.error).toBeNull();
      const snapshot = await getValidatedSession(client);

      expect(snapshot.status).toBe("authenticated");
      expect(snapshot.user).toEqual(redirect.data.user);
      expect(snapshot.user?.app_metadata).toMatchObject({
        fund_admin: true,
        deployment_admin: false,
      });
    });

    it("returns the same claims-aware user from getUser and getSession", async () => {
      harness.currentUser = restoredUser();
      const client = createGcpBackendClient(clientConfig);
      const session = await client.auth.getSession();

      await expect(client.auth.getUser()).resolves.toEqual({
        data: { user: session.data.session.user },
        error: null,
      });
    });

    it("does not establish a session without a redirect or persisted user", async () => {
      harness.getRedirectResult.mockResolvedValueOnce(null);
      const client = createGcpBackendClient(clientConfig);

      expect((await client.auth.getRedirectResult()).error).not.toBeNull();
      expect(await client.auth.getUser()).toMatchObject({
        data: { user: null }, error: { status: 401 },
      });
      expect((await getValidatedSession(client)).status).toBe("anonymous");
      expect(harness.getIdTokenResult).not.toHaveBeenCalled();
    });

    it("still invalidates a different user during revalidation", async () => {
      harness.currentUser = restoredUser();
      const client = createGcpBackendClient(clientConfig);
      const { data: { session } } = await client.auth.getSession();

      const snapshot = await validateSessionCandidate(client, {
        ...session, user: { ...session.user, id: "another-user" },
      });
      expect(snapshot.status).toBe("invalidated");
    });

    it("fails closed if token validation fails after the redirect", async () => {
      harness.currentUser = restoredUser();
      const client = createGcpBackendClient(clientConfig);
      const { data: { session } } = await client.auth.getSession();
      harness.getIdTokenResult.mockRejectedValueOnce(new Error("Token unavailable"));

      expect((await validateSessionCandidate(client, session)).status).toBe("invalidated");
    });
  });
});
