// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import theme from "../src/theme";

const navigateMock = vi.fn();
const revalidateSessionMock = vi.fn();
const mockGetRedirectResult = vi.fn();
const maybeSingleMock = vi.fn();
const selectMock = vi.fn(() => ({
  eq: vi.fn(() => ({
    maybeSingle: maybeSingleMock,
  })),
}));
const fromMock = vi.fn(() => ({
  select: selectMock,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom"
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock("../src/resources/config/config", () => ({
  default: {
    gcpBackendClient: {
      auth: {
        getRedirectResult: (...args: unknown[]) => mockGetRedirectResult(...args),
      },
      from: (...args: unknown[]) => fromMock(...args),
    },
  },
}));

vi.mock("../src/auth/AuthSessionProvider", () => ({
  useAuthSession: () => ({
    revalidateSession: (...args: unknown[]) => revalidateSessionMock(...args),
  }),
}));

import AuthCallback from "../src/pages/AuthCallback";
import { FINANCIAL_LINK_ROUTE } from "../src/services/onboarding/flow";

describe("AuthCallback", () => {
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
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    mockGetRedirectResult.mockResolvedValue({
      data: { session: { access_token: "fresh-token" } },
      error: null,
    });
    revalidateSessionMock.mockResolvedValue({
      status: "authenticated",
      session: {
        access_token: "fresh-token",
        user: { id: "fresh-user", email: "fresh@hushh.ai" },
      },
      user: { id: "fresh-user", email: "fresh@hushh.ai" },
    });
    maybeSingleMock.mockResolvedValue({
      data: { is_completed: false, current_step: 1 },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("resolves the Firebase redirect result before revalidating the session", async () => {
    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          { theme },
          React.createElement(
            MemoryRouter,
            {
              initialEntries: ["/auth/callback?redirect=%2Fdelete-account"],
            },
            React.createElement(AuthCallback)
          )
        )
      );
    });
    await flush();

    expect(mockGetRedirectResult).toHaveBeenCalledOnce();
    expect(revalidateSessionMock).toHaveBeenCalled();
    expect(replaceStateSpy).toHaveBeenCalled();

    await act(async () => {
      vi.runAllTimers();
    });

    expect(navigateMock).toHaveBeenCalledWith("/delete-account");
  });

  const renderCallback = async () => {
    await act(async () => {
      root.render(React.createElement(ChakraProvider, { theme },
        React.createElement(MemoryRouter, { initialEntries: ["/auth/callback"] },
          React.createElement(AuthCallback))));
    });
    await flush();
  };

  it.each(["google", "apple"])("routes a restored new %s user with no onboarding row to onboarding", async (provider) => {
    const user = { id: `${provider}-native-uid`, app_metadata: { provider } };
    revalidateSessionMock.mockResolvedValue({ status: "authenticated", user, session: { user } });
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    await renderCallback();
    expect(container.textContent).toContain("Welcome to HushhTech!");
    expect(fromMock).toHaveBeenCalledWith("onboarding_data");
    expect(fromMock).toHaveBeenCalledWith("user_financial_data");
    await act(async () => { vi.runAllTimers(); });
    expect(navigateMock).toHaveBeenCalledExactlyOnceWith(FINANCIAL_LINK_ROUTE);
    expect(mockGetRedirectResult).toHaveBeenCalledOnce();
  });

  it("reproduces the reported error when onboarding rejects a raw Firebase UID after session restore", async () => {
    const failure = { code: "22P02", message: "GCP data service unavailable." };
    maybeSingleMock.mockResolvedValue({ data: null, error: failure });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    await renderCallback();
    expect(mockGetRedirectResult).toHaveBeenCalledOnce();
    expect(revalidateSessionMock).toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith("Verification error:", failure);
    expect(container.textContent).toContain("An unexpected error occurred");
    expect(navigateMock).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });
});
