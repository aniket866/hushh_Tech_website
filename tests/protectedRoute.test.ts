// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = {
  status: "booting",
  session: null as { user?: { id?: string } } | null,
};
const onboardingProgressMock = vi.fn();

vi.mock("../src/auth/AuthSessionProvider", () => ({
  useAuthSession: () => ({
    status: authState.status,
    session: authState.session,
  }),
}));

vi.mock("../src/resources/config/config", () => ({
  default: {
    gcpBackendClient: {},
  },
}));

vi.mock("../src/services/onboarding/progress", () => ({
  fetchResolvedOnboardingProgress: (...args: unknown[]) =>
    onboardingProgressMock(...args),
}));

import ProtectedRoute from "../src/components/ProtectedRoute";

describe("ProtectedRoute", () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderProtectedRoute = (initialPath: string, routePath = initialPath) =>
    React.createElement(
      MemoryRouter,
      { initialEntries: [initialPath] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: routePath,
          element: React.createElement(
            ProtectedRoute,
            null,
            React.createElement("div", null, "protected content")
          ),
        })
      )
    );

  const createDeferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((promiseResolve) => {
      resolve = promiseResolve;
    });

    return { promise, resolve };
  };

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    authState.status = "booting";
    authState.session = null;
    onboardingProgressMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps showing the loading state while auth is booting", async () => {
    await act(async () => {
      root.render(renderProtectedRoute("/profile"));
    });

    await flush();

    expect(container.textContent).toContain("Loading...");
    expect(container.textContent).not.toContain("protected content");
  });

  it("allows the investor-profile alias once the financial-link gate is cleared", async () => {
    authState.status = "authenticated";
    authState.session = { user: { id: "user-123" } };
    onboardingProgressMock.mockResolvedValue({
      current_step: 1,
      is_completed: false,
      financial_link_status: "completed",
    });

    await act(async () => {
      root.render(renderProtectedRoute("/investor-profile"));
    });

    await flush();

    expect(container.textContent).toContain("protected content");
  });

  it("hides protected content while a new authenticated session resolves", async () => {
    authState.status = "authenticated";
    authState.session = { user: { id: "user-123" } };
    onboardingProgressMock.mockResolvedValueOnce({
      current_step: 9,
      is_completed: true,
      financial_link_status: "completed",
    });

    await act(async () => {
      root.render(renderProtectedRoute("/profile"));
    });

    await flush();

    expect(container.textContent).toContain("protected content");

    const nextProgress = createDeferred<{
      current_step: number;
      is_completed: boolean;
      financial_link_status: string;
    }>();
    authState.session = { user: { id: "user-456" } };
    onboardingProgressMock.mockReturnValueOnce(nextProgress.promise);

    await act(async () => {
      root.render(renderProtectedRoute("/profile"));
    });

    await flush();

    expect(container.textContent).toContain("Loading...");
    expect(container.textContent).not.toContain("protected content");

    await act(async () => {
      nextProgress.resolve({
        current_step: 9,
        is_completed: true,
        financial_link_status: "completed",
      });
      await nextProgress.promise;
    });

    await flush();

    expect(container.textContent).toContain("protected content");
  });
});
