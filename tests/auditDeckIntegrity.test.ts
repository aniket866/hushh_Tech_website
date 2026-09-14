import { describe, expect, it } from "vitest";

import {
  cardText,
  gatedReferences,
  isEmptyCard,
} from "../scripts/community/audit-deck-integrity.mjs";

/**
 * The audit's decision surface, driven without a host.
 *
 * Each case here is a shape that was live on production when the audit was written and that every
 * existing gate called healthy.
 */

describe("deck integrity audit", () => {
  describe("empty cards", () => {
    it("does not count a Gamma statement slide as empty", () => {
      // The exact shape of all 10 cards this check first reported on ai-driven-personal-agents.
      // Each one's source section is a single `<display>` element, so the converter lifts the
      // statement into the title and rightly leaves the body empty. The pull quote is the card.
      expect(
        isEmptyCard({
          id: "p2fvzghfeonl9j0",
          anchor: "03-what-if-your-phone-could-be-your-wisest-advisor",
          title: "What if your phone could be your wisest advisor?",
          html: "",
          text: "",
          images: [],
        }),
      ).toBe(false);
    });

    it("counts a card with no title, no body and no image as empty", () => {
      // A section that produced nothing at all. The reader shows blank space with no explanation,
      // and unlike a statement slide there is no content to explain it.
      expect(isEmptyCard({ id: "x", title: "", html: "", text: "", images: [] })).toBe(true);
    });

    it("does not count a card that is only an image", () => {
      // A full-bleed image card is legitimate content. Judging on prose alone would report every
      // deck's cover as broken.
      expect(isEmptyCard({ title: "Cover", html: "", text: "", images: ["a.jpg"] })).toBe(false);
    });

    it("does not count a card whose prose is wrapped in markup", () => {
      expect(isEmptyCard({ html: "<p>Real body copy.</p>", images: [] })).toBe(false);
    });

    it("reads prose from whichever field carries it", () => {
      expect(cardText({ html: "<p>From html</p>" })).toBe("From html");
      expect(cardText({ text: "From text" })).toBe("From text");
      expect(cardText({ body: "From body" })).toBe("From body");
      expect(cardText("A bare string card")).toBe("A bare string card");
      expect(cardText(undefined)).toBe("");
    });
  });

  describe("gated references", () => {
    it("names the gated deck a public card reaches into", () => {
      // Both live cases: a public deck pointing at NDA media, which 401s for every reader and
      // leaves a public page holding a pointer into gated storage.
      const cards = JSON.stringify({
        cards: [
          { html: '<img src="/api/community/assets/decks/the-medallion-blueprint/media/a.jpg" />' },
          { html: '<img src="/api/community/assets/gated/decks/the-simons-code/media/b.jpg" />' },
        ],
      });
      expect(gatedReferences(cards)).toEqual(["the-simons-code"]);
    });

    it("reports each gated deck once however many times it is referenced", () => {
      const cards = JSON.stringify([
        "/api/community/assets/gated/decks/hushh-renaissance/media/a.jpg",
        "/api/community/assets/gated/decks/hushh-renaissance/media/b.jpg",
      ]);
      expect(gatedReferences(cards)).toEqual(["hushh-renaissance"]);
    });

    it("is silent when every reference is public", () => {
      const cards = JSON.stringify([
        "/api/community/assets/decks/attention-is-all-you-need/media/a.jpg",
      ]);
      expect(gatedReferences(cards)).toEqual([]);
    });

    it("does not mistake a public deck whose slug merely contains a gated one", () => {
      // general/hushh-renaissance is NDA and general/hushh-renaissance-ai-native-medallion is
      // public. A substring match here would report the public deck as leaking, which is the
      // false positive that has already been raised once against this data.
      const cards = JSON.stringify([
        "/api/community/assets/decks/hushh-renaissance-ai-native-medallion/media/a.jpg",
      ]);
      expect(gatedReferences(cards)).toEqual([]);
    });
  });
});
