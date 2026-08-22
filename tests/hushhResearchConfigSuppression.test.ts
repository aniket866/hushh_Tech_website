// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HUSHH_RESEARCH_CALLBACK_PATH,
  HUSHH_RESEARCH_START_ROUTE,
} from "../src/services/hushhResearch/contracts";

const createGcpBackendClientMock = vi.hoisted(() => vi.fn());

vi.mock("../src/services/gcpBackend/client", () => ({
  createGcpBackendClient: (...args: unknown[]) => createGcpBackendClientMock(...args),
}));

describe("Hushh Research unified Firebase bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    createGcpBackendClientMock.mockReset().mockReturnValue({ kind: "firebase-gcp-client" });
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    vi.stubEnv("VITE_FIREBASE_API_KEY", "public-api-key");
    vi.stubEnv("VITE_FIREBASE_AUTH_DOMAIN", "hushh-tech-uat.firebaseapp.com");
    vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "hushh-tech-uat");
    vi.stubEnv("VITE_FIREBASE_APP_ID", "1:123:web:test");
    vi.stubEnv("VITE_GCP_API_BASE_URL", "/api/gcp");
    vi.stubEnv("VITE_GCP_AUTH_REDIRECT_URL", "https://uat.hushhtech.com/auth/callback");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    window.localStorage.clear();
  });

  it.each([
    HUSHH_RESEARCH_START_ROUTE,
    HUSHH_RESEARCH_CALLBACK_PATH,
    "/AUTH/HUSHH-RESEARCH/START/",
    "/Auth/Hushh-Research/Callback///",
  ])("constructs only the unified Firebase client on %s", async (pathname) => {
    window.history.replaceState({}, "", pathname);

    const { default: config } = await import("../src/resources/config/config");

    expect(config.gcpBackendClient).toEqual({ kind: "firebase-gcp-client" });
    expect(config).not.toHaveProperty("supabaseClient");
    expect(createGcpBackendClientMock).toHaveBeenCalledOnce();
    expect(createGcpBackendClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "hushh-tech-uat",
        authDomain: "hushh-tech-uat.firebaseapp.com",
      }),
    );
  });

  it("ignores retired provider environment variables", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://retired.example.test");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "retired-public-key");

    const { default: config } = await import("../src/resources/config/config");

    expect(config.gcpBackendClient).toEqual({ kind: "firebase-gcp-client" });
    expect(config).not.toHaveProperty("SUPABASE_URL");
    expect(config).not.toHaveProperty("SUPABASE_ANON_KEY");
  });
});
