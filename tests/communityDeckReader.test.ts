import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { convertExport, cardsToMarkdown } from "../scripts/community/convert-gamma-export.mjs";
import { readingMinutes, wordCount } from "../src/components/community/deckReaderTypes";

const repoRoot = join(__dirname, "..");
const cardsDir = join(repoRoot, "content/decks/cards");
const manifest = JSON.parse(readFileSync(join(repoRoot, "content/decks/manifest.json"), "utf8")) as {
  decks: Array<{ slug: string; assetName: string; accessLevel: string; pageCount: number; cardCount: number }>;
};

const publicDecks = manifest.decks.filter((deck) => deck.accessLevel !== "NDA");
const readCards = (assetName: string) =>
  JSON.parse(readFileSync(join(cardsDir, `${assetName}.json`), "utf8")) as {
    cards: Array<{ anchor: string; title: string; html: string; text: string; images: string[] }>;
  };

/**
 * The deck pages this replaces rendered a stack of slide JPEGs and no text at all, so a crawler saw
 * 2,023 characters of injected abstract and a reader saw pictures of words. These assert the
 * properties that make the reading view a document rather than a gallery.
 */
describe("converted deck cards", () => {
  it("has a card file for every public deck", () => {
    const files = new Set(readdirSync(cardsDir));
    for (const deck of publicDecks) expect(files.has(`${deck.assetName}.json`), deck.slug).toBe(true);
  });

  it("produces one card per card the manifest counts", () => {
    // A silent drop of the last card is the failure mode a card count catches and nothing else does.
    // cardCount, not pageCount: pageCount is how many slide images exist, which is zero for the ten
    // decks that were published as a live Gamma embed and never had a page-image export.
    for (const deck of publicDecks) {
      expect(readCards(deck.assetName).cards.length, deck.slug).toBe(deck.cardCount);
    }
  });

  it("still has slide images wherever the manifest claims them", () => {
    for (const deck of publicDecks) {
      if (!deck.pageCount) continue;
      expect(deck.pageCount, `${deck.slug} pageCount vs cardCount`).toBe(deck.cardCount);
    }
  });

  it("gives every card a heading and a unique anchor", () => {
    for (const deck of publicDecks) {
      const { cards } = readCards(deck.assetName);
      const anchors = cards.map((card) => card.anchor);
      expect(new Set(anchors).size, deck.slug).toBe(anchors.length);
      expect(cards.filter((card) => !card.title).length, `${deck.slug} untitled cards`).toBeLessThan(
        Math.ceil(cards.length * 0.1),
      );
    }
  });

  it("carries the structure the PDF extraction threw away", () => {
    const totals = publicDecks.reduce(
      (acc, deck) => {
        const { cards } = readCards(deck.assetName);
        acc.images += cards.reduce((sum, card) => sum + card.images.length, 0);
        acc.tables += cards.filter((card) => card.html.includes("<table")).length;
        acc.subheads += cards.reduce((sum, card) => sum + (card.html.match(/<h4/g) || []).length, 0);
        return acc;
      },
      { images: 0, tables: 0, subheads: 0 },
    );
    expect(totals.images).toBeGreaterThan(50);
    expect(totals.tables).toBeGreaterThan(10);
    expect(totals.subheads).toBeGreaterThan(200);
  });

  it("closes every table it opens", () => {
    // Promoting a header row once dropped the closing tag, leaving markup a browser could only guess at.
    for (const deck of publicDecks) {
      for (const card of readCards(deck.assetName).cards) {
        expect((card.html.match(/<table/g) || []).length, `${deck.slug} ${card.anchor}`).toBe(
          (card.html.match(/<\/table>/g) || []).length,
        );
      }
    }
  });

  it("self-hosts every image, so a deck does not depend on Gamma's CDN", () => {
    for (const deck of publicDecks) {
      for (const card of readCards(deck.assetName).cards) {
        for (const match of card.html.matchAll(/<img\b[^>]*src="([^"]+)"/g)) {
          expect(match[1], `${deck.slug} ${card.anchor}`).toMatch(/^\/api\/community\/assets\//);
        }
      }
    }
  });
});

/**
 * The reader renders card HTML through dangerouslySetInnerHTML, so the converter's allowlist is the
 * only thing between a Gamma export and the page.
 */
describe("converter sanitising", () => {
  const convert = (inner: string) => convertExport(`<div><section id="s1"><h1>T</h1>${inner}</section></div>`);

  it("drops scripts, iframes and event handlers", () => {
    const [card] = convert(
      '<p onclick="steal()">text</p><script>alert(1)</script><iframe src="https://evil.test"></iframe>',
    );
    expect(card.html).not.toContain("script");
    expect(card.html).not.toContain("iframe");
    expect(card.html).not.toContain("onclick");
    expect(card.html).toContain("text");
  });

  it("keeps only src and alt on an image", () => {
    const [card] = convert('<img src="https://cdn.test/a.png" alt="a" onerror="x()" class="accent" />');
    expect(card.html).toContain('src="https://cdn.test/a.png"');
    expect(card.html).toContain('alt="a"');
    expect(card.html).not.toContain("onerror");
    expect(card.html).not.toContain("accent");
  });

  it("shifts Gamma's h1 down so the page keeps one h1", () => {
    // 35 <h1>s in one document is no outline at all, which is exactly what a heading-driven answer
    // engine reads.
    const [card] = convert("<h1>Section</h1><p>body</p>");
    expect(card.html).toContain("<h2>Section</h2>");
    expect(card.html).not.toContain("<h1>");
  });

  it("promotes a fully bold first row to real table headers", () => {
    const [card] = convert(
      "<table><tbody><tr><td><p><b>Ticker</b></p></td><td><p><b>Weight</b></p></td></tr>" +
        "<tr><td><p>NVDA</p></td><td><p>17%</p></td></tr></tbody></table>",
    );
    expect(card.html).toContain("<thead><tr><th>Ticker</th><th>Weight</th></tr></thead>");
  });

  it("leaves a data row alone when only some cells are bold", () => {
    const [card] = convert(
      "<table><tbody><tr><td><p>NVDA</p></td><td><p><b>17%</b></p></td></tr></tbody></table>",
    );
    expect(card.html).not.toContain("<thead>");
  });
});

describe("markdown for the crawler-visible body", () => {
  it("emits a real markdown table rather than one cell per line", () => {
    const cards = convertExport(
      '<div><section id="s1"><h1>T</h1><table header-row="true"><tbody>' +
        "<tr><td><p><b>A</b></p></td><td><p><b>B</b></p></td></tr>" +
        "<tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table></section></div>",
    );
    const markdown = cardsToMarkdown("Deck", cards);
    expect(markdown).toContain("| A | B |");
    expect(markdown).toContain("| --- | --- |");
    expect(markdown).toContain("| 1 | 2 |");
  });

  it("keeps heading levels so the outline survives", () => {
    const cards = convertExport('<div><section id="s1"><h1>Card</h1><h4>Sub</h4><p>body</p></section></div>');
    const markdown = cardsToMarkdown("Deck", cards);
    expect(markdown).toContain("## Card");
    expect(markdown).toContain("#### Sub");
  });
});

describe("reading time", () => {
  it("never rounds a short deck to zero minutes", () => {
    expect(readingMinutes(10)).toBe(1);
  });

  it("counts words across cards", () => {
    expect(wordCount([{ text: "one two three" }, { text: "four five" }] as never)).toBe(5);
  });
});
