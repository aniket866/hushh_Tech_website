// @vitest-environment jsdom

import fs from "node:fs";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/hushh-tech-nav-drawer/HushhTechNavDrawer", () => ({
  default: () => null,
}));

vi.mock("../src/hooks/useStockQuotes", () => ({
  useStockQuotes: () => ({
    quotes: [
      {
        symbol: "AAPL",
        displaySymbol: "AAPL",
        name: "Apple",
        currentPrice: 0,
        change: 0,
        percentChange: 1.2,
        isUp: true,
        logo: "https://example.com/aapl.png",
        // The strip renders nothing unless a row is backed by a real provider response. Without
        // this the ticker is correctly absent and both assertions below have nothing to inspect.
        hasQuote: true,
      },
    ],
    loading: true,
    lastUpdated: null,
  }),
}));

import HushhTechHeader from "../src/components/hushh-tech-header/HushhTechHeader";

describe("HushhTechHeader layout stability", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  it("reserves intrinsic space for async ticker logos", async () => {
    await act(async () => {
      root.render(React.createElement(HushhTechHeader));
    });

    const tickerLogo = container.querySelector<HTMLImageElement>(
      "img[alt='AAPL logo']",
    );

    expect(tickerLogo?.getAttribute("width")).toBe("12");
    expect(tickerLogo?.getAttribute("height")).toBe("12");
    expect(tickerLogo?.getAttribute("loading")).toBe("lazy");
  });

  it("uses constant requestAnimationFrame motion for the live market ticker", async () => {
    await act(async () => {
      root.render(React.createElement(HushhTechHeader));
    });

    const tickerTrack = container.querySelector("[data-ticker-motion='constant-raf']");
    const styleText = Array.from(container.querySelectorAll("style"))
      .map((style) => style.textContent || "")
      .join("\n");

    expect(tickerTrack).not.toBeNull();
    expect(styleText).toContain("will-change: transform");
    expect(styleText).not.toContain("animation: hushh-ticker-scroll");
    expect(styleText).not.toContain("animation: ticker-scroll");
  });

  it("keeps both ticker surfaces on the same reading speed", () => {
    const modernHeader = fs.readFileSync(
      "src/components/hushh-tech-header/HushhTechHeader.tsx",
      "utf8",
    );
    const sharedTicker = fs.readFileSync(
      "src/components/hushh-tech-ticker/HushhTechTicker.tsx",
      "utf8",
    );
    const legacyNavbar = fs.readFileSync("src/components/Navbar.tsx", "utf8");

    const hook = fs.readFileSync("src/hooks/useConstantTickerMotion.ts", "utf8");

    expect(modernHeader).toContain("HushhTechTicker");
    // The number matters less than the three staying equal: two tickers running at different
    // speeds on the same site is the defect this pins down. 168 read as motion rather than as
    // information, so all three moved together to 52.
    expect(sharedTicker).toContain("const TICKER_SCROLL_PIXELS_PER_SECOND = 52;");
    expect(legacyNavbar).toContain("const TICKER_SCROLL_PIXELS_PER_SECOND = 52;");
    expect(hook).toContain("const DEFAULT_TICKER_PIXELS_PER_SECOND = 52;");
    expect(hook).toContain("Math.min(40, Math.max(0, time - lastTime))");
  });
});
