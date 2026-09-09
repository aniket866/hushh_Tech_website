#!/usr/bin/env node
/**
 * Mirrors the images a Gamma deck references into the community content bucket.
 *
 * Two reasons, one of them a correctness bug.
 *
 * 1. The card exports point at whatever CDN Gamma happened to use — cdn.gamma.app, Pexels,
 *    Wikimedia, a newspaper's image host. Those URLs rot, and a deck whose images 404 in a year is
 *    not a published document. Mirroring makes the deck self-contained.
 *
 * 2. Access level. A deck behind the NDA gate whose images load from a public CDN is only gated
 *    for its text. Mirroring puts every image under the same prefix as the deck it belongs to, so
 *    isNdaAsset() in api/community/content-service.js governs the images too.
 *
 * The card JSON is rewritten in place to point at /api/community/assets/<prefix>/media/<hash>.<ext>,
 * so a re-run after a re-export re-mirrors only what changed. Content-addressed names mean an image
 * used on five cards is stored once.
 *
 * sharp is authoring-time only and deliberately not in package.json:
 *   npm install --no-save sharp
 *
 * Usage:
 *   node scripts/community/mirror-deck-images.mjs --bucket hushh-tech-community-content-uat
 *   node scripts/community/mirror-deck-images.mjs --deck general/the-simons-code --dry-run
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = join(root, "content/decks/manifest.json");
// Origin URL -> mirrored asset path. convert-gamma-export.mjs applies this when it rewrites the
// cards, so re-running the converter after a re-export does not silently restore CDN hotlinks —
// which is exactly what happened the first time these two scripts ran in the wrong order.
//
// Split by access level, and the gated half is gitignored. The public half has to be committed:
// content/decks/cards/*.json is committed too, so a fresh clone that re-converts without it would
// put CDN URLs back. The gated half must not be, because it names the origin CDN URL of every
// image in an NDA deck — those originals are publicly fetchable, so committing the map would hand
// out the deck's imagery to anyone reading the repository. Gated cards are gitignored as well, so
// nothing is lost: a clone regenerates both together.
const MEDIA_MAP = join(root, "content/decks/media-map.json");
const MEDIA_MAP_GATED = join(root, "content/decks/media-map-gated.json");

// Wide enough for a full-bleed card image on a 2x display without shipping the original, which is
// routinely 3000px and 2 MB.
const MAX_WIDTH = 1600;
const JPEG_QUALITY = 82;

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith("--")) continue;
  const key = process.argv[i].slice(2);
  const next = process.argv[i + 1];
  args[key] = !next || next.startsWith("--") ? true : (i += 1, next);
}

const BUCKET = typeof args.bucket === "string" ? args.bucket : "hushh-tech-community-content-uat";
const DRY_RUN = Boolean(args["dry-run"]);

/** The HTML attribute form of a URL, matching what the converter writes. */
const escapeAmp = (value) => value.replace(/&/g, "&amp;");

/**
 * Removes every `<img>` whose src is this URL, in either the decoded or the entity-escaped form
 * the converter may have written.
 */
const dropImage = (html, source) => {
  let output = html;
  for (const form of new Set([source, escapeAmp(source)])) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(`<img\\b[^>]*\\bsrc="${escaped}"[^>]*/?>`, "g"), "");
  }
  return output;
};

const prefixFor = (deck) =>
  deck.accessLevel === "NDA" ? `gated/decks/${deck.assetName}` : `decks/${deck.assetName}`;

const cardsPathFor = (deck) =>
  join(root, deck.accessLevel === "NDA" ? "content/decks/cards-gated" : "content/decks/cards", `${deck.assetName}.json`);

const storage = async () => {
  const encoded = process.env.GCP_DEPLOY_SA_KEY_B64;
  if (!encoded) throw new Error("GCP_DEPLOY_SA_KEY_B64 is not set");
  const credentials = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const { Storage } = await import("@google-cloud/storage");
  return new Storage({ credentials, projectId: credentials.project_id });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Some hosts refuse a bare fetch; a browser UA is enough for every host these decks use.
 *
 * Retries transient failures. Mirroring 165 images over an egress proxy reliably hits at least one
 * connection reset, and a single reset used to abort the whole run — losing every image mirrored
 * before it, because the map was only written at the end. A 4xx is not retried: it will not change.
 */
const download = async (url, attempts = 4) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; HushhTechDeckMirror/1.0)", Accept: "image/*,*/*" },
        redirect: "follow",
      });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      if (response.status >= 400 && response.status < 500) throw new Error(`HTTP ${response.status}`);
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (/^HTTP 4\d\d$/.test(error.message)) throw error;
      lastError = error;
    }
    await sleep(1000 * 2 ** attempt);
  }
  throw lastError;
};

const main = async () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const only = typeof args.deck === "string" ? args.deck : "";
  const decks = manifest.decks.filter((deck) => !only || deck.slug === only);

  const bucket = DRY_RUN ? null : (await storage()).bucket(BUCKET);
  const readMap = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
  const publicMap = readMap(MEDIA_MAP);
  const gatedMap = readMap(MEDIA_MAP_GATED);
  const uploaded = new Set();
  let mirrored = 0;
  let skipped = 0;
  const failures = [];

  // Uploads are content-addressed and idempotent, so the expensive part of a failed run is the
  // work already done. Persist the maps and the rewritten cards whatever happens.
  const persist = () => {
    if (DRY_RUN) return;
    writeFileSync(MEDIA_MAP, `${JSON.stringify(publicMap, null, 2)}\n`);
    writeFileSync(MEDIA_MAP_GATED, `${JSON.stringify(gatedMap, null, 2)}\n`);
  };
  process.on("exit", persist);

  for (const deck of decks) {
    const cardsPath = cardsPathFor(deck);
    let document;
    try { document = JSON.parse(readFileSync(cardsPath, "utf8")); } catch { continue; }

    const prefix = prefixFor(deck);
    const mediaMap = deck.accessLevel === "NDA" ? gatedMap : publicMap;
    let changed = false;

    for (const card of document.cards) {
      const rewritten = [];
      for (const source of card.images) {
        if (source.startsWith("/api/community/assets/")) { rewritten.push(source); continue; }

        let buffer;
        try { buffer = await download(source); }
        catch (error) {
          // Drop the image rather than leaving a hotlink to an origin we cannot even read. A
          // third-party editorial photo we fail to fetch is a broken image on the page and, for a
          // WSJ or Investopedia URL, a copyright exposure we should not be creating by reference
          // either. The failure is reported so a replacement can be chosen deliberately.
          card.html = dropImage(card.html, source);
          mediaMap[source] = null; // remembered as unmirrorable, so a re-convert drops it again
          failures.push(`${deck.slug}: dropped ${source} (${error.message})`);
          changed = true;
          continue;
        }

        let output = buffer;
        let extension = "jpg";
        try {
          const sharp = (await import("sharp")).default;
          const image = sharp(buffer);
          const { width, format, hasAlpha } = await image.metadata();
          // Keep PNG only where transparency is actually used — flattening a logo onto white is
          // worse than the extra bytes. Format alone is the wrong test: a photograph saved as PNG
          // comes out at 1.1 MB where the same image as JPEG is 180 KB.
          if (format === "svg" || hasAlpha) {
            output = await image.resize({ width: Math.min(width || MAX_WIDTH, MAX_WIDTH), withoutEnlargement: true }).png().toBuffer();
            extension = "png";
          } else {
            output = await image.resize({ width: Math.min(width || MAX_WIDTH, MAX_WIDTH), withoutEnlargement: true }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
          }
        } catch (error) {
          // An empty or unreadable body is not an image; storing it would publish a broken file.
          if (!buffer.length || /Input Buffer is empty|unsupported image format/i.test(error.message)) {
            card.html = dropImage(card.html, source);
            mediaMap[source] = null;
            failures.push(`${deck.slug}: dropped ${source} (${error.message})`);
            changed = true;
            continue;
          }
          failures.push(`${deck.slug}: could not re-encode ${source} (${error.message}); storing as fetched`);
        }

        const digest = createHash("sha256").update(output).digest("hex").slice(0, 16);
        const objectName = `${prefix}/media/${digest}.${extension}`;
        const target = `/api/community/assets/${objectName}`;

        if (!uploaded.has(objectName)) {
          if (DRY_RUN) {
            console.log(`  would upload ${objectName}  ${(output.length / 1024).toFixed(0)} KB  ← ${new URL(source).host}`);
          } else {
            await bucket.file(objectName).save(output, {
              resumable: false,
              contentType: extension === "png" ? "image/png" : "image/jpeg",
              // Cache-Control on the object is advisory here: the API sets the response header from
              // the prefix, so a gated object is served private, no-store regardless.
              metadata: { cacheControl: "public, max-age=31536000, immutable" },
            });
          }
          uploaded.add(objectName);
          mirrored += 1;
        } else {
          skipped += 1;
        }

        // card.images holds the decoded URL; card.html holds it with `&` escaped as `&amp;`.
        // Replacing only one form silently leaves every image in the rendered HTML pointing at the
        // origin CDN while the manifest claims it was mirrored.
        for (const form of new Set([source, escapeAmp(source)])) {
          card.html = card.html.split(form).join(target);
        }
        mediaMap[source] = target;
        rewritten.push(target);
        changed = true;
      }
      card.images = rewritten;
    }

    if (changed && !DRY_RUN) {
      writeFileSync(cardsPath, `${JSON.stringify(document, null, 2)}\n`);
      persist();
    }
    console.log(`  ${deck.slug.padEnd(48)} ${prefix}/media`);
  }

  console.log(`\nmirrored ${mirrored} image(s), ${skipped} already stored in this run`);
  if (failures.length) {
    console.log(`\n${failures.length} image(s) needed attention:`);
    for (const failure of failures) console.log(`  ${failure}`);
    process.exitCode = 1;
  }
};

main().catch((error) => { console.error(error); process.exit(1); });
