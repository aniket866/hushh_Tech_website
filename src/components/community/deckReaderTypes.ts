/**
 * The shape scripts/community/convert-gamma-export.mjs writes and the deck reader consumes.
 *
 * One entry per Gamma card. `html` is already sanitised by the converter to an allowlist of tags
 * and attributes, which is why the reader can render it directly.
 */
export interface DeckCard {
  id: string;
  /** Stable slug used as the section id, so a shared link to a card keeps working. */
  anchor: string;
  title: string;
  html: string;
  text: string;
  images: string[];
}

export interface DeckCardDocument {
  gammaId: string;
  slug: string;
  title: string;
  cards: DeckCard[];
}

/** ~230 wpm is the usual estimate for considered non-fiction; decks read a little faster. */
export const readingMinutes = (words: number): number => Math.max(1, Math.round(words / 240));

export const wordCount = (cards: DeckCard[]): number =>
  cards.reduce((total, card) => total + card.text.split(/\s+/).filter(Boolean).length, 0);
