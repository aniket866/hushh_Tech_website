---
name: community-decks
description: >-
  Use when publishing, updating, or debugging Hushh Tech community content — a
  Gamma deck that should become a readable article, a deck whose images 404 or
  whose reading view fails to load, an NDA deck that must stay gated, or the
  community index / deck reader rendering wrong. Trigger on any mention of Gamma
  decks, the community page, deck cards, `content/decks/`, `community_posts` in
  Firestore, the NDA gate, or "the deck shows no text". Covers the whole
  authoring pipeline end to end, the access-level rules that must never be
  broken, and how to verify a publish actually landed.
---

# Community decks: Gamma → reader → Firestore

A published deck is **five artefacts in three places**, and skipping one is the
usual cause of "it looks fine locally and is broken on UAT".

| Artefact | Lives in | Written by |
| --- | --- | --- |
| Staged Gamma export | `content/decks/gamma-export/<gammaId>.html` (gitignored) | `ingest-gamma-export.mjs` |
| Structured cards | `content/decks/cards/<asset>.json` (public) or `cards-gated/` (gitignored) | `convert-gamma-export.mjs` |
| Markdown body | `content/decks/text/<asset>.md` or `text-gated/` (gitignored) | same |
| Mirrored images + bodies | GCS, under `decks/<asset>/` or `gated/decks/<asset>/` | `mirror-deck-images.mjs`, `publish-deck-content.mjs` |
| The post row | Firestore `community_posts` | `sync-community-firestore.mjs` |

## The order matters

Run them in exactly this order. Two of the steps overwrite the other's output if
reversed:

```bash
# 1. Stage. There is no Gamma API key here — call the MCP `read_gamma` tool per
#    deck first, let it write files, then point this at that directory.
node scripts/community/ingest-gamma-export.mjs --from <dir>

# 2. Mirror images to GCS, recording origin → mirrored URL in the media map.
node scripts/community/mirror-deck-images.mjs

# 3. Convert. Reads the media map, so it must run AFTER the mirror or every
#    image in the cards points back at the origin CDN.
node scripts/community/convert-gamma-export.mjs

# 4. Publish cards.json + index.md to the deck's own GCS prefix.
node scripts/community/publish-deck-content.mjs

# 5. Regenerate the committed snapshot and the deck post wrappers.
node scripts/community/generate-deck-posts.mjs
npm run build:community

# 6. Reconcile Firestore. Dry-run by default — read the plan before writing.
npm run community:sync-firestore
npm run community:sync-firestore -- --apply
```

## Access level is the thing you must not get wrong

`isNdaAsset()` in `api/community/content-service.js` gates on the **object
prefix**, nothing else:

```js
/^(gated|nda|private|sensitive)\//i.test(objectName)
```

So a deck's access level is expressed entirely by where its bytes live. Two rules
follow, and both have already been violated once:

1. **NDA text never enters git.** `content/decks/text-gated/`,
   `cards-gated/`, `gamma-export/` and `media-map-gated.json` are gitignored. The
   repo is public. An NDA deck's body reaches the app through `contentObject`,
   which resolves to the gated GCS prefix and is served `private, no-store` after
   `assertNdaAccess(req)`.
2. **A gated deck's images must be mirrored too.** A deck whose text is gated but
   whose images load from a public CDN is not gated. `mirror-deck-images.mjs`
   puts them under the same prefix as the deck, so one check governs both.

The line: anything naming a specific fund vehicle, allocation, or return figure
is NDA. Thesis and education are public.

## When a deck renders as "the reading view could not be loaded"

That string is `DeckReader.tsx`'s fallback when the cards fetch fails. In order of
likelihood:

1. The post row has no `cardsObject` — step 5 or 6 was skipped.
2. `publish-deck-content.mjs` never ran, so the GCS object is not there.
3. The bucket is unreachable. Public decks now fall back to the committed copy in
   `content/decks/`, which `Dockerfile.gcp` carries into the runtime image, so
   this only strands gated decks — by design.

## Firestore is authoritative, the repo is not

UAT and prod run `COMMUNITY_CONTENT_BACKEND=gcp`. `listGcpPosts()` returns the
Firestore result whenever the collection is non-empty and only falls back to
`STATIC_COMMUNITY_POSTS` when it is empty or errors. **Shipping a container with
186 posts in it changes nothing on the index until Firestore knows about them.**

`sync-community-firestore.mjs` is a merge, never a replace: it inserts missing
slugs in full, and updates existing ones through an explicit
`updateMask.fieldPaths` so Firestore-only content survives. It never deletes, and
never writes an empty body over a non-empty one.

Firestore listing pages at 300 docs — `listAllDocuments()` follows
`nextPageToken` up to 50 pages. It silently truncated at 100 for a while, which
is why the index showed 90 posts when there were 130.

## Verify a publish landed

```bash
# The list the site will actually render
curl -sS https://uat.hushhtech.com/api/community/posts | jq -r '.posts | length'

# A public deck's cards, and a gated deck's — 200 then 401/403
curl -sS -o /dev/null -w '%{http_code}\n' https://uat.hushhtech.com/api/community/assets/decks/the-medallion-blueprint/cards.json
curl -sS -o /dev/null -w '%{http_code}\n' https://uat.hushhtech.com/api/community/assets/gated/decks/the-simons-code/cards.json

# The repo's own gate, against the deployed host
node scripts/community/verify-sensitive-nda-gate.mjs --host https://uat.hushhtech.com
```

No NDA slug may appear in the public list response. That check is not optional.

## Layout changes

Any change to `src/pages/community/` or `src/components/community/DeckReader.tsx`
should be followed by `npm run test:visual` — see `docs/visual-regression.md`.
