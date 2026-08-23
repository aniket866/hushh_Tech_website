// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const useAuthSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../src/auth/AuthSessionProvider", () => ({
  useAuthSession: useAuthSessionMock,
}));

import NDAAdminPage from "../src/pages/nda-admin";

const ACCESS_TOKEN = "firebase-fund-admin-token-do-not-log";

function authenticatedState(fundAdmin: boolean) {
  return {
    status: "authenticated",
    session: { access_token: ACCESS_TOKEN },
    user: { app_metadata: { fund_admin: fundAdmin } },
    signOut: vi.fn().mockResolvedValue(undefined),
  };
}

describe("NDAAdminPage", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    useAuthSessionMock.mockReturnValue(authenticatedState(true));
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        records: [
          {
            record_id: "nda_7f9b2c1a",
            signed_at: "2026-05-08T12:00:00.000Z",
            nda_version: "v1.0",
            pdf_available: true,
            highlighted: true,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function render(path = "/nda-admin") {
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: [path] },
          React.createElement(NDAAdminPage),
        ),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("uses the same-origin Firebase admin contract and keeps the table scrollable", async () => {
    await render("/nda-admin?highlight=user_ref_123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/functions/v1/nda-admin-fetch");
    expect(options).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });
    expect(JSON.parse(options.body)).toEqual({ highlightUserId: "user_ref_123" });

    const table = container.querySelector("table");
    expect(table).toBeInstanceOf(HTMLTableElement);
    const wrapper = table?.parentElement;
    expect(wrapper?.style.overflowX).toBe("auto");
    expect(wrapper?.style.width).toBe("100%");
    expect(table?.style.minWidth).toBe("860px");
    expect(container.textContent).toContain("nda_7f9b2c1a");
    expect(container.textContent).not.toContain("@example.com");
    expect(container.textContent).not.toContain("127.0.0.1");
  });

  it("rejects a signed-in user without the fund_admin custom claim before fetch", async () => {
    useAuthSessionMock.mockReturnValue(authenticatedState(false));

    await render();

    expect(container.textContent).toContain("Access denied.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not restore access from the removed session password flag", async () => {
    sessionStorage.setItem("nda_admin_auth", "true");
    useAuthSessionMock.mockReturnValue({
      status: "anonymous",
      session: null,
      user: null,
      signOut: vi.fn(),
    });

    await render();

    expect(container.textContent).toContain("Sign in required.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
