# Community Content on GCP

## Goal

Community pages must render inside HushhTech without browser calls to Supabase reports, Vercel runtime config, or download-only document flows.

Some legacy presentation posts still embed Gamma in-place because the original charts/decks have not been exported into GCP yet. Do not replace those with summary text. The migration target is to export the actual deck/PDF/media assets into GCS and then serve them through `/api/community/assets/*`.

`general/sell-the-wall-featured` is the first migrated deck in this model. Its source PDF is stored in both UAT and production GCS, and the rendered page images are served in-page from:

```text
decks/sell-the-wall.pdf
decks/sell-the-wall/pages/page-001.jpg ... page-060.jpg
```

The browser reads community content only through the Cloud Run app:

- `GET /api/community/posts`
- `GET /api/community/posts/:slug`
- `GET /api/community/assets/*`

## Runtime Architecture

- Cloud Run `server.js` is the runtime gateway and security-header source of truth.
- Firestore collection `community_posts` stores public post metadata and optional inline Markdown or HTML.
- Private GCS bucket stores larger content packages: Markdown, page images, deck assets, and document assets.
- Cloud Run reads Firestore/GCS with service-account IAM and returns same-origin JSON/assets to the browser.
- `api/community/staticPosts.generated.js` is a committed fallback snapshot generated from the legacy local registry.
- `MarketUpdateGallery` uses bundled local chart assets when present and same-origin GCP asset URLs for declared chart images; it must not call Supabase storage directly.

## Content Shape

Firestore document ids are `static-` followed by the slug lowercased with `/` replaced by `-`.
A Firestore document id cannot contain `/`, so the slug itself is not usable as an id; the
document carries the slug in a field instead, and that field is what the API keys on.

```
general/the-medallion-blueprint  ->  static-general-the-medallion-blueprint
legal/limited-partnership-agreement-LPA  ->  static-legal-limited-partnership-agreement-lpa
```

`scripts/community/sync-community-firestore.mjs` derives ids this way and is the only supported
writer. Run it after `npm run build:community` whenever the snapshot gains posts:

```bash
npm run community:sync-firestore              # dry run: what would change
npm run community:sync-firestore -- --apply
```

It is a merge, not a mirror. It inserts documents that do not exist, and on documents that do it
PATCHes with an explicit `updateMask.fieldPaths` naming only `publishedAt`, `docFamily`,
`docVersion` and `sourceKind` — so a body or title edited directly in Firestore survives. It never
deletes and never writes an empty value over a non-empty one.

An example document:

```json
{
  "slug": "general/the-perpetual-alpha-engine",
  "title": "The Perpetual Alpha Engine",
  "description": "A Technical Blueprint for Next-Generation Quantitative Investment Systems",
  "category": "investment & financial strategies",
  "publishedAt": "2025-12-06",
  "accessLevel": "Public",
  "status": "published",
  "sourceKind": "article",
  "bodyMarkdown": "# Title\n\nBody...",
  "contentObject": "posts/general/the-perpetual-alpha-engine/index.md",
  "assetObject": "posts/general/the-perpetual-alpha-engine/document.pdf"
}
```

`bodyMarkdown` is preferred for normal articles. Use `contentObject` when the content body is too large for Firestore, and always for NDA material — a gated body belongs behind the `gated/` GCS prefix, never inline in a document the repository's snapshot generator also reads. Use `assetObject` for documents or deck media that should stream through `/api/community/assets/*`.

`docFamily` and `docVersion` carry version identity. Posts sharing a `docFamily` are editions of one
document and only the highest `docVersion` appears in a list; an untagged post is its own family and
always survives. Superseded editions keep working as URLs and carry `supersededBy` so the page can
canonical forward.

### Decks

A deck is published from `content/decks/manifest.json` through four steps, in this order:

```bash
# 1. Stage the Gamma exports. There is no Gamma API key in CI, so an agent calls read_gamma per
#    deck and this matches the results to the manifest by title.
node scripts/community/ingest-gamma-export.mjs --from <dir where read_gamma wrote its files>

# 2. Convert to cards + markdown. Sanitises Gamma's markup to an allowlist, shifts headings down a
#    level, promotes table header rows, and writes content/decks/cards[-gated]/<asset>.json.
node scripts/community/convert-gamma-export.mjs

# 3. Mirror card imagery into the bucket under the deck's own access prefix.
node scripts/community/mirror-deck-images.mjs --bucket hushh-tech-community-content-uat

# 4. Publish cards.json and index.md, then regenerate the snapshot and sync Firestore.
node scripts/community/publish-deck-content.mjs --bucket hushh-tech-community-content-uat
node scripts/community/generate-deck-posts.mjs
npm run build:community
npm run community:sync-firestore -- --apply
```

Steps 2 and 3 are order-independent: the mirror records an origin→asset map that the converter
applies, so re-converting after a re-export cannot restore CDN hotlinks. The map is split by access
level and only the public half is committed — the gated half names the publicly fetchable origin of
every NDA deck image.

`content/decks/cards/` is committed. `content/decks/cards-gated/`, `content/decks/text-gated/`,
`content/decks/gamma-export/` and `content/decks/media-map-gated.json` are not, and must not be:
this repository has been public.

Deck pages render through `src/components/community/DeckReader.tsx`, which fetches `cardsObject`
from the asset route. A gated deck's images cannot load from an `<img>` src — a browser cannot send
an Authorization header — so `GatedImage` fetches them with the reader's Firebase token and hands
the element an object URL.

### Reading the collection

Firestore's document list returns at most 100 documents per page. `listAllDocuments()` in
`api/community/content-service.js` sets an explicit page size and follows the page token to the end;
anything that reads this collection must do the same. A single unpaginated GET silently returned the
first 100 documents by id for months, which cost the community index 40 public posts with no error
anywhere.

The list read is also projected through `LIST_FIELD_MASK`, which excludes `bodyMarkdown` and
`bodyHtml`: `api/community/posts.js` strips both before responding, so fetching them was ~430 KB of
text read and discarded per request. The detail route reads the full document.

## Local And Cloud Run Behavior

Local development can run without Firestore/GCS. The API falls back to `api/community/staticPosts.generated.js`, which is refreshed by:

```bash
npm run build:community
```

Cloud Run should set:

```text
COMMUNITY_CONTENT_BACKEND=gcp
COMMUNITY_CONTENT_COLLECTION=community_posts
COMMUNITY_CONTENT_BUCKET=hushh-tech-community-content-uat|hushh-tech-community-content-prod
COMMUNITY_CONTENT_CACHE_SECONDS=300
```

If Firestore is temporarily unavailable, the API falls back to the static snapshot instead of exposing errors to public readers.

Firestore database creation is intentionally separate from the code deploy because Firestore location is irreversible. Enable the API first, then create the database only after the team chooses the permanent location.

## Migration Rules

- Convert Gamma presentations into native HushhTech content packages before publishing new migrated versions.
- Until a deck is exported, keep the legacy Gamma iframe embedded in-place instead of replacing it with a lossy summary.
- Do not route community cards to `/reports/:id`.
- Do not require users to open or download documents; render documents in-app through `/api/community/assets/*`.
- Do not silently replace a missing deck/chart asset with made-up summary content; surface the missing asset state and migrate the real file into GCS.
- Keep NDA/private posts out of public Firestore responses until the NDA API path is migrated separately.

## Verification

Run:

```bash
npm run test -- tests/communityGcpRuntime.test.ts tests/communityApiRoute.test.ts
npm run test -- tests/communityFirestorePagination.test.ts tests/communityFirestoreSync.test.ts
npm run env:check
npm run build:web
npm run gcp:secrets:audit
```

Against a deployed host — this checks what a crawler and an anonymous visitor actually receive,
which is where the artifact checks above cannot reach:

```bash
npm run verify:deployment                                   # UAT
npm run verify:deployment -- --host https://hushhtech.com   # after a promotion
npm run verify:sensitive-nda-gate -- --target=uat --expected-min=1
```

Expected proof:

- `/community` fetches `/api/community/posts`.
- `/community/:slug` fetches `/api/community/posts/:slug`.
- Community source does not reference `VITE_MARKET_SUPABASE_*`, `/rest/v1/reports`, or `vercel.json`.
- Cloud Run UAT/prod sensitive runtime env values use Secret Manager references.
