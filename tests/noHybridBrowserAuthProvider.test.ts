// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:5173/"}

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.fn();
const mockGetUser = vi.fn();
const mockOnAuthStateChange = vi.fn();
const mockSignOut = vi.fn();

vi.mock("../src/resources/config/config", () => ({
  default: {
    redirect_url: "http://127.0.0.1:5173/auth/callback",
    gcpBackendClient: {
      auth: {
        storageKey: "hushh-tech-fixture-auth",
        getSession: (...args: unknown[]) => mockGetSession(...args),
        getUser: (...args: unknown[]) => mockGetUser(...args),
        onAuthStateChange: (...args: unknown[]) => mockOnAuthStateChange(...args),
        signOut: (...args: unknown[]) => mockSignOut(...args),
      },
    },
  },
}));

import {
  AuthSessionProvider,
  useAuthSession,
} from "../src/auth/AuthSessionProvider";
import { NO_HYBRID_BROWSER_FIXTURE_GLOBAL } from "../src/auth/noHybridBrowserFixture";

function Harness() {
  const { status, user, signOut, revalidateSession } = useAuthSession();
  return React.createElement(
    "main",
    null,
    React.createElement("output", { "data-testid": "status" }, status),
    React.createElement("output", { "data-testid": "user" }, user?.id || ""),
    React.createElement(
      "button",
      { type: "button", "data-testid": "sign-out", onClick: () => void signOut() },
      "Sign out",
    ),
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": "revalidate",
        onClick: () => void revalidateSession(),
      },
      "Revalidate",
    ),
  );
}

describe("no-hybrid browser fixture provider lifecycle", () => {
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
    window[NO_HYBRID_BROWSER_FIXTURE_GLOBAL] = {
      schema_version: 1,
      contract_id: "hushh-tech-no-hybrid-browser-auth-v1",
      authority: "hushh-tech-uat",
      persona: "firebase-user-a",
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window[NO_HYBRID_BROWSER_FIXTURE_GLOBAL];
  });

  it("signs out once, clears the descriptor, and cannot reauthenticate", async () => {
    await act(async () => {
      root.render(React.createElement(AuthSessionProvider, null, React.createElement(Harness)));
    });
    await flush();

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe(
      "authenticated",
    );
    expect(container.querySelector('[data-testid="user"]')?.textContent).toBe(
      "no-hybrid-firebase-user-a",
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="sign-out"]')
        ?.click();
    });
    await flush();

    expect(window[NO_HYBRID_BROWSER_FIXTURE_GLOBAL]).toBeUndefined();
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe(
      "anonymous",
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="revalidate"]')
        ?.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe(
      "anonymous",
    );
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockOnAuthStateChange).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
