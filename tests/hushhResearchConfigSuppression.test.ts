// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HUSHH_RESEARCH_CALLBACK_PATH,
  HUSHH_RESEARCH_START_ROUTE,
} from "../src/services/hushhResearch/contracts";

const createClientMock = vi.hoisted(() => vi.fn());

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

describe("Hushh Research Supabase bootstrap suppression", () => {
  beforeEach(() => {
    vi.resetModules();
    createClientMock.mockReset().mockReturnValue({ kind: "legacy-client" });
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    vi.stubEnv("VITE_SUPABASE_URL", "https://legacy.example.test");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "legacy-public-anon-key");
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
  ])(
    "does not construct a Supabase client on the first %s render",
    async (pathname) => {
      window.history.replaceState({}, "", pathname);

      const { default: config, shouldSuppressLegacySupabaseBootstrap } =
        await import("../src/resources/config/config");

      expect(shouldSuppressLegacySupabaseBootstrap()).toBe(true);
      expect(config.supabaseClient).toBeUndefined();
      expect(createClientMock).not.toHaveBeenCalled();
    },
  );

  it("does not construct a Supabase client for persisted Research mode", async () => {
    window.localStorage.setItem("hushh_research_auth_mode", "firebase-v1");

    const { default: config } = await import(
      "../src/resources/config/config"
    );

    expect(config.supabaseClient).toBeUndefined();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("preserves the legacy Supabase client options outside Research mode", async () => {
    const legacyClient = { kind: "legacy-client" };
    createClientMock.mockReturnValue(legacyClient);

    const { default: config } = await import(
      "../src/resources/config/config"
    );

    expect(config.supabaseClient).toBe(legacyClient);
    expect(createClientMock).toHaveBeenCalledOnce();
    expect(createClientMock).toHaveBeenCalledWith(
      "https://legacy.example.test",
      "legacy-public-anon-key",
      {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
        },
      },
    );
  });
});
