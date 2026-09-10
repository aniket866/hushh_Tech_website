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

# 4. Repair the <img> tags the converter cannot get right on its own — see below.
#    Run it TWICE: the second pass is the gated decks, which need --gated because their
#    images answer 401 over HTTP and have to be read out of the bucket instead.
node scripts/community/repair-deck-image-html.mjs
node scripts/community/repair-deck-image-html.mjs --apply
node scripts/community/repair-deck-image-html.mjs --gated
node scripts/community/repair-deck-image-html.mjs --gated --apply

# 5. Publish cards.json + index.md to the deck's own GCS prefix.
node scripts/community/publish-deck-content.mjs

# 6. Regenerate the committed snapshot and the deck post wrappers.
node scripts/community/generate-deck-posts.mjs
npm run build:community

# 7. Reconcile Firestore — UAT only. Dry-run by default; read the plan before writing.
#    Production has no Firestore database; do not point this at hushh-tech-prod.
npm run community:sync-firestore
npm run community:sync-firestore -- --apply
```

## The converter cannot size an image, and ships a broken one

Two defects came out of `convert-gamma-export.mjs`, both in the `<img>` tags, both invisible to
every gate we have because the markup is valid and the page returns 200:

1. **No `src`.** The converter keeps an allowlisted attribute only when the source tag has it, but
   emitted the `<img>` either way — so an image whose `src` did not survive attribute filtering
   shipped as `<img alt="..." loading="lazy" decoding="async" />`, a broken-image placeholder on a
   live page. One was serving on production. The converter now skips the element instead.
2. **No intrinsic size.** It reads width and height from Gamma's own
   `meta='{"width":...,"height":...}'`, and Gamma does not always emit it — 81 of 280 tags had
   neither. Each one is a layout shift: the browser cannot reserve the box, so the paragraph under
   the image jumps once per image, on every deck page, on every uncached visit.

`repair-deck-image-html.mjs` fixes both. It reads the real dimensions out of the image header — the
PNG IHDR chunk or the JPEG SOF frame marker — over a ranged GET, a few KB per image, no image
library. `sharp` would do it in a line and is deliberately absent from `package.json`; this script
is why it does not need to be added. It is idempotent, so re-running it after a fresh conversion
only fills the new gaps.

**It defaults to the public decks, and the gated ones need a second pass.** Without `--gated` it
reads `content/decks/cards/` and fetches headers over HTTP from the public host — which is exactly
what a gated asset refuses, by design, with a `401`. So a run that looks complete leaves the NDA
decks untouched: 21 of their 73 tags had no size the first time this was done, and none of them
would have been caught. `--gated` switches to `content/decks/cards-gated/` and reads the bytes
straight out of the bucket with the operator credential, mapping the card's
`/api/community/assets/<objectName>` src 1:1 onto the object name.

Nothing NDA leaves the machine: `cards-gated/` is gitignored, and the only edit is a width and a
height per image.

**Committing the repaired `cards.json` changes nothing on its own.** The reader fetches cards from
the bucket and only falls back to the committed copy when the bucket is unreachable, so step 5
against *each* environment's bucket is what makes the fix visible.

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

## Firestore is authoritative on UAT. On production it does not exist.

Both environments set `COMMUNITY_CONTENT_BACKEND=gcp`, so it is tempting to
assume they behave alike. **They do not, and the difference is easy to get
wrong** — check the environment rather than reasoning from the env var:

| | `hushh-tech-uat` | `hushh-tech-prod` |
| --- | --- | --- |
| Firestore `(default)` database | exists, ~135 docs | **does not exist — every read 404s** |
| What the index actually serves | Firestore | the committed `STATIC_COMMUNITY_POSTS` |
| `sync-community-firestore.mjs` | required after a publish | **nothing to sync; the script cannot run** |

On UAT, `listGcpPosts()` returns the Firestore result whenever the collection is
non-empty and only falls back to `STATIC_COMMUNITY_POSTS` when it is empty or
errors, so **shipping a container with 186 posts in it changes nothing on the
index until Firestore knows about them.** On production the Firestore call
always throws, the fallback always runs, and the committed snapshot is the
content system. That also means prod logs `community_static_fallback`
continuously: on UAT that metric means "degraded", on prod it is the steady
state.

Deck bodies and imagery are a separate question from the index, and they are
per-bucket. `publish-deck-content.mjs` and `mirror-deck-images.mjs` default to
the UAT bucket, so a deck published for UAT is **not** present for prod until the
same content is put in `hushh-tech-community-content-prod`. Miss that and the
index lists every deck while each deck page renders "the reading view could not
be loaded" — an outage that looks healthy from the outside, because the
crawler-visible body comes from the inlined `bodyMarkdown` and still works.

`sync-community-firestore.mjs` is a merge, never a replace: it inserts missing
slugs in full, and updates existing ones through an explicit
`updateMask.fieldPaths` so Firestore-only content survives. It never deletes, and
never writes an empty body over a non-empty one.

Firestore listing pages at 300 docs — `listAllDocuments()` follows
`nextPageToken` up to 50 pages. It silently truncated at 100 for a while, which
is why the index showed 90 posts when there were 130.

## Copying deck assets between buckets

Promoting decks to a new environment means moving the bucket objects too — the
container carries none of them. Two things bite:

**A GCS rewrite drops metadata you do not resend.** `POST .../rewriteTo/...`
with a body of `{cacheControl}` sets *only* that, so `contentType` lands empty
and every object is served `application/octet-stream`. `server.js` sends
`X-Content-Type-Options: nosniff`, so those images do not render in a browser at
all — while curl, uptime checks and a status-only test all see a healthy 200.
Send `contentType` in the rewrite body, or patch it afterwards:

```
PATCH https://storage.googleapis.com/storage/v1/b/<bucket>/o/<urlencoded name>
{"contentType": "image/jpeg"}
```

**Copy what is missing, never "sync the difference".** Environments legitimately
diverge: after a `convert-gamma-export.mjs` re-run, the newer `cards.json` may
live in prod while UAT still holds the older bytes. A size-difference sync would
quietly roll production back. Filter on absence from the destination, and never
delete.

And remember `/pages/` as well as `/media/`: `media/` powers the reading view,
`pages/` powers the Slides view, and copying only one leaves half of every deck
working — which looks fine on the index and in a crawler fetch.

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
