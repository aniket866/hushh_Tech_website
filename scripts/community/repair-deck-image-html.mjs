#!/usr/bin/env node
/**
 * Repairs the two defects `convert-gamma-export.mjs` left in the decks' `<img>` tags.
 *
 * ## 1. An image with no `src`
 *
 * The converter keeps an allowlisted attribute only when the source tag has it, but emits the
 * `<img>` regardless — so a Gamma image whose `src` did not survive attribute filtering ships as
 * `<img alt="..." loading="lazy" decoding="async" />`. That is a broken-image placeholder on a
 * live page. One exists today, on `the-medallion-blueprint`, and it has been serving on
 * production. The converter is fixed so it cannot recur; this removes the one already committed.
 *
 * ## 2. An image with no intrinsic size
 *
 * `convert-gamma-export.mjs` reads width and height out of Gamma's own
 * `meta='{"width":...,"height":...}'` attribute. Gamma does not always emit it: 81 of the 280
 * `<img>` tags across the public decks arrive with no dimensions at all. Every one of those is a
 * layout shift — the browser cannot reserve the box until the bytes land, so the paragraph under
 * the image moves once per image, on every deck page, on every visit that misses cache. It is the
 * most visible remaining quality defect in the reading view and it is invisible to every check we
 * have, because the markup is valid and the image renders fine.
 *
 * The dimensions are in the files themselves. This reads them out of the image header — the PNG
 * IHDR chunk or the JPEG SOF frame marker — over a ranged GET, so it transfers a few KB per image
 * rather than the whole file and needs no image library. `sharp` would do this in one line and is
 * deliberately absent from package.json: it is an authoring-time dependency with a native build,
 * and this script is the reason it does not need to be added.
 *
 * Idempotent. A tag that already carries both attributes is left exactly as it is, so a re-run
 * after a fresh conversion only fills the new gaps.
 *
 * Usage:
 *   node scripts/community/repair-deck-image-html.mjs                     # dry run
 *   node scripts/community/repair-deck-image-html.mjs --apply
 *   node scripts/community/repair-deck-image-html.mjs --host https://uat.hushhtech.com --apply
 *   node scripts/community/repair-deck-image-html.mjs --gated --apply   # NDA decks, read from GCS
 *
 * Run it after convert-gamma-export.mjs and BEFORE publish-deck-content.mjs, so the corrected
 * cards.json is what gets published. Publishing is a separate step on purpose: this writes the
 * committed copy only and never touches a bucket.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { accessToken } from "../deploy/gcp-auth.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith("--")) continue;
  const key = process.argv[i].slice(2);
  const next = process.argv[i + 1];
  args[key] = !next || next.startsWith("--") ? true : (i += 1, next);
}

const APPLY = Boolean(args.apply);
const HOST = (typeof args.host === "string" ? args.host : "https://hushhtech.com").replace(/\/$/, "");
/**
 * The gated decks have the same defect — 21 of their 73 tags carry no size — but their images sit
 * behind `assertNdaAccess()`, so the public host answers 401 and the header is unreadable over
 * HTTP. Their bytes are still readable to an operator credential straight out of the bucket, which
 * is what `--gated` does. Nothing NDA is written anywhere by this: `content/decks/cards-gated/` is
 * gitignored, and the only thing added to it is two integers per image.
 */
const GATED = Boolean(args.gated);
const BUCKET =
  typeof args.bucket === "string" ? args.bucket : "hushh-tech-community-content-prod";
const CARDS_DIR = join(root, GATED ? "content/decks/cards-gated" : "content/decks/cards");
const CONCURRENCY = 6;
/** Enough for the SOF marker of a progressive JPEG, which can sit well past the first few KB. */
const HEADER_BYTES = 65_536;

/**
 * Intrinsic size from the header bytes alone.
 *
 * PNG puts width and height at fixed offsets in IHDR, which is always the first chunk. JPEG is a
 * walk: skip marker segments until a start-of-frame, whose payload carries height then width in
 * that order. SOF4 (0xc4), SOF8 (0xc8) and SOF12 (0xcc) share the numeric range but are Huffman
 * tables, arithmetic conditioning and JPEG-LS respectively, not frames — reading a size out of
 * one of those is how this kind of parser reports nonsense instead of failing.
 */
export const readDimensions = (buf) => {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      // Standalone markers carry no length field.
      if (marker === 0xd8 || marker === 0x01 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xda) break; // start of scan: no frame header after this point
      const length = buf.readUInt16BE(i + 2);
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + length;
    }
  }

  return null;
};

const needsDimensions = (tag) => !/\bwidth="\d+"/.test(tag) || !/\bheight="\d+"/.test(tag);

const srcOf = (tag) => {
  const match = /\bsrc="([^"]+)"/.exec(tag);
  return match ? match[1] : null;
};

/**
 * Insert the two attributes directly after `src`, which is where the ones Gamma did emit already
 * sit. Keeping the position identical means a tag this script fills and a tag the converter filled
 * are byte-identical, so nothing downstream can tell them apart and a re-run is a true no-op.
 */
const withDimensions = (tag, { width, height }) => {
  const cleaned = tag.replace(/\s+(?:width|height)="\d*"/g, "");
  return cleaned.replace(/(\bsrc="[^"]*")/, `$1 width="${width}" height="${height}"`);
};

/** `/api/community/assets/<objectName>` is a straight 1:1 map onto the bucket's object name. */
const objectNameFor = (path) => {
  const match = /^\/api\/community\/assets\/(.+)$/.exec(path);
  return match ? match[1] : null;
};

const fetchHeader = async (path) => {
  const range = { Range: `bytes=0-${HEADER_BYTES - 1}` };

  if (GATED) {
    const objectName = objectNameFor(path);
    if (!objectName) throw new Error(`not an asset path: ${path}`);
    const url =
      `https://storage.googleapis.com/storage/v1/b/${BUCKET}` +
      `/o/${encodeURIComponent(objectName)}?alt=media`;
    const token = await accessToken();
    const response = await fetch(url, { headers: { ...range, Authorization: `Bearer ${token}` } });
    if (!response.ok && response.status !== 206) throw new Error(`${response.status} gs://${BUCKET}/${objectName}`);
    return Buffer.from(await response.arrayBuffer());
  }

  const url = path.startsWith("http") ? path : `${HOST}${path}`;
  const response = await fetch(url, { headers: range });
  if (!response.ok && response.status !== 206) throw new Error(`${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
};

const fetchDimensions = async (path) => {
  const dimensions = readDimensions(await fetchHeader(path));
  if (!dimensions?.width || !dimensions?.height) throw new Error(`unreadable header ${path}`);
  return dimensions;
};

/** One shared queue rather than per-deck batches, so a deck of two images cannot idle the pool. */
const resolveAll = async (paths) => {
  const results = new Map();
  const failures = [];
  const queue = [...paths];
  const worker = async () => {
    for (let path = queue.pop(); path; path = queue.pop()) {
      try {
        results.set(path, await fetchDimensions(path));
      } catch (error) {
        failures.push(`${path}: ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return { results, failures };
};

const main = async () => {
  const files = readdirSync(CARDS_DIR).filter((file) => file.endsWith(".json")).sort();
  const decks = files.map((file) => ({ file, deck: JSON.parse(readFileSync(join(CARDS_DIR, file), "utf8")) }));

  const wanted = new Set();
  let total = 0;
  let srcless = 0;
  for (const { deck } of decks) {
    for (const card of deck.cards || []) {
      for (const tag of (card.html || "").match(/<img\b[^>]*>/g) || []) {
        total += 1;
        const src = srcOf(tag);
        if (!src) srcless += 1;
        else if (needsDimensions(tag)) wanted.add(src);
      }
    }
  }

  console.log(
    `${total} image tag(s); ${srcless} with no src; ${wanted.size} distinct source(s) missing a size`,
  );
  if (!wanted.size && !srcless) {
    console.log("nothing to do");
    return;
  }
  if (wanted.size) console.log(`reading headers from ${GATED ? `gs://${BUCKET}` : HOST} ...`);

  const { results, failures } = wanted.size
    ? await resolveAll([...wanted])
    : { results: new Map(), failures: [] };

  let sized = 0;
  let removed = 0;
  const touched = [];
  for (const { file, deck } of decks) {
    let changed = 0;
    for (const card of deck.cards || []) {
      if (!card.html) continue;
      card.html = card.html.replace(/<img\b[^>]*>/g, (tag) => {
        const src = srcOf(tag);
        // No source, no image. `card.images` is built from `src="..."` matches upstream, so a tag
        // like this was never in it and dropping the markup leaves nothing dangling.
        if (!src) {
          changed += 1;
          removed += 1;
          return "";
        }
        if (!needsDimensions(tag)) return tag;
        const dimensions = results.get(src);
        if (!dimensions) return tag;
        changed += 1;
        sized += 1;
        return withDimensions(tag, dimensions);
      });
    }
    if (!changed) continue;
    touched.push(`${String(changed).padStart(3)}  ${file}`);
    if (APPLY) writeFileSync(join(CARDS_DIR, file), `${JSON.stringify(deck, null, 2)}\n`);
  }

  console.log(touched.join("\n"));
  console.log(
    `\n${sized} sized, ${removed} removed — ${APPLY ? "written" : "would be written"} across ` +
      `${touched.length} deck(s)`,
  );
  if (failures.length) {
    console.log(`\n${failures.length} source(s) could not be read:`);
    for (const failure of failures) console.log(`  ${failure}`);
  }
  if (!APPLY) console.log("\nre-run with --apply to write");
  // A deck whose images cannot be measured still ships; say so loudly rather than failing the run.
  process.exitCode = failures.length ? 2 : 0;
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
