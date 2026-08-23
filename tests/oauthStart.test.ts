import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const assignMock = vi.fn();
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    redirect_url: "https://hushhtech.com/auth/callback",
  },
}));

vi.mock("../src/resources/config/config", () => ({
  default: mockConfig,
}));

import { startUnifiedOAuth } from "../src/auth/session";

describe("startUnifiedOAuth", () => {
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalWindow = global.window;
    Object.defineProperty(global, "window", {
      value: {
        location: {
          origin: "https://hushhtech.com",
          pathname: "/login",
          search: "?redirect=%2Fprofile",
          assign: assignMock,
        },
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(global, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
  });

  it("returns missing_client when the build lacks a GCP auth client", async () => {
    const result = await startUnifiedOAuth("apple", undefined);

    expect(result).toMatchObject({
      ok: false,
      provider: "apple",
      reason: "missing_client",
    });
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("returns unsupported_host for raw Cloud Run hosts", async () => {
    (window.location as any).origin =
      "https://hushh-tech-website-646258530541.us-central1.run.app";
    (window.location as any).pathname = "/signup";

    const result = await startUnifiedOAuth("google", undefined);

    expect(result).toMatchObject({
      ok: false,
      provider: "google",
      reason: "unsupported_host",
      redirectTo: "https://hushhtech.com/signup?redirect=%2Fprofile",
    });
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("redirects to the provider when an authorization URL is returned", async () => {
    const signInWithOAuth = vi.fn().mockResolvedValue({
      data: {
        url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
      },
      error: null,
    });

    const result = await startUnifiedOAuth("google", {
      auth: {
        signInWithOAuth,
      },
    } as any);

    expect(signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        options: expect.objectContaining({
          redirectTo: "https://hushhtech.com/auth/callback?redirect=%2Fprofile",
          queryParams: { access_type: "offline", prompt: "consent" },
        }),
      })
    );
    expect(assignMock).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=test"
    );
    expect(result).toEqual({
      ok: true,
      provider: "google",
      redirectTo:
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
    });
  });

  it("accepts Firebase-managed redirects that return no authorization URL", async () => {
    const signInWithOAuth = vi.fn().mockResolvedValue({
      data: { provider: "google", url: null },
      error: null,
    });

    const result = await startUnifiedOAuth("google", {
      auth: { signInWithOAuth },
    } as any);

    expect(assignMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      provider: "google",
      redirectTo: "https://hushhtech.com/auth/callback",
    });
  });
});
