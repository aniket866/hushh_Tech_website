import { beforeEach, describe, expect, it, vi } from "vitest";

const { createGcpBackendClientMock } = vi.hoisted(() => ({
  createGcpBackendClientMock: vi.fn(),
}));

vi.mock("../src/services/gcpBackend/client", () => ({
  createGcpBackendClient: (...args: unknown[]) => createGcpBackendClientMock(...args),
}));

import { buildClientConfig } from "../src/resources/config/config";

describe("client auth config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createGcpBackendClientMock.mockReturnValue({ auth: {} });
  });

  it("creates the Firebase and GCP backend client when required env vars are present", () => {
    const clientConfig = buildClientConfig(
      {
        VITE_FIREBASE_API_KEY: "public-api-key",
        VITE_FIREBASE_AUTH_DOMAIN: "hushh-tech-uat.firebaseapp.com",
        VITE_FIREBASE_PROJECT_ID: "hushh-tech-uat",
        VITE_FIREBASE_STORAGE_BUCKET: "hushh-tech-uat.appspot.com",
        VITE_FIREBASE_APP_ID: "1:123:web:test",
        VITE_GCP_API_BASE_URL: "/api/gcp",
        VITE_GCP_AUTH_REDIRECT_URL: "https://uat.hushhtech.com/auth/callback",
      },
      "https://uat.hushhtech.com/auth/callback"
    );

    expect(createGcpBackendClientMock).toHaveBeenCalledWith({
      apiKey: "public-api-key",
      authDomain: "hushh-tech-uat.firebaseapp.com",
      projectId: "hushh-tech-uat",
      storageBucket: "hushh-tech-uat.appspot.com",
      appId: "1:123:web:test",
    });
    expect(clientConfig.gcpBackendClient).toEqual({ auth: {} });
    expect(clientConfig.GCP_API_BASE_URL).toBe("/api/gcp");
  });

  it("fails cleanly when required env vars are absent", () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const clientConfig = buildClientConfig(
      {},
      "https://hushhtech.com/auth/callback"
    );
    expect(clientConfig.gcpBackendClient).toBeUndefined();
    expect(createGcpBackendClientMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("normalizes redirect URLs before storing config", () => {
    const clientConfig = buildClientConfig(
      {
        VITE_GCP_AUTH_REDIRECT_URL: "http://localhost:5173/",
      },
      "https://hushhtech.com/auth/callback"
    );

    expect(clientConfig.redirect_url).toBe("http://localhost:5173/auth/callback");
  });
});
