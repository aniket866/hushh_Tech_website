// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import theme from "../src/theme";

const navigateMock = vi.fn();
const revalidateSessionMock = vi.fn();
const signOutMock = vi.fn();
const completeLaunchMock = vi.fn();
const startLaunchMock = vi.fn();
const clearResearchSessionMock = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom"
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock("../src/auth/AuthSessionProvider", () => ({
  useAuthSession: () => ({
    revalidateSession: revalidateSessionMock,
    signOut: signOutMock,
  }),
}));

vi.mock("../src/services/hushhResearch/firebaseAuth", () => ({
  clearHushhResearchLocalSession: (...args: unknown[]) =>
    clearResearchSessionMock(...args),
  completeHushhResearchLaunch: (...args: unknown[]) =>
    completeLaunchMock(...args),
  getHushhResearchLaunchFailureMessage: () => "This link has expired.",
  getHushhResearchLaunchStartFailureMessage: () =>
    "Launch could not start.",
  startHushhResearchLaunch: (...args: unknown[]) =>
    startLaunchMock(...args),
}));

import HushhResearchAuthCallback from "../src/pages/HushhResearchAuthCallback";
import HushhResearchAuthStart from "../src/pages/HushhResearchAuthStart";

describe("Hushh Research auth routes", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    window.history.replaceState({}, "", "/");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    completeLaunchMock.mockResolvedValue({
      ok: true,
      uid: "firebase-uid-123",
      linkState: "READY",
    });
    revalidateSessionMock.mockResolvedValue({
      status: "authenticated",
      session: {
        access_token: "firebase-id-token",
        user: { id: "firebase-uid-123" },
      },
      user: { id: "firebase-uid-123" },
    });
    startLaunchMock.mockResolvedValue({
      ok: true,
      launchUrl:
        "https://uat.one.hushh.ai/products/hushh-tech/launch?launch_id=once",
      expiresIn: 60,
    });
    signOutMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("exchanges a callback once under React Strict Mode", async () => {
    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    await act(async () => {
      root.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(
            ChakraProvider,
            { theme },
            React.createElement(
              MemoryRouter,
              {
                initialEntries: [
                  "/auth/hushh-research/callback?code=single-use-code&state=callback-state&source=hushh-research&redirect=%2Fprofile",
                ],
              },
              React.createElement(HushhResearchAuthCallback)
            )
          )
        )
      );
    });
    await flush();

    expect(completeLaunchMock).toHaveBeenCalledTimes(1);
    expect(completeLaunchMock).toHaveBeenCalledWith({
      code: "single-use-code",
      state: "callback-state",
      source: "hushh-research",
    });
    expect(revalidateSessionMock).toHaveBeenCalledTimes(1);
    expect(replaceStateSpy).toHaveBeenCalledWith(
      {},
      document.title,
      "/auth/hushh-research/callback"
    );
    expect(container.textContent).toContain("Signed in");

    expect(navigateMock).toHaveBeenCalledWith("/profile", { replace: true });
  });

  it("replaces a legacy redirect target with the Research-safe home route", async () => {
    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          { theme },
          React.createElement(
            MemoryRouter,
            {
              initialEntries: [
                "/auth/hushh-research/callback?code=single-use-code&state=callback-state&source=hushh-research&redirect=%2Fmetrics",
              ],
            },
            React.createElement(HushhResearchAuthCallback),
          ),
        ),
      );
    });
    await flush();

    expect(completeLaunchMock).toHaveBeenCalledOnce();
    expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
  });

  it("rejects a missing anti-confusion source before exchange", async () => {
    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          { theme },
          React.createElement(
            MemoryRouter,
            {
              initialEntries: [
                "/auth/hushh-research/callback?code=single-use-code&state=callback-state",
              ],
            },
            React.createElement(HushhResearchAuthCallback)
          )
        )
      );
    });
    await flush();

    expect(completeLaunchMock).not.toHaveBeenCalled();
    expect(revalidateSessionMock).not.toHaveBeenCalled();
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(clearResearchSessionMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Open a new link.");
  });

  it("keeps a failed callback on the dedicated error state", async () => {
    completeLaunchMock.mockResolvedValue({
      ok: false,
      reason: "exchange_rejected",
    });

    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          { theme },
          React.createElement(
            MemoryRouter,
            {
              initialEntries: [
                "/auth/hushh-research/callback?code=used-code&state=callback-state&source=hushh-research",
              ],
            },
            React.createElement(HushhResearchAuthCallback)
          )
        )
      );
    });
    await flush();

    expect(container.textContent).toContain("Sign-in failed");
    expect(container.textContent).toContain("This link has expired.");
    expect(revalidateSessionMock).not.toHaveBeenCalled();
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("clears provider state when the exchanged UID does not match", async () => {
    revalidateSessionMock.mockResolvedValue({
      status: "authenticated",
      session: {
        access_token: "firebase-id-token",
        user: { id: "another-firebase-uid" },
      },
      user: { id: "another-firebase-uid" },
    });

    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          { theme },
          React.createElement(
            MemoryRouter,
            {
              initialEntries: [
                "/auth/hushh-research/callback?code=single-use-code&state=callback-state&source=hushh-research",
              ],
            },
            React.createElement(HushhResearchAuthCallback)
          )
        )
      );
    });
    await flush();

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Sign-in could not finish.");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("starts the launch once under React Strict Mode", async () => {
    const navigateToLaunch = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(
            ChakraProvider,
            { theme },
            React.createElement(HushhResearchAuthStart, { navigateToLaunch })
          )
        )
      );
    });
    await flush();

    expect(startLaunchMock).toHaveBeenCalledTimes(1);
    expect(navigateToLaunch).toHaveBeenCalledWith(
      "https://uat.one.hushh.ai/products/hushh-tech/launch?launch_id=once"
    );
  });

  it("shows a short retry state when launch cannot start", async () => {
    startLaunchMock.mockResolvedValue({
      ok: false,
      reason: "start_rejected",
    });

    await act(async () => {
      root.render(
        React.createElement(
          ChakraProvider,
          { theme },
          React.createElement(HushhResearchAuthStart, {
            navigateToLaunch: vi.fn(),
          })
        )
      );
    });
    await flush();

    expect(container.textContent).toContain("Launch failed");
    expect(container.textContent).toContain("Launch could not start.");
    expect(container.textContent).toContain("Try again");
  });

  it("registers dedicated start and callback routes without changing login", () => {
    const appSource = readFileSync("src/App.tsx", "utf8");

    expect(appSource).toContain(
      '<Route path="/auth/hushh-research/start" element={<HushhResearchAuthStart />} />'
    );
    expect(appSource).toContain(
      '<Route path="/auth/hushh-research/callback" element={<HushhResearchAuthCallback />} />'
    );
    expect(appSource).toContain(
      '<Route path="/auth/callback" element={<AuthCallback />} />'
    );
    expect(appSource).toContain(
      "const isResearchAuth = isHushhResearchAuthRoute(location.pathname);"
    );
    expect(appSource).toMatch(
      /if \(isResearchAuth \|\| isResearchBoundary\) \{[\s\S]*?showNavbar: false,[\s\S]*?showFooter: false,[\s\S]*?showMobileNav: false/
    );
    expect(appSource).toMatch(
      /<Router>[\s\S]*?<HushhResearchHardEntryGuard>[\s\S]*?<AuthSessionProvider>/
    );
  });
});
