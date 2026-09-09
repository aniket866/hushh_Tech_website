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

import { createGcpBackendClient } from "../src/services/gcpBackend/client";

const clientConfig = {
  apiKey: "public-firebase-config-key",
  appId: "1:175298245599:web:test",
  authDomain: "hushh-tech-uat.firebaseapp.com",
  projectId: "hushh-tech-uat",
};

describe("GCP Firebase auth adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
