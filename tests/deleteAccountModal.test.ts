// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshSessionMock = vi.fn();
const revalidateSessionMock = vi.fn();
const handleAccountDeletedMock = vi.fn();
const toastMock = vi.fn();
const useAuthSessionMock = vi.fn();

vi.mock("@chakra-ui/react", async () => ({
  useToast: () => toastMock,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../src/resources/config/config", () => ({
  default: {
    gcpBackendClient: {
      auth: {
        refreshSession: (...args: unknown[]) => refreshSessionMock(...args),
      },
    },
  },
}));

vi.mock("../src/auth/AuthSessionProvider", () => ({
  useAuthSession: () => useAuthSessionMock(),
}));

import DeleteAccountModal from "../src/components/DeleteAccountModal";

describe("DeleteAccountModal", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    refreshSessionMock.mockResolvedValue({
      data: { session: { access_token: "fresh-access-token" } },
      error: null,
    });
    revalidateSessionMock.mockResolvedValue({
      status: "authenticated",
      session: { access_token: "stale-access-token" },
    });
    handleAccountDeletedMock.mockResolvedValue(undefined);
    useAuthSessionMock.mockReturnValue({
      session: { access_token: "stale-access-token" },
      revalidateSession: revalidateSessionMock,
      handleAccountDeleted: handleAccountDeletedMock,
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function renderModal(onAccountDeleted = vi.fn()) {
    await act(async () => {
      root.render(
        React.createElement(DeleteAccountModal, {
          isOpen: true,
          onClose: vi.fn(),
          onAccountDeleted,
        })
      );
    });
    await flush();
    return onAccountDeleted;
  }

  async function confirmDeletion() {
    const input = container.querySelector("input");
    const deleteButton = container.querySelectorAll("button")[0];

    if (!(input instanceof HTMLInputElement) || !(deleteButton instanceof HTMLButtonElement)) {
      throw new Error("Delete confirmation controls were not rendered");
    }

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;

      valueSetter?.call(input, "DELETE");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    expect(deleteButton.disabled).toBe(false);

    await act(async () => {
      deleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  }

  it("shows the hard-delete payment-audit policy in the modal copy", async () => {
    await renderModal();

    expect(container.textContent).toContain("minimal de-identified");
    expect(container.textContent).toContain("payment audit");
  });

  it("only completes the flow when the backend returns success: true", async () => {
    const onAccountDeleted = await renderModal();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        deletedScopes: [],
        retainedScopes: ["audit.payment_minimum"],
      }),
    });

    await confirmDeletion();

    await act(async () => {
      vi.runAllTimers();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/delete-account",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-access-token",
        }),
      })
    );
    expect(handleAccountDeletedMock).toHaveBeenCalled();
    expect(onAccountDeleted).toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" })
    );
  });

  it("does not navigate away on a malformed success response", async () => {
    const onAccountDeleted = await renderModal();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await confirmDeletion();

    await act(async () => {
      vi.runAllTimers();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handleAccountDeletedMock).not.toHaveBeenCalled();
    expect(onAccountDeleted).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" })
    );
  });
});
