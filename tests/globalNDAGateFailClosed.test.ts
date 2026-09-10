// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { createRoot, type Root } from "react-dom/client";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigateMock = vi.fn();
const checkNDAStatusMock = vi.fn();
const compatibilityModeMock = vi.fn();
const researchModeMock = vi.fn();
const legacySupabaseAuthMock = vi.fn();

let authSessionMock: {
  status: string;
  session: {
    user: {
      id: string;
      app_metadata?: Record<string, unknown>;
    };
  } | null;
} = {
  status: "authenticated",
  session: {
    user: {
      id: "unsigned-user",
    },
  },
};

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );

  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock("../src/auth/AuthSessionProvider", () => ({
  useAuthSession: () => authSessionMock,
}));

vi.mock("../src/services/nda/ndaService", () => ({
  checkNDAStatus: (...args: unknown[]) => checkNDAStatusMock(...args),
}));

vi.mock("../src/services/hushhResearch/firebaseAuth", () => ({
  isHushhResearchAuthMode: (...args: unknown[]) => researchModeMock(...args),
}));

vi.mock("../src/services/hushhResearch/compatibility", () => {
  class MockCompatibilityError extends Error {
    state: string;

    constructor(state: string) {
      super(state);
      this.state = state;
    }
  }

  return {
    getHushhResearchCompatibilityMode: (...args: unknown[]) =>
      compatibilityModeMock(...args),
    HushhResearchCompatibilityError: MockCompatibilityError,
  };
});

import GlobalNDAGate from "../src/components/GlobalNDAGate";

describe("GlobalNDAGate fail-closed rendering", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flushPromises = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    compatibilityModeMock.mockResolvedValue("legacy");
    researchModeMock.mockReturnValue(false);
    vi.useFakeTimers();
    window.sessionStorage.clear();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    authSessionMock = {
      status: "authenticated",
      session: {
        user: {
          id: "unsigned-user",
        },
      },
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("does not render protected children for an authenticated user without a signed NDA", async () => {
    checkNDAStatusMock.mockResolvedValue({
      hasSignedNda: false,
      signedAt: null,
      ndaVersion: null,
    });

    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          null,
          React.createElement(
            MemoryRouter,
            { initialEntries: ["/onboarding/step5"] },
            React.createElement(
              GlobalNDAGate,
              null,
              React.createElement("main", { "data-testid": "protected-child" }),
            ),
          ),
        ),
      );
    });

    await flushPromises();

    expect(checkNDAStatusMock).toHaveBeenCalledWith("unsigned-user");
    expect(navigateMock).toHaveBeenCalledWith("/sign-nda", { replace: true });
    expect(window.sessionStorage.getItem("nda_redirect_after")).toBe(
      "/onboarding/step5",
    );
    expect(
      container.querySelector("[data-testid='protected-child']"),
    ).toBeNull();
  });

  it("does not call legacy NDA or grant a protected route in Research mode", async () => {
    authSessionMock = {
      status: "authenticated",
      session: {
        user: {
          id: "hushh-tech-uat-synthetic-ada-001",
          app_metadata: { auth_source: "hushh-research" },
        },
      },
    };
    compatibilityModeMock.mockResolvedValue("research");

    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          null,
          React.createElement(
            MemoryRouter,
            { initialEntries: ["/onboarding/step-5"] },
            React.createElement(
              GlobalNDAGate,
              null,
              React.createElement("main", { "data-testid": "protected-child" }),
            ),
          ),
        ),
      );
    });
    await flushPromises();

    expect(checkNDAStatusMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
    expect(
      container.querySelector("[data-testid='protected-child']"),
    ).toBeNull();
  });

  it.each(['timeout', 'identity failure'])("denies main-app access on %s and exposes a real retryable error", async (failure) => {
    if (failure === 'timeout') checkNDAStatusMock.mockReturnValue(new Promise(() => {}));
    else checkNDAStatusMock.mockRejectedValue(new Error('Identity requires review.'));
    await act(async () => {
      root.render(React.createElement(ChakraProvider, null,
        React.createElement(MemoryRouter, { initialEntries: ['/onboarding/step5'] },
          React.createElement(GlobalNDAGate, null, React.createElement('main', { 'data-testid': 'protected-child' })))));
    });
    await flushPromises();
    if (failure === 'timeout') await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.querySelector('[data-testid="protected-child"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(failure === 'timeout' ? 'timed out' : 'Identity requires review');
    expect(navigateMock).not.toHaveBeenCalled();
    checkNDAStatusMock.mockResolvedValue({ hasSignedNda: true });
    await act(async () => { container.querySelector('[role="alert"] button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flushPromises();
    expect(container.querySelector('[data-testid="protected-child"]')).not.toBeNull();
  });

  it("allows a public route without treating Research access-state as NDA proof", async () => {
    authSessionMock = {
      status: "authenticated",
      session: {
        user: {
          id: "hushh-tech-uat-synthetic-ada-001",
          app_metadata: { auth_source: "hushh-research" },
        },
      },
    };
    compatibilityModeMock.mockResolvedValue("research");

    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          null,
          React.createElement(
            MemoryRouter,
            { initialEntries: ["/"] },
            React.createElement(
              GlobalNDAGate,
              null,
              React.createElement("main", { "data-testid": "public-child" }),
            ),
          ),
        ),
      );
    });
    await flushPromises();

    expect(checkNDAStatusMock).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='public-child']")).not.toBeNull();
  });

  it("fails closed instead of optimistically granting NDA access on timeout", async () => {
    authSessionMock = {
      status: "authenticated",
      session: {
        user: {
          id: "hushh-tech-uat-synthetic-ada-001",
          app_metadata: { auth_source: "hushh-research" },
        },
      },
    };
    compatibilityModeMock.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          null,
          React.createElement(
            MemoryRouter,
            { initialEntries: ["/sign-nda"] },
            React.createElement(
              GlobalNDAGate,
              null,
              React.createElement("main", { "data-testid": "nda-child" }),
            ),
          ),
        ),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(checkNDAStatusMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
    expect(container.querySelector("[data-testid='nda-child']")).toBeNull();
  });

  it("never mounts the legacy OAuth callback while anonymous Research mode is active", async () => {
    authSessionMock = { status: "anonymous", session: null };
    researchModeMock.mockReturnValue(true);

    const LegacyCallbackProbe = () => {
      React.useEffect(() => {
        legacySupabaseAuthMock();
      }, []);
      return React.createElement("main", {
        "data-testid": "legacy-callback-child",
      });
    };

    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          null,
          React.createElement(
            MemoryRouter,
            { initialEntries: ["/auth/callback"] },
            React.createElement(
              GlobalNDAGate,
              null,
              React.createElement(LegacyCallbackProbe),
            ),
          ),
        ),
      );
    });
    await flushPromises();

    expect(legacySupabaseAuthMock).not.toHaveBeenCalled();
    expect(checkNDAStatusMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
    expect(
      container.querySelector("[data-testid='legacy-callback-child']"),
    ).toBeNull();
  });

  it("preserves the anonymous legacy OAuth callback outside Research mode", async () => {
    authSessionMock = { status: "anonymous", session: null };

    const LegacyCallbackProbe = () => {
      React.useEffect(() => {
        legacySupabaseAuthMock();
      }, []);
      return React.createElement("main", {
        "data-testid": "legacy-callback-child",
      });
    };

    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          null,
          React.createElement(
            MemoryRouter,
            { initialEntries: ["/auth/callback"] },
            React.createElement(
              GlobalNDAGate,
              null,
              React.createElement(LegacyCallbackProbe),
            ),
          ),
        ),
      );
    });
    await flushPromises();

    expect(legacySupabaseAuthMock).toHaveBeenCalledOnce();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-testid='legacy-callback-child']"),
    ).not.toBeNull();
  });

  it("keeps the dedicated Research start route available before a session", async () => {
    authSessionMock = { status: "anonymous", session: null };
    researchModeMock.mockReturnValue(true);

    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          null,
          React.createElement(
            MemoryRouter,
            { initialEntries: ["/auth/hushh-research/start"] },
            React.createElement(
              GlobalNDAGate,
              null,
              React.createElement("main", {
                "data-testid": "research-start-child",
              }),
            ),
          ),
        ),
      );
    });
    await flushPromises();

    expect(checkNDAStatusMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-testid='research-start-child']"),
    ).not.toBeNull();
  });

  it("never mounts a forbidden legacy child during an allowed-to-blocked transition", async () => {
    authSessionMock = { status: "anonymous", session: null };
    researchModeMock.mockReturnValue(true);

    const RouteProbe = () => {
      const location = useLocation();
      const isResearchStart = location.pathname
        .toLowerCase()
        .includes("hushh-research/start");
      React.useEffect(() => {
        if (!isResearchStart) {
          legacySupabaseAuthMock();
        }
      }, [isResearchStart]);

      if (isResearchStart) {
        return React.createElement(
          Link,
          { to: "/metrics", "data-testid": "leave-research" },
          "Metrics",
        );
      }

      return React.createElement("main", {
        "data-testid": "legacy-metrics-child",
      });
    };

    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          null,
          React.createElement(
            MemoryRouter,
            { initialEntries: ["/auth/hushh-research/start"] },
            React.createElement(
              GlobalNDAGate,
              null,
              React.createElement(RouteProbe),
            ),
          ),
        ),
      );
    });
    await flushPromises();

    const link = container.querySelector("[data-testid='leave-research']");
    await act(async () => {
      link?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await flushPromises();

    expect(legacySupabaseAuthMock).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-testid='legacy-metrics-child']"),
    ).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
  });

  it('does not reuse public NDA-page access as proof of signed consent on navigation', async () => {
    checkNDAStatusMock.mockResolvedValue({ hasSignedNda: false });
    const mountedProtected = vi.fn();
    const ProtectedProbe = () => {
      React.useEffect(() => { mountedProtected(); }, []);
      return React.createElement('main');
    };
    const RouteProbe = () => useLocation().pathname === '/sign-nda'
      ? React.createElement(Link, { to: '/onboarding/step5', 'data-testid': 'leave-nda' }, 'Continue')
      : React.createElement(ProtectedProbe);
    await act(async () => {
      root.render(React.createElement(ChakraProvider, null,
        React.createElement(MemoryRouter, { initialEntries: ['/sign-nda'] }, React.createElement(GlobalNDAGate, null, React.createElement(RouteProbe)))));
    });
    await act(async () => { container.querySelector('[data-testid="leave-nda"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await flushPromises();
    expect(mountedProtected).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/sign-nda', { replace: true });
  });
});
