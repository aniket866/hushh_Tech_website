// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.fn();
const mockGetUser = vi.fn();
const mockOnAuthStateChange = vi.fn();
const mockSupabaseSignOut = vi.fn();
const mockClearResearchSession = vi.fn();
const mockGetResearchSessionState = vi.fn();
const mockIsResearchMode = vi.fn();
const unsubscribeMock = vi.fn();

vi.mock("../src/resources/config/config", () => ({
  default: {
    redirect_url: "http://localhost:5173/auth/callback",
    gcpBackendClient: {
      auth: {
        storageKey: "sb-test-auth-token",
        getSession: (...args: unknown[]) => mockGetSession(...args),
        getUser: (...args: unknown[]) => mockGetUser(...args),
        onAuthStateChange: (...args: unknown[]) => mockOnAuthStateChange(...args),
        signOut: (...args: unknown[]) => mockSupabaseSignOut(...args),
      },
    },
  },
}));

vi.mock("../src/services/hushhResearch/firebaseAuth", () => ({
  clearHushhResearchLocalSession: (...args: unknown[]) =>
    mockClearResearchSession(...args),
  getHushhResearchSessionState: (...args: unknown[]) =>
    mockGetResearchSessionState(...args),
  isHushhResearchAuthMode: (...args: unknown[]) =>
    mockIsResearchMode(...args),
}));

import {
  AuthSessionProvider,
  useAuthSession,
} from "../src/auth/AuthSessionProvider";

function AuthHarness() {
  const { status, user, signOut } = useAuthSession();
  return React.createElement(
    "div",
    null,
    React.createElement("span", { "data-testid": "status" }, status),
    React.createElement("span", { "data-testid": "user-id" }, user?.id || ""),
    React.createElement(
      "button",
      { type: "button", onClick: () => void signOut() },
      "Sign out"
    )
  );
}

describe("AuthSessionProvider Hushh Research adapter", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    mockIsResearchMode.mockReturnValue(false);
    mockGetResearchSessionState.mockResolvedValue({ status: "inactive" });
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    mockOnAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: unsubscribeMock } },
    });
    mockSupabaseSignOut.mockResolvedValue({ error: null });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("does not fall back to Supabase on the Research callback", async () => {
    window.history.replaceState({}, "", "/auth/hushh-research/callback");
    mockIsResearchMode.mockReturnValue(true);
    mockGetResearchSessionState.mockResolvedValue({ status: "anonymous" });

    await act(async () => {
      root.render(
        React.createElement(
          AuthSessionProvider,
          null,
          React.createElement(AuthHarness)
        )
      );
    });
    await flush();

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe(
      "anonymous"
    );
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockOnAuthStateChange).not.toHaveBeenCalled();
  });

  it("publishes the canonical Firebase UID through the existing interface", async () => {
    const firebaseUser = {
      id: "firebase-uid-123",
      email: "researcher@hushh.ai",
      aud: "authenticated",
      role: "authenticated",
      app_metadata: { provider: "firebase" },
      user_metadata: {},
      created_at: "2026-08-21T00:00:00.000Z",
    };
    const firebaseSession = {
      access_token: "firebase-id-token",
      refresh_token: "firebase-refresh-token",
      token_type: "bearer",
      expires_in: 3600,
      user: firebaseUser,
    };
    mockIsResearchMode.mockReturnValue(true);
    mockGetResearchSessionState.mockResolvedValue({
      status: "authenticated",
      session: firebaseSession,
      user: firebaseUser,
    });

    await act(async () => {
      root.render(
        React.createElement(
          AuthSessionProvider,
          null,
          React.createElement(AuthHarness)
        )
      );
    });
    await flush();

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe(
      "authenticated"
    );
    expect(container.querySelector('[data-testid="user-id"]')?.textContent).toBe(
      "firebase-uid-123"
    );
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockSupabaseSignOut).not.toHaveBeenCalled();
  });

  it("logs a Research user out locally without remote Supabase sign-out", async () => {
    const firebaseUser = {
      id: "firebase-uid-123",
      aud: "authenticated",
      role: "authenticated",
      app_metadata: { provider: "firebase" },
      user_metadata: {},
      created_at: "2026-08-21T00:00:00.000Z",
    };
    mockIsResearchMode.mockReturnValue(true);
    mockGetResearchSessionState.mockResolvedValue({
      status: "authenticated",
      session: {
        access_token: "firebase-id-token",
        refresh_token: "firebase-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        user: firebaseUser,
      },
      user: firebaseUser,
    });

    await act(async () => {
      root.render(
        React.createElement(
          AuthSessionProvider,
          null,
          React.createElement(AuthHarness)
        )
      );
    });
    await flush();

    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Sign out"
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockClearResearchSession).toHaveBeenCalledWith({
      preserveMode: true,
    });
    expect(mockSupabaseSignOut).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe(
      "anonymous"
    );
  });

  it("preserves the Research boundary for a cross-tab deleted event", async () => {
    const firebaseUser = {
      id: "firebase-uid-123",
      aud: "authenticated",
      role: "authenticated",
      app_metadata: { auth_source: "hushh-research" },
      user_metadata: {},
      created_at: "2026-08-21T00:00:00.000Z",
    };
    mockIsResearchMode.mockReturnValue(true);
    mockGetResearchSessionState.mockResolvedValue({
      status: "authenticated",
      session: {
        access_token: "firebase-id-token",
        refresh_token: "firebase-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        user: firebaseUser,
      },
      user: firebaseUser,
    });

    await act(async () => {
      root.render(
        React.createElement(
          AuthSessionProvider,
          null,
          React.createElement(AuthHarness),
        ),
      );
    });
    await flush();
    mockClearResearchSession.mockClear();

    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "hushh_auth_event",
          newValue: JSON.stringify({ at: Date.now(), reason: "deleted" }),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockClearResearchSession).toHaveBeenCalledWith({
      preserveMode: true,
    });
    expect(mockSupabaseSignOut).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe(
      "invalidated",
    );
  });

  it("does not publish an in-flight Research refresh after sign-out", async () => {
    const firebaseUser = {
      id: "firebase-uid-123",
      aud: "authenticated",
      role: "authenticated",
      app_metadata: { provider: "firebase" },
      user_metadata: {},
      created_at: "2026-08-21T00:00:00.000Z",
    };
    let resolveResearchState: ((value: unknown) => void) | undefined;
    mockIsResearchMode.mockReturnValue(true);
    mockGetResearchSessionState.mockReturnValue(
      new Promise((resolve) => {
        resolveResearchState = resolve;
      })
    );

    await act(async () => {
      root.render(
        React.createElement(
          AuthSessionProvider,
          null,
          React.createElement(AuthHarness)
        )
      );
      await Promise.resolve();
    });

    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Sign out"
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      resolveResearchState?.({
        status: "authenticated",
        session: {
          access_token: "late-firebase-token",
          refresh_token: "late-refresh-token",
          token_type: "bearer",
          expires_in: 3600,
          user: firebaseUser,
        },
        user: firebaseUser,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe(
      "anonymous"
    );
    expect(container.querySelector('[data-testid="user-id"]')?.textContent).toBe(
      ""
    );
    expect(mockClearResearchSession).toHaveBeenCalledWith({
      preserveMode: true,
    });
  });

  it("keeps non-Research users on the unified Firebase session path", async () => {
    const legacyUser = { id: "firebase-user-123", email: "user@hushh.ai" };
    const legacySession = {
      access_token: "firebase-access-token",
      refresh_token: "firebase-refresh-token",
      token_type: "bearer",
      expires_in: 3600,
      user: legacyUser,
    };
    mockGetSession.mockResolvedValue({
      data: { session: legacySession },
      error: null,
    });
    mockGetUser.mockResolvedValue({ data: { user: legacyUser }, error: null });

    await act(async () => {
      root.render(
        React.createElement(
          AuthSessionProvider,
          null,
          React.createElement(AuthHarness)
        )
      );
    });
    await flush();

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe(
      "authenticated"
    );
    expect(container.querySelector('[data-testid="user-id"]')?.textContent).toBe(
      "firebase-user-123"
    );
    expect(mockGetSession).toHaveBeenCalled();
    expect(mockOnAuthStateChange).toHaveBeenCalled();
    expect(mockGetResearchSessionState).not.toHaveBeenCalled();
  });
});
