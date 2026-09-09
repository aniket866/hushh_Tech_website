#!/usr/bin/env node
/**
 * Extracts a deck's text out of its Gamma PDF export into markdown.
 *
 * This is what makes a deck answer-engine visible. A deck rendered as page images — or worse, as
 * a gamma.app iframe — contributes zero indexable text, so a crawler that does not execute
 * JavaScript sees a title and nothing else. The markdown produced here is stored as the post's
 * bodyMarkdown and served by /api/community/posts, alongside the page images the browser renders.
 *
 * Text comes from the PDF rather than the Gamma read API on purpose: the PDF gives complete text
 * for a 100-card deck in one local pass, with no truncation.
 *
 * Usage:
 *   node scripts/community/extract-deck-text.mjs --deck general/the-medallion-blueprint \
 *     --pdf-url <gamma pdf export url>
 *
 *   --pdf <path>   use a local PDF instead of downloading
 *
 * pdf-parse is an authoring-time dependency, deliberately not in package.json:
 *   npm install --no-save pdf-parse
 */

import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = join(root, "content/decks/manifest.json");
// This repository is public. Public-deck text is committed so the API and crawlers can read it;
// NDA-deck text carries fund allocations, AUM and price targets and must never be committed, so
// it is written to a gitignored directory and uploaded to the gated GCS prefix instead.
const PUBLIC_OUT_DIR = join(root, "content/decks/text");
const GATED_OUT_DIR = join(root, "content/decks/text-gated");

const parseArgs = () => {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
};

const fail = (message) => {
  console.error(`extract-deck-text: ${message}`);
  process.exit(1);
};

/**
 * Gamma stamps a running header or footer band onto every card ("PERMANENT CAPITAL FOR QUALIFIED
 * INVESTORS ONLY HUSHH.AI" and the like). Repeated on 100 cards it swamps the real text, so drop
 * any line that shows up on most pages.
 */
const runningLines = (pages) => {
  const counts = new Map();
  for (const lines of pages) {
    for (const line of new Set(lines)) counts.set(line, (counts.get(line) || 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.5));
  return new Set(
    [...counts.entries()].filter(([, count]) => count >= threshold).map(([line]) => line),
  );
};

/**
 * PDF text arrives hard-wrapped at the card's render width, so every visual line looks like its
 * own paragraph. Rejoin continuation lines and only break where a sentence actually ended, or at
 * a bullet — otherwise the markdown reads as fragments and is useless as a citation source.
 */
const rewrap = (lines) => {
  const paragraphs = [];
  let current = "";
  const isBullet = (line) => /^([-•*\u2022]|\d+[.)])\s/.test(line);

  for (const line of lines) {
    if (isBullet(line)) {
      if (current) paragraphs.push(current);
      current = line;
      paragraphs.push(current);
      current = "";
      continue;
    }
    if (!current) {
      current = line;
    } else if (/[a-z]-$/.test(current)) {
      // A compound word split across the render width ("multi-" + "strategy"). Join without a
      // space but keep the hyphen — in these decks it is nearly always a real compound, and an
      // em dash at a line end is punctuation, not a break, so it is left to the space branch.
      current += line;
    } else {
      current = `${current} ${line}`;
    }
    if (/[.!?:;]$/.test(line)) {
      paragraphs.push(current);
      current = "";
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs.join("\n\n");
};

/**
 * Gamma renders one card per PDF page, and a card's first line is its heading. Promoting that
 * line to an H2 gives the markdown the same section structure a reader sees in the deck, which is
 * what makes it useful to an answer engine rather than a wall of text.
 */
const toMarkdown = (title, pageTexts) => {
  const pages = pageTexts
    .map((text) =>
      String(text || "")
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    )
    .filter((lines) => lines.length);

  const boilerplate = runningLines(pages);
  const sections = [];
  let lastHeading = "";

  for (const rawLines of pages) {
    const lines = rawLines
      .filter((line) => !boilerplate.has(line))
      // The title card carries the same compliance band as a one-off variant the frequency test
      // cannot catch, so drop a long all-caps banner wherever it appears.
      .filter((line) => !(line.length > 20 && line === line.toUpperCase() && /[A-Z]{4}/.test(line)));
    if (!lines.length) continue;
    const [heading, ...body] = lines;
    // A chapter divider repeats across several cards; collapse the repeats.
    if (heading && heading !== lastHeading) {
      sections.push(`## ${heading}`);
      lastHeading = heading;
    }
    if (body.length) sections.push(rewrap(body));
  }

  return `# ${title}\n\n${sections.join("\n\n")}\n`;
};

const download = async (url, destination) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
};

const main = async () => {
  const args = parseArgs();
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const deck = manifest.decks.find((entry) => entry.slug === args.deck);
  if (!deck) fail(`no deck with slug "${args.deck}" in content/decks/manifest.json`);

  let PDFParse;
  try {
    ({ PDFParse } = require("pdf-parse"));
  } catch {
    fail("pdf-parse is required — run: npm install --no-save pdf-parse");
  }

  const workDir = await mkdtemp(join(tmpdir(), "deck-text-"));
  try {
    let pdfPath = args.pdf;
    if (!pdfPath) {
      if (!args["pdf-url"]) fail("pass --pdf-url or --pdf");
      pdfPath = join(workDir, "deck.pdf");
      await download(args["pdf-url"], pdfPath);
    }

    const parser = new PDFParse({ data: new Uint8Array(await readFile(pdfPath)) });
    const parsed = await parser.getText();
    await parser.destroy();
    const markdown = toMarkdown(deck.title, (parsed.pages || []).map((page) => page.text));
    if (markdown.trim().length < 200) {
      fail(`extracted text looks empty for ${deck.slug} — check the PDF export`);
    }

    const outDir = deck.accessLevel === "NDA" ? GATED_OUT_DIR : PUBLIC_OUT_DIR;
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, `${deck.assetName}.md`);
    await writeFile(outPath, markdown);
    console.log(
      `${deck.slug}: ${parsed.total} pages -> ${markdown.length.toLocaleString()} chars ` +
        `(${deck.accessLevel === "NDA" ? "content/decks/text-gated" : "content/decks/text"}/${deck.assetName}.md)`,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

main().catch((error) => fail(error.message));
