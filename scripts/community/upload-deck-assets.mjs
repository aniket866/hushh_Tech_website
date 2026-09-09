#!/usr/bin/env node
/**
 * Publishes one curated Gamma deck into the community content bucket.
 *
 * Gamma exports a ZIP of full-resolution PNGs — a 105-card deck lands at ~69 MB, with single
 * cards over 2 MB. Serving that verbatim would make a deck page unusable, so pages are
 * downscaled and re-encoded as JPEG to match the layout general/sell-the-wall-featured already
 * uses and that GammaEmbed reads.
 *
 * Access level decides the GCS prefix, and getting it wrong publishes fund material:
 * isNdaAsset() in api/community/content-service.js gates on ^(gated|nda|private|sensitive)/ and
 * serves those `private, no-store`, while plain decks/ is public and cacheable for an hour.
 *
 * Usage:
 *   node scripts/community/upload-deck-assets.mjs \
 *     --deck general/the-simons-code \
 *     --png-url <gamma png export zip url> \
 *     --pdf-url <gamma pdf export url> \
 *     --bucket hushh-tech-community-content-uat
 *
 *   --dry-run    do everything except the upload, and print what would be written
 *   --titles     print the card titles from the archive and exit (cheap content review)
 *
 * Credentials come from GCP_DEPLOY_SA_KEY_B64 (base64 service-account JSON).
 *
 * sharp is an authoring-time dependency and is deliberately NOT in package.json — CI never runs
 * this script, and a native binary on every install is not worth it. Install it when you need it:
 *   npm install --no-save sharp
 */

import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = join(root, "content/decks/manifest.json");

// Wide enough to stay sharp on a 2x desktop deck view without shipping print-resolution pages.
const MAX_PAGE_WIDTH = 1600;
const JPEG_QUALITY = 82;

const parseArgs = () => {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
};

const fail = (message) => {
  console.error(`upload-deck-assets: ${message}`);
  process.exit(1);
};

const loadManifest = async () => JSON.parse(await readFile(MANIFEST_PATH, "utf8"));

/** Public decks are cacheable; NDA decks must sit behind a prefix isNdaAsset() recognises. */
export const assetPrefixFor = (deck) =>
  deck.accessLevel === "NDA" ? `gated/decks/${deck.assetName}` : `decks/${deck.assetName}`;

const download = async (url, destination) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  return (await stat(destination)).size;
};

/**
 * Gamma names archive entries "<n>_<Card Title>.png". The numeric prefix is the card order and
 * must drive sorting — lexicographic order puts card 10 before card 2.
 */
const readPages = async (directory) => {
  const entries = await readdir(directory);
  return entries
    .filter((name) => name.toLowerCase().endsWith(".png"))
    .map((name) => {
      const match = /^(\d+)_(.*)\.png$/i.exec(name);
      return {
        file: join(directory, name),
        index: match ? Number(match[1]) : Number.MAX_SAFE_INTEGER,
        title: match ? match[2].replace(/-/g, " ").trim() : basename(name, ".png"),
      };
    })
    .sort((a, b) => a.index - b.index);
};

const gcsClient = async () => {
  const encoded = process.env.GCP_DEPLOY_SA_KEY_B64;
  if (!encoded) fail("GCP_DEPLOY_SA_KEY_B64 is not set");
  const credentials = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const { Storage } = await import("@google-cloud/storage");
  return new Storage({ credentials, projectId: credentials.project_id });
};

const main = async () => {
  const args = parseArgs();
  const manifest = await loadManifest();
  const deck = manifest.decks.find((entry) => entry.slug === args.deck);
  if (!deck) fail(`no deck with slug "${args.deck}" in content/decks/manifest.json`);

  // The extracted deck text ships to GCS alongside the pages. For an NDA deck this is the only
  // copy — the repository is public, so that text is never committed.
  const textPath = join(
    root,
    deck.accessLevel === "NDA" ? "content/decks/text-gated" : "content/decks/text",
    `${deck.assetName}.md`,
  );

  if (args["markdown-only"]) {
    if (!args.bucket) fail("--bucket is required");
    const storage = await gcsClient();
    const remote = `${assetPrefixFor(deck)}/index.md`;
    await storage.bucket(args.bucket).upload(textPath, {
      destination: remote,
      contentType: "text/markdown; charset=utf-8",
      metadata: {
        cacheControl: deck.accessLevel === "NDA" ? "private, no-store" : "public, max-age=3600",
      },
    });
    console.log(`uploaded ${remote}`);
    return;
  }

  const workDir = await mkdtemp(join(tmpdir(), "deck-"));
  const pagesDir = join(workDir, "pages");
  const outDir = join(workDir, "out");
  await mkdir(pagesDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  try {
    if (!args["png-url"]) fail("--png-url is required");
    const zipPath = join(workDir, "pages.zip");
    const zipBytes = await download(args["png-url"], zipPath);
    console.log(`downloaded page archive: ${(zipBytes / 1e6).toFixed(1)} MB`);
    execFileSync("unzip", ["-q", "-o", zipPath, "-d", pagesDir]);

    const pages = await readPages(pagesDir);
    if (!pages.length) fail("the archive contained no PNG pages");

    if (args.titles) {
      // Card titles are a cheap way to review what a deck actually claims before publishing it.
      console.log(`\n${deck.title} — ${pages.length} cards\n`);
      for (const page of pages) console.log(`  ${String(page.index).padStart(3, " ")}  ${page.title}`);
      return;
    }

    const { default: sharp } = await import("sharp").catch(() => {
      fail("sharp is required for page conversion — run: npm install --no-save sharp");
      return {};
    });

    let converted = 0;
    for (const page of pages) {
      const name = `page-${String(page.index).padStart(3, "0")}.jpg`;
      await sharp(page.file)
        .resize({ width: MAX_PAGE_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY, progressive: true })
        .toFile(join(outDir, name));
      converted += 1;
    }
    console.log(`converted ${converted} pages to JPEG (max ${MAX_PAGE_WIDTH}px, q${JPEG_QUALITY})`);

    let pdfPath = "";
    if (args["pdf-url"]) {
      pdfPath = join(workDir, "deck.pdf");
      const pdfBytes = await download(args["pdf-url"], pdfPath);
      console.log(`downloaded pdf: ${(pdfBytes / 1e6).toFixed(1)} MB`);
    }

    const prefix = assetPrefixFor(deck);
    const uploads = [
      ...(await readdir(outDir)).map((name) => ({
        local: join(outDir, name),
        remote: `${prefix}/pages/${name}`,
        contentType: "image/jpeg",
      })),
      ...(pdfPath ? [{ local: pdfPath, remote: `${prefix}/deck.pdf`, contentType: "application/pdf" }] : []),
    ];

    if (!args.bucket) fail("--bucket is required");
    console.log(`\n${deck.accessLevel} deck -> gs://${args.bucket}/${prefix}/ (${uploads.length} objects)`);

    if (args["dry-run"]) {
      for (const upload of uploads.slice(0, 3)) console.log(`  would write ${upload.remote}`);
      if (uploads.length > 3) console.log(`  ... and ${uploads.length - 3} more`);
      return;
    }

    const storage = await gcsClient();
    const bucket = storage.bucket(args.bucket);
    for (const upload of uploads) {
      // A deck is 60+ objects in a row and a single ECONNRESET part-way through would otherwise
      // leave the deck half-published, which renders as missing pages rather than an error.
      let lastError;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          await bucket.upload(upload.local, {
            destination: upload.remote,
            contentType: upload.contentType,
            // Public deck pages are served with Cache-Control by the API route; NDA pages are
            // forced to `private, no-store` there regardless of what is stored here.
            metadata: {
              cacheControl: deck.accessLevel === "NDA" ? "private, no-store" : "public, max-age=3600",
            },
          });
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 4) await new Promise((done) => setTimeout(done, 2 ** attempt * 1000));
        }
      }
      if (lastError) throw new Error(`${upload.remote}: ${lastError.message}`);
    }
    console.log(`uploaded ${uploads.length} objects`);

    // Record the real page count so the generated wrapper renders every card.
    deck.pageCount = pages.length;
    deck.cardTitles = pages.slice(0, 1).map((page) => page.title);
    await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`manifest updated: pageCount=${pages.length}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

main().catch((error) => fail(error.message));
