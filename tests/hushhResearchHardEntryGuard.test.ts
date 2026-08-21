// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configHarness = vi.hoisted(() => ({
  client: undefined as
    | { auth: { stopAutoRefresh: ReturnType<typeof vi.fn> } }
    | undefined,
}));

vi.mock("../src/resources/config/config", () => ({
  default: {
    get supabaseClient() {
      return configHarness.client;
    },
  },
}));

import HushhResearchHardEntryGuard from "../src/components/HushhResearchHardEntryGuard";

describe("Hushh Research hard SPA entry", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    configHarness.client = undefined;
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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

  it("stops a pre-existing legacy client and reloads before mounting Research children", async () => {
    const stopAutoRefresh = vi.fn();
    const replaceLocation = vi.fn();
    const legacyApiCall = vi.fn();
    configHarness.client = { auth: { stopAutoRefresh } };

    const ResearchChild = () => {
      React.useEffect(() => {
        legacyApiCall();
      }, []);
      return React.createElement("main", { "data-testid": "research-child" });
    };

    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          {
            initialEntries: [
              "/AUTH/HUSHH-RESEARCH/START/?launch=once#continue",
            ],
          },
          React.createElement(
            HushhResearchHardEntryGuard,
            { replaceLocation },
            React.createElement(ResearchChild),
          ),
        ),
      );
    });

    expect(stopAutoRefresh).toHaveBeenCalledOnce();
    expect(replaceLocation).toHaveBeenCalledWith(
      "/auth/hushh-research/start?launch=once#continue",
    );
    expect(legacyApiCall).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='research-child']")).toBeNull();
  });

  it("renders a clean direct Research entry without reloading", async () => {
    const replaceLocation = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/auth/hushh-research/callback/"] },
          React.createElement(
            HushhResearchHardEntryGuard,
            { replaceLocation },
            React.createElement("main", { "data-testid": "research-child" }),
          ),
        ),
      );
    });

    expect(replaceLocation).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='research-child']")).not.toBeNull();
  });
});
