import { describe, expect, it } from 'vitest';
import manifest from '../content/decks/manifest.json';
import { coverImageFor } from '../src/pages/community/deckCover';

describe('manifest-backed community covers', () => {
  it.each(manifest.decks)('$slug only uses an existing public page rendition', (deck) => {
    const result = coverImageFor({ ...deck, sourceKind: 'deck' });
    expect(result).toBe(deck.accessLevel === 'Public' && deck.pageCount > 0
      ? `/api/community/assets/decks/${deck.assetName}/pages/page-001.jpg` : undefined);
  });
  it('never invents an asset path for an unknown or non-deck post', () => {
    expect(coverImageFor({ sourceKind: 'deck', accessLevel: 'Public', slug: 'general/unknown' })).toBeUndefined();
    expect(coverImageFor({ accessLevel: 'Public', slug: manifest.decks[0].slug })).toBeUndefined();
  });
  it('does not expose a gated deck even if a list entry is misclassified', () => {
    const gated = manifest.decks.find((d) => d.accessLevel === 'NDA')!;
    expect(coverImageFor({ sourceKind: 'deck', accessLevel: 'Public', slug: gated.slug })).toBeUndefined();
    expect(coverImageFor({ sourceKind: 'deck', slug: manifest.decks[0].slug })).toBeUndefined();
  });
});
