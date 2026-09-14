#!/usr/bin/env node
/**
 * Does every published deck actually render? Asked of a deployed host, not of the repo.
 *
 * The existing checks all pass while a deck is visibly broken, because each one is true:
 * `manifest.json` lists the deck, the route returns 200, the crawler body is built from the inlined
 * markdown rather than from the cards, and the cards document parses. None of them opens an image
 * or reads a card body.
 *
 * Three failures this catches, all of which were live on production and UAT when it was written:
 *
 *   1. A public deck whose card points at media under the NDA prefix. It renders as a broken image
 *      for every reader, because that route answers 401 without a countersigned NDA. It is also a
 *      public page holding a pointer into gated storage -- harmless while the gate holds, and a
 *      leak the day someone "fixes" the 401 by loosening the route instead of correcting the
 *      reference. Almost certainly content-hash dedup in the mirror step writing a shared image
 *      under whichever deck was processed first.
 *   2. A card that produced nothing at all -- no title, no body, no image -- which the reader
 *      renders as blank space with nothing to explain it. A title without a body is NOT this: a
 *      Gamma statement slide is a single `<display>` element, and the pull quote is the card.
 *   3. An image that answers 200 with the wrong content type. `server.js` sends
 *      `X-Content-Type-Options: nosniff`, so a JPEG served as text/html displays as nothing. A
 *      status check alone would call that healthy.
 *
 * Usage:
 *   node scripts/community/audit-deck-integrity.mjs                          # production
 *   node scripts/community/audit-deck-integrity.mjs --host https://uat.hushhtech.com
 *   node scripts/community/audit-deck-integrity.mjs --json
 *
 * Exit codes: 0 clean, 1 problems found, 2 the host could not be read at all.
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const HOST = (flag("host", "https://hushhtech.com") || "").replace(/\/$/, "");
const AS_JSON = args.includes("--json");

/** Enough to finish 280 images quickly without looking like a burst to the asset route. */
const CONCURRENCY = 8;

const get = (path) =>
  fetch(`${HOST}${path}`, { headers: { "user-agent": "HushhDeckAudit/1.0" } });

const pool = async (items, worker) => {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) await worker(queue.shift());
    }),
  );
};

/** Plain text of a card, whichever shape it is in. A card with none of these is empty. */
export const cardText = (card) =>
  String(typeof card === "string" ? card : (card?.html ?? card?.text ?? card?.body ?? ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * A card is empty only when it carries nothing at all — no prose, no image, and no title.
 *
 * An earlier version of this treated a title without a body as broken, and reported 10 of the 60
 * cards on ai-driven-personal-agents. Every one of them turned out to be a Gamma statement slide:
 * the source section holds a single `<display>` element and nothing else, so the converter lifts
 * the statement into the title and correctly leaves the body empty. The pull quote IS the card.
 *
 * What remains worth catching is a section that produced neither a heading nor a body — a card the
 * reader renders as blank space with no explanation.
 */
export const isEmptyCard = (card) =>
  cardText(card).length === 0 &&
  !(Array.isArray(card?.images) && card.images.length > 0) &&
  String(card?.title ?? "").trim().length === 0;

/** Which gated decks, if any, this cards document reaches into. */
export const gatedReferences = (serialised) => [
  ...new Set(
    [...String(serialised).matchAll(/\/api\/community\/assets\/gated\/decks\/([a-z0-9-]+)\//g)].map(
      (match) => match[1],
    ),
  ),
];

const main = async () => {
  let listing;
  try {
    listing = await (await get("/api/community/posts")).json();
  } catch (error) {
    console.error(`audit: cannot read ${HOST} — ${error.message}`);
    process.exit(2);
  }

  const decks = (listing.posts || []).filter((post) => post.sourceKind === "deck");
  const problems = [];
  let images = 0;
  let cards = 0;

  for (const deck of decks) {
    const note = (kind, detail) => problems.push({ deck: deck.slug, kind, detail });

    if (!deck.cardsObject) {
      note("no cards document", "the deck is listed but exposes no cardsObject");
      continue;
    }

    const response = await get(`/api/community/assets/${deck.cardsObject}`);
    if (response.status !== 200) {
      note("cards unreachable", `HTTP ${response.status}`);
      continue;
    }

    const raw = await response.text();
    let document;
    try {
      document = JSON.parse(raw);
    } catch {
      note("cards not JSON", "the object parsed as neither an array nor an object");
      continue;
    }

    const deckCards = Array.isArray(document.cards) ? document.cards : [];
    if (!deckCards.length) {
      note("zero cards", "the document parsed but holds no cards");
      continue;
    }
    cards += deckCards.length;

    const empty = deckCards.filter(isEmptyCard);
    if (empty.length) {
      note(
        "empty cards",
        `${empty.length} of ${deckCards.length} have no title, no body and no image: ${empty
          .slice(0, 3)
          .map((card) => card?.title || card?.id || "untitled")
          .join("; ")}`,
      );
    }

    const gated = gatedReferences(raw);
    if (gated.length) {
      note("references gated media", `points into ${gated.join(", ")}`);
    }

    const missingSrc = (raw.match(/<img(?![^>]*\bsrc=)/g) || []).length;
    if (missingSrc) note("image with no src", `${missingSrc} tag(s)`);

    const sources = [
      ...new Set([...raw.matchAll(/src=\\?"([^"\\]+)\\?"/g)].map((match) => match[1])),
    ];
    images += sources.length;

    await pool(sources, async (src) => {
      try {
        const asset = src.startsWith("http")
          ? await fetch(src)
          : await get(src);
        const type = asset.headers.get("content-type") || "";
        if (asset.status !== 200) note("image unreachable", `HTTP ${asset.status} — ${src}`);
        // 200 is not enough: nosniff means a wrong type renders as nothing at all.
        else if (!type.startsWith("image/")) note("image is not an image", `${type} — ${src}`);
      } catch (error) {
        note("image fetch failed", `${String(error.message).slice(0, 70)} — ${src}`);
      }
    });
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ host: HOST, decks: decks.length, cards, images, problems }, null, 2));
  } else {
    console.log(`host    ${HOST}`);
    console.log(`decks   ${decks.length} public`);
    console.log(`cards   ${cards}`);
    console.log(`images  ${images}`);
    console.log(`issues  ${problems.length}\n`);
    for (const problem of problems) {
      console.log(`  ${problem.deck}`);
      console.log(`    ${problem.kind}: ${problem.detail}\n`);
    }
    if (!problems.length) console.log("  every deck serves every image and every card has content");
  }

  process.exit(problems.length ? 1 : 0);
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
