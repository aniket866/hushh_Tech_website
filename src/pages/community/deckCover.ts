import manifest from '../../../content/decks/manifest.json';

/** Only request a title-page rendition that the curated manifest provides.
 * Text/card-only decks use CommunityCover's existing category artwork.
 * Never construct public asset URLs for NDA or unknown decks.
 */
export function coverImageFor(post: { sourceKind?: string; accessLevel?: string; slug?: string }): string | undefined {
  if (post.sourceKind !== 'deck' || post.accessLevel !== 'Public') return undefined;
  const deck = manifest.decks.find((entry) => entry.slug === post.slug);
  if (!deck || deck.accessLevel !== 'Public' || !(deck.pageCount > 0)) return undefined;
  return `/api/community/assets/decks/${deck.assetName}/pages/page-001.jpg`;
}
