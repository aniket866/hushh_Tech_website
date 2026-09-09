#!/usr/bin/env node
/**
 * Stages Gamma exports for conversion.
 *
 * There is no Gamma API key in this environment — the Gamma tools are only reachable through the
 * MCP server, which an agent calls and a script cannot. A large `read_gamma` result is written to
 * a file rather than returned inline, so the workable pipeline is: call read_gamma per deck, then
 * point this at the directory those files landed in. It matches each file to a deck by the
 * `Title:` line the export carries and copies it in under the deck's gammaId.
 *
 * Staged exports are gitignored. Nine of the sixteen decks are NDA material.
 *
 * Usage:
 *   node scripts/community/ingest-gamma-export.mjs --from <dir>
 *   node scripts/community/ingest-gamma-export.mjs --from <dir> --report   # what is still missing
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = join(root, "content/decks/manifest.json");
const STAGE = join(root, "content/decks/gamma-export");

const fail = (message) => {
  console.error(`ingest-gamma-export: ${message}`);
  process.exit(1);
};

const arg = (name, fallback = "") => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")
    ? process.argv[index + 1]
    : fallback;
};

/** An export is either plain text or the MCP's JSON envelope; both carry the same body. */
const bodyOf = (raw) => {
  if (!raw.trimStart().startsWith("[") && !raw.trimStart().startsWith("{")) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((part) => part.text || "").join("");
    return typeof parsed.text === "string" ? parsed.text : raw;
  } catch {
    return raw;
  }
};

const titleOf = (body) => /^Title: (.+)$/m.exec(body)?.[1]?.trim() || "";

/**
 * Manifest titles are edited for the site and drift from the Gamma titles in every direction:
 * an emoji is dropped ("🤫 Technologies Corporation…"), a ticker is dropped ("NVIDIA (NVDA): The
 * Compute Substrate" -> "NVIDIA: The Compute Substrate"), a suffix is trimmed ("… Deep Dive"), a
 * subtitle after a colon is cut. Prefix matching handles the last two and nothing else, so this
 * scores on shared words instead and takes the best match above a threshold.
 */
const words = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);

/** Jaccard over the word sets: 1 is identical, 0 shares nothing. */
const similarity = (a, b) => {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / (left.size + right.size - shared);
};

const main = () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const from = arg("from");
  mkdirSync(STAGE, { recursive: true });

  const staged = new Map();
  for (const file of readdirSync(STAGE).filter((name) => name.endsWith(".html"))) {
    staged.set(file.replace(/\.html$/, ""), file);
  }

  // Explicit pairing for the cases title matching cannot resolve: the workspace holds several
  // distinct decks called "Hushh Renaissance", so similarity alone would either tie or miss.
  for (const token of process.argv.filter((value) => value.startsWith("--map="))) {
    const [gammaId, path] = token.slice("--map=".length).split("=");
    if (!gammaId || !path) fail(`--map expects <gammaId>=<file>, got "${token}"`);
    if (!manifest.decks.some((deck) => deck.gammaId === gammaId)) fail(`--map: no deck with gammaId ${gammaId}`);
    const body = bodyOf(readFileSync(path, "utf8"));
    if (!body.includes("<section")) fail(`--map: ${path} carries no Gamma sections`);
    writeFileSync(join(STAGE, `${gammaId}.html`), body);
    staged.set(gammaId, `${gammaId}.html`);
    console.log(`staged ${gammaId}  ${titleOf(body)}  (${(body.length / 1024).toFixed(0)} KB, explicit)`);
  }

  if (from) {
    const candidates = [];
    for (const file of readdirSync(from)) {
      const path = join(from, file);
      let body;
      try { body = bodyOf(readFileSync(path, "utf8")); } catch { continue; }
      const title = titleOf(body);
      if (!title || !body.includes("<section")) continue;
      candidates.push({ path, title, body });
    }

    for (const deck of manifest.decks) {
      // Already staged — by --map, or by an earlier run. Ranking it again can only produce a false
      // ambiguity warning, because the workspace holds several decks with the same title.
      if (staged.has(deck.gammaId)) continue;
      const ranked = candidates
        .map((entry) => ({ entry, score: similarity(entry.title, deck.title) }))
        .sort((a, b) => b.score - a.score);
      const best = ranked[0];
      // 0.5 keeps "NVIDIA (NVDA) — Fund A Alpha Bets 1024" apart from "NVIDIA (NVDA): The Compute
      // Substrate of Civilization", which share only the ticker.
      if (!best || best.score < 0.5) continue;
      if (ranked[1] && ranked[1].score === best.score) {
        console.error(`ambiguous: "${deck.title}" matches ${ranked[0].entry.title} and ${ranked[1].entry.title}`);
        process.exitCode = 1;
        continue;
      }
      const match = best.entry;
      // Keep the largest export when a deck was fetched more than once.
      const destination = join(STAGE, `${deck.gammaId}.html`);
      const existing = staged.has(deck.gammaId) ? readFileSync(destination, "utf8").length : 0;
      if (match.body.length <= existing) continue;
      writeFileSync(destination, match.body);
      staged.set(deck.gammaId, `${deck.gammaId}.html`);
      console.log(`staged ${deck.gammaId}  ${match.title}  (${(match.body.length / 1024).toFixed(0)} KB)`);
    }
  }

  const missing = manifest.decks.filter((deck) => !staged.has(deck.gammaId));
  console.log(`\nstaged ${manifest.decks.length - missing.length}/${manifest.decks.length} decks`);
  if (missing.length) {
    console.log("\nstill needed — call read_gamma for each id, then re-run with --from:");
    for (const deck of missing) console.log(`  ${deck.gammaId}   ${deck.title}`);
  }
};

main();
