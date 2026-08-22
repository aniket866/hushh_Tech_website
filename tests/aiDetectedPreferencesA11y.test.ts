// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const maybeSingleMock = vi.hoisted(() => vi.fn());

vi.mock("../src/resources/config/config", () => ({
  default: {
    gcpBackendClient: {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: maybeSingleMock,
          })),
        })),
      })),
    },
  },
}));

import AIDetectedPreferences from "../src/components/profile/AIDetectedPreferences";

describe("AIDetectedPreferences accessibility", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    maybeSingleMock.mockResolvedValue({
      data: {
        confidence: 0.82,
        field_sources: {
          "preferences.diet": "ai_detected",
        },
        net_worth_score: 72,
        preferences: {
          diet: "Vegetarian",
          brands: "Apple",
        },
        updated_at: "2026-05-10T12:00:00.000Z",
      },
      error: null,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    maybeSingleMock.mockReset();
  });

  async function renderPreferences() {
    await act(async () => {
      root.render(React.createElement(AIDetectedPreferences, { userId: "user-1" }));
    });

    await act(async () => {
      await Promise.resolve();
    });
  }

  it("labels collapsible AI analytics categories without nested duplicate landmarks", async () => {
    await renderPreferences();

    const trigger = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Food & Drink")
    );

    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(trigger?.getAttribute("aria-controls")).toBe("ai-preferences-food-drink-panel");
    expect(trigger?.id).toBe("ai-preferences-food-drink-trigger");

    const panel = container.querySelector("#ai-preferences-food-drink-panel");
    expect(panel).not.toBeNull();
    expect(panel?.hasAttribute("role")).toBe(false);
    expect(panel?.hasAttribute("aria-labelledby")).toBe(false);

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("#ai-preferences-food-drink-panel")).toBeNull();
  });
});
