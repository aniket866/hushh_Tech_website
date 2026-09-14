import fs from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The ticker must never invent a number.
 *
 * It did. `useStockQuotes` seeded its initial state from a generator that produced
 * `percentChange: (Math.random() - 0.5) * 4` and `isUp: Math.random() > 0.4`, and the fetch error
 * path set an error string without ever clearing those values. With `/api/stock-quotes` returning
 * 404 FEATURE_DISABLED in both deployed environments, every visitor saw randomly generated
 * percentages under a green dot reading "Markets Live" and a timestamp.
 *
 * Nothing about that failed loudly: the strip rendered, the numbers were plausible, and the only
 * way to notice was to watch a symbol change value across two page loads with the market shut.
 * These assertions are deliberately crude source checks -- the defect was one expression, and a
 * crude check that runs is worth more here than a harness that mounts the hook.
 */

const read = (path: string) => fs.readFileSync(path, "utf8");

describe("stock ticker data integrity", () => {
  it("never synthesises a price, a movement or a direction", () => {
    const hook = read("src/hooks/useStockQuotes.ts");

    // Strip comments first: the fix documents the old expression, and matching that text would
    // make this test pass or fail on prose rather than on behaviour.
    const code = hook.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(code).not.toContain("Math.random");
  });

  it("marks a row that carries no quote, so nothing downstream can render it as one", () => {
    const hook = read("src/hooks/useStockQuotes.ts");

    expect(hook).toContain("hasQuote: boolean");
    // The placeholder set and the mapped provider response must disagree on this flag; if both
    // said the same thing the flag would be decorative.
    expect(hook).toContain("hasQuote: false");
    expect(hook).toContain("hasQuote: true");
  });

  it("shows no percentage on either ticker surface without a real quote behind it", () => {
    for (const path of [
      "src/components/hushh-tech-ticker/HushhTechTicker.tsx",
      "src/components/Navbar.tsx",
    ]) {
      const source = read(path);
      expect(source, `${path} renders a percentage`).toContain(
        "Math.abs(quote.percentChange).toFixed(1)",
      );
      expect(source, `${path} renders it unguarded`).toContain("quote.hasQuote ?");
    }
  });

  it("does not claim the market is live when no quote has arrived", () => {
    const ticker = read("src/components/hushh-tech-ticker/HushhTechTicker.tsx");

    // The green dot, the word "Live" and the timestamp are each a claim about the data, so each
    // is gated on a real quote having come back rather than on the component having mounted.
    expect(ticker).toContain("quotes.some((quote) => quote.hasQuote)");
    expect(ticker).toContain('isLive ? "Markets Live"');
    expect(ticker).toContain("{isLive && lastUpdated ?");
  });
});
