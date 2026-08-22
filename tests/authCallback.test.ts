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
const mockExchangeCodeForSession = vi.fn();
const mockSetSession = vi.fn();
const mockGetSession = vi.fn();
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
        exchangeCodeForSession: (...args: unknown[]) =>
          mockExchangeCodeForSession(...args),
        setSession: (...args: unknown[]) => mockSetSession(...args),
        getSession: (...args: unknown[]) => mockGetSession(...args),
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

    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: "stale-user" } } },
      error: null,
    });
    mockExchangeCodeForSession.mockResolvedValue({
      data: { session: { access_token: "fresh-token" } },
      error: null,
    });
    mockSetSession.mockResolvedValue({ error: null });
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

  it("always exchanges the returned OAuth code even if a stale session already exists", async () => {
    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          { theme },
          React.createElement(
            MemoryRouter,
            {
              initialEntries: ["/auth/callback?code=fresh-code&redirect=%2Fdelete-account"],
            },
            React.createElement(AuthCallback)
          )
        )
      );
    });
    await flush();

    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("fresh-code");
    expect(revalidateSessionMock).toHaveBeenCalled();
    expect(replaceStateSpy).toHaveBeenCalled();

    await act(async () => {
      vi.runAllTimers();
    });

    expect(navigateMock).toHaveBeenCalledWith("/delete-account");
  });
});
